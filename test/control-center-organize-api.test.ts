import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BobMessage } from "../src/control-center/bob-store.js";
import { api, seedDevEnvironment, signIn, stopDevNode, waitForDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { serverArgs } from "./server-entry.js";

/** A real node with Bob's agent stood in: what it "answers" for a message is the organize.json the test writes. */
async function startNode(environment: DevEnvironment, node: SeededNode, directory: string): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env, PORT: String(node.port), NODE_ENV: "test", HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir, JOINT_BOB_SESSION_COOKIE: node.cookieName,
    JOINT_BOB_INSECURE_COOKIE: "1", JOINT_BOB_RELEASE: "development", JOINT_BOB_TEST_ENGINE_LOG: path.join(directory, "engine.log"), JOINT_BOB_TEST_AUTOMATION_DIR: directory,
  };
  delete env.TYPESAFE_AI_API_KEY;
  const child = spawn(process.execPath, serverArgs(env, ["./test/stub-harness-bootstrap.ts", "./test/stub-automation-bootstrap.ts"]), { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  return waitForDevNode(child, node.key, node.url);
}

async function say(node: SeededNode, auth: SignedIn, directory: string, text: string, intent: unknown): Promise<BobMessage> {
  await writeFile(path.join(directory, "organize.json"), JSON.stringify(intent));
  const reply = await api<{ reply: BobMessage }>(node, auth, "POST", "/control-center/bob/message", { message: text });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  return reply.body.reply;
}

async function press(node: SeededNode, auth: SignedIn, message: BobMessage, actionId = "organize.run"): Promise<BobMessage> {
  const pressed = await api<{ messages: BobMessage[] }>(node, auth, "POST", "/control-center/bob/action", { messageId: message.id, actionId });
  assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
  return pressed.body.messages[0];
}

interface Workspace { id: string; label: string }
interface Project { id: string; name: string; path: string; type: string }

test("Bob creates, renames, moves and removes workspaces and projects, each only after the person presses the button", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "control-organize-"));
  let child: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const directory = path.join(root, "stubs");
    await mkdir(directory, { recursive: true });
    child = await startNode(environment, node, directory);
    const auth = await signIn(environment, node);
    const workspaces = async () => (await api<{ workspaces: Workspace[] }>(node, auth, "GET", "/workspaces")).body.workspaces;
    const projects = async () => (await api<{ projects: Project[] }>(node, auth, "GET", "/projects?syncStatus=false")).body.projects;
    const before = await workspaces();

    // A workspace: the message asks, the button makes it.
    const askWorkspace = await say(node, auth, directory, "create a workspace called Clients", { intent: "create-workspace", name: "Clients" });
    assert.equal(askWorkspace.importance, "needs-you");
    assert.match(askWorkspace.text, /Create the workspace "Clients"\?/);
    assert.deepEqual(askWorkspace.actions.map((action) => [action.id, action.style ?? null]), [["organize.run", "primary"], ["organize.cancel", null]]);
    assert.equal((await workspaces()).length, before.length, "nothing is made before the button");
    assert.match((await press(node, auth, askWorkspace)).text, /Created the workspace "Clients"/);
    const clients = (await workspaces()).find((workspace) => workspace.label === "Clients")!;
    assert.ok(clients, "the workspace is there");
    assert.match((await say(node, auth, directory, "create a workspace called clients", { intent: "create-workspace", name: "clients" })).text, /already have a workspace/);

    // A project in it, with its folder in the projects home.
    const askProject = await say(node, auth, directory, "create a project called Billing in Clients", { intent: "create-project", name: "Billing", workspaceId: clients.id });
    assert.match(askProject.text, /Create the project "Billing" in the workspace "Clients"/);
    await press(node, auth, askProject);
    const billing = (await projects()).find((project) => project.name === "Billing")!;
    assert.equal(billing.type, clients.id);
    assert.ok((await stat(billing.path)).isDirectory(), "the project's folder exists");

    // Rename and move it; an empty-workspace check stops a workspace that still holds it from being deleted.
    await press(node, auth, await say(node, auth, directory, "rename the Billing project to Invoices", { intent: "rename-project", projectId: billing.id, name: "Invoices" }));
    assert.equal((await projects()).find((project) => project.id === billing.id)?.name, "Invoices");
    const refused = await say(node, auth, directory, "delete the Clients workspace", { intent: "delete-workspace", workspaceId: clients.id });
    assert.match(refused.text, /still holds "Invoices"/);
    assert.deepEqual(refused.actions, []);
    const home = before[0];
    await press(node, auth, await say(node, auth, directory, `move the Invoices project to ${home.label}`, { intent: "move-project", projectId: billing.id, workspaceId: home.id }));
    const moved = (await projects()).find((project) => project.id === billing.id)!;
    assert.equal(moved.type, home.id);

    // Cancelling changes nothing; removing waits for a warning button and leaves the folder on disk.
    const keep = await say(node, auth, directory, "delete the Invoices project", { intent: "delete-project", projectId: billing.id });
    assert.match((await press(node, auth, keep, "organize.cancel")).text, /nothing was changed/);
    assert.ok((await projects()).some((project) => project.id === billing.id));
    const remove = await say(node, auth, directory, "delete the Invoices project", { intent: "delete-project", projectId: billing.id });
    assert.equal(remove.actions[0].style, "warn");
    assert.match((await press(node, auth, remove)).text, /Removed the project "Invoices" from Joint Bob/);
    assert.equal((await projects()).some((project) => project.id === billing.id), false);
    assert.ok((await stat(moved.path)).isDirectory(), "its folder stays");
    await press(node, auth, await say(node, auth, directory, "delete the Clients workspace", { intent: "delete-workspace", workspaceId: clients.id }));
    assert.equal((await workspaces()).some((workspace) => workspace.id === clients.id), false);

    // Whatever the agent says is checked: an id that is not the person's changes nothing.
    const invented = await say(node, auth, directory, "rename the payments project", { intent: "rename-project", projectId: "made-up", name: "x" });
    assert.match(invented.text, /could not find/);
    assert.deepEqual(invented.actions, []);
  } finally {
    if (child) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});

