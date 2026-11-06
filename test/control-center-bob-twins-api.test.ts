import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AutomationRow } from "../src/control-center/automations.js";
import type { BobMessage } from "../src/control-center/bob-store.js";
import { api, pairTwinNodes, seedDevEnvironment, signIn, stopDevNode, waitForDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { serverArgs } from "./server-entry.js";

/** A node with Bob's agent stood in: what it "answers" for an automation request is the intent.json in its own directory. */
async function startNode(environment: DevEnvironment, node: SeededNode, directory: string): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env, PORT: String(node.port), NODE_ENV: "test", HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir, JOINT_BOB_SESSION_COOKIE: node.cookieName,
    JOINT_BOB_INSECURE_COOKIE: "1", JOINT_BOB_RELEASE: "development", JOINT_BOB_TEST_ENGINE_LOG: path.join(directory, "engine.log"), JOINT_BOB_TEST_AUTOMATION_DIR: directory,
  };
  delete env.TYPESAFE_AI_API_KEY;
  const child = spawn(process.execPath, serverArgs(env, ["./test/stub-harness-bootstrap.ts", "./test/stub-automation-bootstrap.ts"]), { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  return waitForDevNode(child, node.key, node.url);
}

async function eventually<T>(read: () => Promise<T | undefined | false>, label: string, seconds = 60): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Never happened: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const timeline = async (node: SeededNode, auth: SignedIn) => (await api<{ messages: BobMessage[] }>(node, auth, "GET", "/control-center/bob/messages")).body.messages;

test("the chat with Bob follows the person to their other machine, and a button pressed there runs on the machine that wrote it", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "control-bob-twins-"));
  const children: ChildProcess[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const [mac, server] = environment.nodes;
    const dirs = [path.join(root, "mac"), path.join(root, "server")];
    for (const dir of dirs) await mkdir(dir, { recursive: true });
    children.push(await startNode(environment, mac, dirs[0]), await startNode(environment, server, dirs[1]));
    await pairTwinNodes(environment);
    const [onMac, onServer] = await Promise.all([signIn(environment, mac), signIn(environment, server)]);

    // On the Mac, Bob asks before creating a report.
    await writeFile(path.join(dirs[0], "intent.json"), JSON.stringify({ intent: "create", create: { kind: "report", report: "evening" } }));
    const asked = await api<{ reply: BobMessage }>(mac, onMac, "POST", "/control-center/bob/message", { message: "also send me an evening report" });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const ask = asked.body.reply;
    assert.deepEqual(ask.actions.map((action) => action.id), ["automations.create", "automations.cancel"]);

    // The server has the same chat, the question and its buttons, for the same person.
    const copy = await eventually(async () => (await timeline(server, onServer)).find((message) => message.id === ask.id), "the Mac's message reached the server");
    assert.deepEqual(copy.actions.map((action) => action.id), ["automations.create", "automations.cancel"]);
    await eventually(async () => (await timeline(server, onServer)).some((message) => message.role === "user" && message.text === "also send me an evening report"), "what the person said came along");

    // Pressed on the server, it runs on the Mac, where the report then lives; the answer is shown at once.
    const pressed = await api<{ messages: BobMessage[] }>(server, onServer, "POST", "/control-center/bob/action", { messageId: ask.id, actionId: "automations.create" });
    assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
    assert.match(pressed.body.messages[0].text, /^Created "Evening report"/);
    const macRows = (await api<{ rows: AutomationRow[] }>(mac, onMac, "GET", "/control-center/automations")).body.rows;
    assert.ok(macRows.some((row) => row.kind === "bob" && row.name === "Evening report" && row.nodeId === mac.nodeId), "the report was made on the Mac");
    assert.deepEqual((await timeline(server, onServer)).find((message) => message.id === ask.id)?.actions, [], "the buttons are gone on the server");
    await eventually(async () => (await timeline(mac, onMac)).find((message) => message.id === ask.id)?.actions.length === 0, "the buttons are gone on the Mac");
    assert.equal((await api(server, onServer, "POST", "/control-center/bob/action", { messageId: ask.id, actionId: "automations.create" })).status, 404, "a button runs once");

    // The person goes on talking to Bob on the server; the Mac's chat has that too.
    await writeFile(path.join(dirs[1], "intent.json"), JSON.stringify({ intent: "list" }));
    const listed = await api<{ reply: BobMessage }>(server, onServer, "POST", "/control-center/bob/message", { message: "what scheduled tasks do I have?" });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    await eventually(async () => (await timeline(mac, onMac)).some((message) => message.id === listed.body.reply.id), "the server's answer reached the Mac");
    const order = (await timeline(mac, onMac)).map((message) => message.text);
    assert.ok(order.indexOf("also send me an evening report") < order.indexOf("what scheduled tasks do I have?"), "one chat, in the order it was said");
  } finally {
    for (const child of children) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});
