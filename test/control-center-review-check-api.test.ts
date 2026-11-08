import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BobMessage } from "../src/control-center/bob-store.js";
import { api, projectNamed, seedDevEnvironment, signIn, stopDevNode, waitForDevNode, type DevEnvironment, type SeededNode } from "./dev-nodes.js";
import { serverArgs } from "./server-entry.js";

/**
 * A stand-in decision model: a message names its project; a stopped conversation is "not done" the first time and "done" after,
 * except the login page, which waits for the person.
 */
async function decisionModel(): Promise<{ server: Server; url: string; verdicts: string[] }> {
  const verdicts: string[] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { state: string; questions: Record<string, { criteria: Record<string, string> }> };
      const state = JSON.parse(parsed.state) as { user_message?: string };
      const choose = (choice: string) => ({ type: "choice", choice, confidence: 0.97 });
      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(parsed.questions)) {
        if (id === "verdict") { const verdict = parsed.state.includes("fix the login page") ? "needs_user" : verdicts.length ? "done" : "continue"; verdicts.push(verdict); answers[id] = choose(verdict); }
        else if (id === "kind") answers[id] = choose("task");
        else if (id === "size") answers[id] = choose("long");
        else if (id === "project") answers[id] = choose(Object.entries(question.criteria).find(([key, text]) => key !== "none" && state.user_message?.includes(text.split(".")[0]))?.[0] ?? "none");
        else answers[id] = choose("no" in question.criteria ? "no" : "none" in question.criteria ? "none" : Object.keys(question.criteria)[0]);
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ answers }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/systemone`, verdicts };
}

async function startNode(environment: DevEnvironment, node: SeededNode, root: string, endpoint: string): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env, PORT: String(node.port), NODE_ENV: "test", HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir, JOINT_BOB_SESSION_COOKIE: node.cookieName,
    JOINT_BOB_INSECURE_COOKIE: "1", JOINT_BOB_RELEASE: "development", JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log"), JOINT_BOB_TEST_ENGINE_DETAIL_LOG: path.join(root, "prompts.log"),
    JOINT_BOB_TEST_AUTOMATION_DIR: path.join(root, "stubs"), JOINT_BOB_TEST_REVIEW_CHECK_MS: "300", JOINT_BOB_TYPESAFE_ENDPOINT: endpoint,
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

test("a conversation that stops before its task is done is told to go on, one the decision model finds done is left for review, Bob's note goes once he checked it, and Abandon closes one", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-review-check-"));
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
    const prompts = async () => (await readFile(path.join(root, "prompts.log"), "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => (JSON.parse(line) as { prompt: string }).prompt);
    const timeline = async () => (await api<{ messages: BobMessage[] }>(node, auth, "GET", "/control-center/bob/messages")).body.messages;

    const started = await api<{ action: string }>(node, auth, "POST", "/control-center/bob/message", { message: "fix the mobile menu in Joint Bob" });
    assert.equal(started.body.action, "started", JSON.stringify(started.body));

    // The first stop is judged not done: Bob tells the agent to go on, once, and says so in the chat.
    const pushed = await eventually(async () => (await prompts()).find((prompt) => prompt.startsWith("Continue with the task")), "Bob told the conversation to go on");
    assert.match(pushed, /Keep going until it is done/);
    const said = await eventually(async () => (await timeline()).find((message) => /stopped before it was done, so I told it to go on \(1 of 3\)/.test(message.text)), "Bob said he pushed it on");
    assert.equal(said.importance, "fyi");
    assert.match(said.via ?? "", /^Review check · Decision model 97%/);
    // The message names its conversation, and while it runs on, the person can drop it.
    assert.deepEqual(said.actions.map((action) => action.id), ["open", "conversation.abandon"]);
    assert.equal((said.actions[0].data as { open: { title: string } }).open.title, "fix the mobile menu in Joint Bob");

    // The turn that answers the push is judged done: it is left for review, and no second push is sent.
    await eventually(async () => classifier.verdicts.length >= 2 ? true : undefined, "the second stop was checked");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal((await prompts()).filter((prompt) => prompt.startsWith("Continue with the task")).length, 1);
    assert.deepEqual(classifier.verdicts, ["continue", "done"]);
    const card = await eventually(async () => (await api<{ cards: Array<{ column: string; reviewCheck: { verdict: string } | null }> }>(node, auth, "GET", "/control-center/board")).body.cards.find((entry) => entry.reviewCheck), "the board shows the check");
    assert.equal(card.reviewCheck?.verdict, "done");
    assert.notEqual(card.column, "needs-you");
    // Bob's note was about the turn he pushed: it leaves the chat as soon as the conversation runs again (the board shows it),
    // or, when that turn already ended, once he checked it; at once either way, not at the next sweep.
    const noted = await eventually(async () => (await timeline()).find((message) => message.id === said.id && message.resolvedAt), "Bob's note left the chat");
    assert.ok(["It is running again.", "Bob checked it again when the turn he pushed ended."].includes(noted.resolution ?? ""), noted.resolution ?? "");
    assert.deepEqual(noted.actions, []);

    // Abandon stops a conversation if it still runs and closes it as marking it done does: it leaves the board, and Bob's
    // check ends. The pressed message leaves the chat, which says it: nothing new is written.
    const login = await api<{ action: string }>(node, auth, "POST", "/control-center/bob/message", { message: "fix the login page in Joint Bob" });
    assert.equal(login.body.action, "started", JSON.stringify(login.body));
    const waits = await eventually(async () => (await timeline()).find((message) => message.text.startsWith('"fix the login page in Joint Bob" waits for you') && message.actions.length), "Bob brought it to the person");
    const abandoned = await api<{ messages: BobMessage[]; pressed: BobMessage }>(node, auth, "POST", "/control-center/bob/action", { messageId: waits.id, actionId: "conversation.abandon" });
    assert.equal(abandoned.status, 200, JSON.stringify(abandoned.body));
    assert.deepEqual(abandoned.body.messages, []);
    assert.equal(abandoned.body.pressed.resolution, "You chose “Abandon”.");
    const sessions = (await api<{ sessions: Array<{ title: string; doneAt?: string }> }>(node, auth, "GET", `/projects/${project.id}/sessions`)).body.sessions;
    assert.ok(sessions.find((session) => session.title === "fix the login page in Joint Bob")?.doneAt, "the conversation is marked done");
    const board = (await api<{ cards: Array<{ title: string }> }>(node, auth, "GET", "/control-center/board")).body.cards;
    assert.equal(board.some((entry) => entry.title === "fix the login page in Joint Bob"), false, "it left the board");
    assert.deepEqual((await timeline()).find((message) => message.id === waits.id)?.actions, [], "the buttons ran once");

    // Done on a card closes its conversation with the person's feedback, as its project's list does: it leaves the board.
    const settings = await api<{ action: string }>(node, auth, "POST", "/control-center/bob/message", { message: "fix the settings page in Joint Bob" });
    assert.equal(settings.body.action, "started", JSON.stringify(settings.body));
    const settingsCard = await eventually(async () => (await api<{ cards: Array<{ title: string; projectId: string; conversationId: string }> }>(node, auth, "GET", "/control-center/board")).body.cards.find((entry) => entry.title === "fix the settings page in Joint Bob"), "the card is on the board");
    const closed = await api(node, auth, "POST", "/control-center/cards/done", { projectId: settingsCard.projectId, conversationId: settingsCard.conversationId, feedback: { rating: "unimportant", description: "" } });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    const afterDone = (await api<{ sessions: Array<{ title: string; doneAt?: string }> }>(node, auth, "GET", `/projects/${project.id}/sessions`)).body.sessions;
    assert.ok(afterDone.find((session) => session.title === "fix the settings page in Joint Bob")?.doneAt, "the conversation is marked done");
    await eventually(async () => (await api<{ cards: Array<{ title: string }> }>(node, auth, "GET", "/control-center/board")).body.cards.every((entry) => entry.title !== "fix the settings page in Joint Bob") || undefined, "the card left the board");
    assert.equal((await api(node, auth, "POST", "/control-center/cards/done", { projectId: project.id, conversationId: "no-such-conversation", feedback: { rating: "unimportant", description: "" } })).status, 404);
  } finally {
    if (child) await stopDevNode(child);
    classifier.server.close();
    await rm(root, { recursive: true, force: true });
  }
});