async function eventually<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Never happened: ${label}`);
}

test("Bob starts a conversation, asks it something and brings back its answer, then deletes it, each after the button", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "control-organize-conversations-"));
  let child: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const [project] = node.projects;
    const directory = path.join(root, "stubs");
    await mkdir(directory, { recursive: true });
    child = await startNode(environment, node, directory);
    const auth = await signIn(environment, node);
    const sessionsOf = async () => (await api<{ sessions: Array<{ id: string; title: string }> }>(node, auth, "GET", `/projects/${project.id}/sessions`)).body.sessions;
    const messages = async () => (await api<{ messages: BobMessage[] }>(node, auth, "GET", "/control-center/bob/messages")).body.messages;

    await press(node, auth, await say(node, auth, directory, `start a conversation in ${project.name} to check the menu`, { intent: "start-conversation", projectId: project.id, message: "check the menu" }));
    const started = await eventually(async () => (await sessionsOf()).find((session) => session.title === "check the menu"), "the conversation was started");

    // Asking a conversation, even an idle one off the board, waits for the button; its answer comes back to Bob's chat.
    const ask = await say(node, auth, directory, "ask the check the menu conversation how to review it", { intent: "message-conversation", conversation: "conversation-titled:check the menu", message: "how do I review this?" });
    assert.match(ask.text, /^Send this to "check the menu" in .+\? I'll bring you its answer here\.\nhow do I review this\?$/);
    assert.deepEqual(ask.actions.map((action) => action.label), ["Send it", "Cancel"]);
    assert.match((await press(node, auth, ask)).text, /^Sent to "check the menu"\. I'll bring you its answer here when it is done\.$/);
    const answered = await eventually(async () => (await messages()).find((message) => message.text.startsWith('"check the menu" answered:')), "the answer came back to Bob's chat");
    assert.match(answered.text, /stubbed response/);
    assert.equal(answered.importance, "report");
    assert.deepEqual(answered.actions.map((action) => action.id), ["open"]);

    // Deleting it is a warning button, and it is gone from the project afterwards.
    const remove = await say(node, auth, directory, "delete the check the menu conversation", { intent: "delete-conversation", conversation: "conversation-titled:check the menu" });
    assert.match(remove.text, /Delete the conversation "check the menu" in .+\? Its whole history goes/);
    assert.equal(remove.actions[0].style, "warn");
    assert.match((await press(node, auth, remove)).text, /Deleted the conversation "check the menu"/);
    assert.equal((await sessionsOf()).some((session) => session.id === started.id), false);
  } finally {
    if (child) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});
