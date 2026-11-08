import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BobMessage } from "../src/control-center/bob-store.js";
import { api, projectNamed, seedDevEnvironment, signIn, stopDevNode, waitForDevNode, type DevEnvironment, type SeededNode } from "./dev-nodes.js";
import { serverArgs } from "./server-entry.js";

/**
 * A stand-in decision model. A stopped conversation always waits for the person; a message about a workspace is about organizing,
 * one that starts with "fix" is a task, anything else a question. An open item is settled only when the log since says "never mind".
 */
async function decisionModel(): Promise<{ server: Server; url: string; relevance: string[] }> {
  const relevance: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { state: string; questions: Record<string, { criteria: Record<string, string> }> };
      const said = (JSON.parse(parsed.state) as { user_message?: string }).user_message ?? "";
      const choose = (choice: string) => ({ type: "choice", choice, confidence: 0.97 });
      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(parsed.questions)) {
        if (id === "verdict") answers[id] = choose("needs_user");
        else if (id === "relevance") { relevance.push(parsed.state); answers[id] = choose(parsed.state.includes("never mind") ? "settled" : "still_needed"); }
        else if (id === "kind") answers[id] = choose(said.includes("workspace") ? "organize" : said.startsWith("fix ") ? "task" : "question");
        else if (id === "size") answers[id] = choose("long");
        else if (id === "project") answers[id] = choose(Object.entries(question.criteria).find(([key, text]) => key !== "none" && said.includes(text.split(".")[0]))?.[0] ?? "none");
        else answers[id] = choose("no" in question.criteria ? "no" : "none" in question.criteria ? "none" : Object.keys(question.criteria)[0]);
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ answers }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/systemone`, relevance };
}

async function startNode(environment: DevEnvironment, node: SeededNode, root: string, endpoint: string): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env, PORT: String(node.port), NODE_ENV: "test", HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir, JOINT_BOB_SESSION_COOKIE: node.cookieName,
    JOINT_BOB_INSECURE_COOKIE: "1", JOINT_BOB_RELEASE: "development", JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log"), JOINT_BOB_TEST_ENGINE_DETAIL_LOG: path.join(root, "prompts.log"), JOINT_BOB_TEST_AUTOMATION_DIR: path.join(root, "stubs"),
    JOINT_BOB_TEST_REVIEW_CHECK_MS: "300", JOINT_BOB_TEST_RECHECK_MODEL_AFTER_MS: "0", JOINT_BOB_TYPESAFE_ENDPOINT: endpoint,
  };
  delete env.TYPESAFE_AI_API_KEY;
  const child = spawn(process.execPath, serverArgs(env, ["./test/stub-harness-bootstrap.ts", "./test/stub-automation-bootstrap.ts"]), { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  return waitForDevNode(child, node.key, node.url);
}

async function eventually<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Never happened: ${label}`);
}

interface Listed { title: string; path: string; updatedAt?: string; doneAt?: string }

test("Bob clears what no longer waits for the person: a pressed item, a reply, Done and Dismiss, one about a conversation they looked at, and one the log settles", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-recheck-"));
  const classifier = await decisionModel();
  let child: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    await mkdir(path.join(root, "stubs"), { recursive: true });
    child = await startNode(environment, node, root, classifier.url);
    const auth = await signIn(environment, node);
    const project = projectNamed(node, "Joint Bob");
    const account = await api<{ account: { id: string } }>(node, auth, "POST", "/secrets/accounts", { label: "decision", provider: "custom", variables: [{ name: "TYPESAFE_AI_API_KEY", kind: "value", value: "test-key" }] });
    assert.equal((await api(node, auth, "PUT", `/secrets/scopes/project/${project.id}`, { accountIds: [account.body.account.id] })).status, 200);
    const timeline = async (query = "") => (await api<{ messages: BobMessage[] }>(node, auth, "GET", `/control-center/bob/messages${query}`)).body.messages;
    const sessions = async () => (await api<{ sessions: Listed[] }>(node, auth, "GET", `/projects/${project.id}/sessions`)).body.sessions;
    const itemAbout = (title: string) => eventually(async () => (await timeline()).find((message) => message.text.startsWith(`"${title}" waits for you`) && message.actions.length), `Bob brought "${title}" to the person`);
    const start = async (text: string) => assert.equal((await api<{ action: string }>(node, auth, "POST", "/control-center/bob/message", { message: text })).body.action, "started");
    const prompts = async () => (await readFile(path.join(root, "prompts.log"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { prompt: string }).prompt);

    // Pressed: Done closes the conversation and clears the item, and nothing new is written: the item leaving says it.
    await start("fix the mobile menu in Joint Bob");
    const menu = await itemAbout("fix the mobile menu in Joint Bob");
    const pressed = await api<{ messages: BobMessage[]; pressed: BobMessage }>(node, auth, "POST", "/control-center/bob/action", { messageId: menu.id, actionId: "conversation.done" });
    assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
    assert.deepEqual(pressed.body.messages, []);
    assert.deepEqual([pressed.body.pressed.resolution, pressed.body.pressed.actions], ["You chose “Done”.", []]);
    assert.ok((await sessions()).find((entry) => entry.title === "fix the mobile menu in Joint Bob")?.doneAt, "the conversation is marked done");

    // Looked at: reviewing the conversation in its project clears Bob's item about it, and the badge stops counting it.
    await start("fix the login page in Joint Bob");
    const login = await itemAbout("fix the login page in Joint Bob");
    assert.ok((await api<{ waiting: number }>(node, auth, "GET", "/control-center/summary")).body.waiting >= 1);
    const listed = (await sessions()).find((entry) => entry.title === "fix the login page in Joint Bob")!;
    const reviewed = await fetch(`${node.url}/api/projects/${project.id}/sessions/reviewed`, {
      method: "PUT", headers: { Cookie: auth.cookie, "x-csrf-token": auth.csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ sessionPath: listed.path, updatedAt: listed.updatedAt }),
    });
    assert.equal(reviewed.status, 204);
    const looked = await eventually(async () => (await timeline()).find((message) => message.id === login.id && message.resolvedAt), "the item about the reviewed conversation was cleared");
    assert.deepEqual([looked.resolution, looked.actions], ["You looked at it.", []]);
    assert.equal((await api<{ waiting: number }>(node, auth, "GET", "/control-center/summary")).body.waiting, 0);

    // Answered in place: a quick reply goes into the conversation as the person, and clears the item.
    await start("fix the search page in Joint Bob");
    const search = await itemAbout("fix the search page in Joint Bob");
    const replied = await api<{ pressed: BobMessage }>(node, auth, "POST", "/control-center/bob/reply", { messageId: search.id, text: "use the admin console" });
    assert.equal(replied.status, 200, JSON.stringify(replied.body));
    assert.deepEqual([replied.body.pressed.resolution, replied.body.pressed.actions], ["You replied: use the admin console", []]);
    await eventually(async () => (await prompts()).includes("use the admin console") ? true : undefined, "the reply reached the conversation");

    // Dismiss only clears a message; Done, on any message about a conversation, also closes the conversation.
    const again = await eventually(async () => (await timeline()).find((message) => message.text.startsWith('"fix the search page in Joint Bob" waits for you') && message.id !== search.id && !message.resolvedAt), "the answered conversation stopped for the person again");
    const dismissed = await api<{ pressed: BobMessage }>(node, auth, "POST", "/control-center/bob/item", { messageId: again.id, how: "dismiss" });
    assert.equal(dismissed.body.pressed.resolution, "You dismissed it.");
    assert.equal((await sessions()).find((entry) => entry.title === "fix the search page in Joint Bob")?.doneAt, undefined, "dismissing leaves the conversation open");
    await start("fix the footer in Joint Bob");
    const footer = await itemAbout("fix the footer in Joint Bob");
    const closed = await api<{ pressed: BobMessage }>(node, auth, "POST", "/control-center/bob/item", { messageId: footer.id, how: "done" });
    assert.equal(closed.body.pressed.resolution, "You marked it done.");
    assert.ok((await sessions()).find((entry) => entry.title === "fix the footer in Joint Bob")?.doneAt, "the conversation is marked done");
    assert.equal((await api(node, auth, "POST", "/control-center/bob/item", { messageId: footer.id, how: "dismiss" })).status, 404, "a cleared message cannot be settled again");

    // Settled by the log: a question with no conversation stays while nothing settles it, and goes when the person says to drop it.
    await writeFile(path.join(root, "stubs", "organize.json"), JSON.stringify({ intent: "create-workspace", name: "Clients" }));
    const ask = (await api<{ reply: BobMessage }>(node, auth, "POST", "/control-center/bob/message", { message: "create a workspace called Clients" })).body.reply;
    assert.match(ask.text, /Create the workspace "Clients"\?/);
    await eventually(async () => classifier.relevance.some((state) => state.includes("Create the workspace")) ? true : undefined, "the decision model judged the question");
    assert.equal((await timeline()).find((message) => message.id === ask.id)?.resolvedAt, null, "nothing settles it yet");
    // Bob's agent answers with the stubbed Claude, which needs no model set up.
    assert.equal((await api(node, auth, "PUT", "/control-center/bob/settings", { harnessId: "claude" })).status, 200);
    const dropped = await api<{ action: string }>(node, auth, "POST", "/control-center/bob/message", { message: "never mind, forget about that one" });
    assert.equal(dropped.body.action, "answer", JSON.stringify(dropped.body));
    const settled = await eventually(async () => (await timeline()).find((message) => message.id === ask.id && message.resolvedAt), "the log settled the question");
    assert.equal(settled.resolution, "Bob's decision model found it settled by what happened since (97%).");
    const judged = JSON.parse(classifier.relevance.findLast((state) => state.includes("never mind"))!) as { item: { buttons: string[] }; log: Array<{ from: string; text: string }> };
    assert.deepEqual(judged.item.buttons, ["Create it", "Cancel"]);
    assert.ok(judged.log.some((entry) => entry.from === "user" && entry.text === "never mind, forget about that one"));

    // Every cleared item is listed in the cleared view, with why.
    assert.deepEqual((await timeline("?cleared=1")).map((message) => message.id), [menu.id, login.id, search.id, again.id, footer.id, ask.id]);
  } finally {
    if (child) await stopDevNode(child);
    classifier.server.close();
    await rm(root, { recursive: true, force: true });
  }
});
