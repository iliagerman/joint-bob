import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { openChat, waitFor } from "./queued-prompt-harness.js";

// The whole path with a real server: a Telegram update reaches an assistant through its webhook,
// the decision model chooses the conversation, an agent answers, and the answer returns to the
// chat. Only the outside world is replaced: Kiro by an ACP fixture, Jev and Telegram by a local server.

function kiroFixture(promptLog: string, note: string): string {
  return `#!/usr/bin/env node
const { execFileSync } = require("node:child_process");
const { appendFileSync, writeFileSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
if (process.argv.includes("--version") || process.argv.includes("whoami")) process.exit(0);
if (process.argv.includes("--list-models")) {
  process.stdout.write(JSON.stringify({ models: [{ model_id: "default", model_name: "Fixture default" }] }));
  process.exit(0);
}
const send = value => process.stdout.write(JSON.stringify(value) + "\\n");
let sessionId = "";
require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") return send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (request.method === "session/new") { sessionId = randomUUID(); return send({ jsonrpc: "2.0", id: request.id, result: { sessionId } }); }
  if (request.method === "session/load") { sessionId = request.params.sessionId; return send({ jsonrpc: "2.0", id: request.id, result: null }); }
  if (request.method === "session/prompt") {
    const text = request.params.prompt.map(block => block.text ?? "").join("");
    appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify({ sessionId, text }) + "\\n");
    if (text.includes("remember-this")) {
      const cli = process.env.JOINT_BOB_ASSISTANT_MEMORY_CLI;
      const { revision } = JSON.parse(execFileSync(process.execPath, [cli, "read"], { encoding: "utf8" }));
      writeFileSync(${JSON.stringify(note)}, "The owner prefers trains.\\n");
      execFileSync(process.execPath, [cli, "write", revision, ${JSON.stringify(note)}]);
    }
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "**Done** in " + sessionId } } } });
    return send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
  }
});
`;
}

interface Decision { criteria: string[]; state: { user_message: string; saved_topics: Array<{ summary: string }>; accessible_history: unknown[] } }
interface Sent { token: string; chat_id: string; text: string; parse_mode?: string }

async function outsideWorld() {
  const decisions: Decision[] = [];
  const sent: Sent[] = [];
  const control = { choice: "new_topic", down: false };
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      const json = (status: number, body: unknown) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      const telegram = /^\/bot(.+)\/sendMessage$/.exec(request.url ?? "");
      if (telegram) { sent.push({ token: telegram[1], ...JSON.parse(raw) as Omit<Sent, "token"> }); json(200, { ok: true }); return; }
      if (control.down) { json(500, {}); return; }
      const body = JSON.parse(raw) as { state: string; questions: { route: { criteria: Record<string, string> } } };
      decisions.push({ criteria: Object.keys(body.questions.route.criteria), state: JSON.parse(body.state) as Decision["state"] });
      json(200, { answers: { route: { type: "choice", choice: control.choice, confidence: 0.9 } } });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, decisions, sent, control, close: () => new Promise(resolve => server.close(resolve)) };
}

test("a Telegram chat talks to an assistant: Jev picks the conversation, each chat keeps its own, and the answer comes back", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assistant-telegram-"));
  const world = await outsideWorld();
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const promptLog = path.join(root, "prompts.jsonl");
    const executable = path.join(environment.home, "bin", "kiro-fixture");
    const configPath = path.join(environment.home, ".kiro");
    await Promise.all([mkdir(path.dirname(executable), { recursive: true }), mkdir(path.join(configPath, "sessions"), { recursive: true })]);
    await writeFile(executable, kiroFixture(promptLog, path.join(root, "note.md")));
    await chmod(executable, 0o700);
    const settings = new DatabaseSync(path.join(node.dataDir, "node.db"));
    const save = settings.prepare("INSERT INTO node_settings (key, value, is_secret, updated_at) VALUES (?, ?, 0, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at");
    for (const [key, value] of [["kiro.executable", executable], ["kiro.configPath", configPath], ["kiro.sessionPath", path.join(configPath, "sessions")]]) save.run(key, value, new Date().toISOString());
    settings.close();
    server = await startDevNode(environment, node, { JOINT_BOB_TYPESAFE_ENDPOINT: `${world.url}/v1/systemone`, JOINT_BOB_TELEGRAM_API: world.url });
    const session = await signIn(environment, node);
    const projectId = projectNamed(node, "Joint Bob").id;

    const account = async (label: string, name: string, value: string) => {
      const created = await api<{ account: { id: string } }>(node, session, "POST", "/secrets/accounts", { label, provider: "custom", variables: [{ name, kind: "value", value }] });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      return created.body.account.id;
    };
    const decisionKey = await account("decision", "TYPESAFE_AI_API_KEY", "fixture-key");
    assert.equal((await api(node, session, "PUT", `/secrets/scopes/project/${projectId}`, { accountIds: [decisionKey] })).status, 200);
    const botToken = await account("bot", "TELEGRAM_BOT_TOKEN", "bot-secret");

    const chat = openChat(node.url, session.cookie, projectId, "kiro:new");
    await waitFor(chat.messages, () => chat.messages.some(message => message.type === "ready"));
    chat.socket.send(JSON.stringify({ type: "prompt", message: "start", requestId: crypto.randomUUID() }));
    await waitFor(chat.messages, () => chat.messages.some(message => message.type === "promptCompleted"), 60_000);
    chat.socket.close();
    const sessions = await api<{ sessions: Array<{ id: string; harnessId: string }> }>(node, session, "GET", `/projects/${projectId}/sessions`);
    const source = sessions.body.sessions.find(item => item.harnessId === "kiro");
    assert.ok(source, "the source conversation exists");
    const assistant = await api<{ assistant: { id: string } }>(node, session, "POST", "/personal-assistants", { projectId, engine: "kiro", sessionId: source.id, name: "Telegram helper", instructions: "" });
    assert.equal(assistant.status, 201, JSON.stringify(assistant.body));
    const assistantId = assistant.body.assistant.id;

    const senders = { fields: ["message.from.id"], allowed: [{ value: "111", label: "Ilia" }, { value: "222", label: "" }] };
    const hookInput = { name: "Telegram", target: { kind: "assistant", projectId, assistantId }, senders, reply: "telegram" };
    const noToken = await api<{ error: string }>(node, session, "POST", "/webhooks", hookInput);
    assert.equal(noToken.status, 400);
    assert.match(noToken.body.error, /TELEGRAM_BOT_TOKEN/, "a reply without a bot token is refused when saving");
    const created = await api<{ webhook: { id: string; preserveFiles: boolean }; secret: string }>(node, session, "POST", "/webhooks", { ...hookInput, secretAccountIds: [botToken] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.webhook.preserveFiles, false, "the default setup is the one under test");

    const deliveries = async () => (await api<{ deliveries: Array<{ status: string; detail: string }> }>(node, session, "GET", `/webhooks/${created.body.webhook.id}/deliveries`)).body.deliveries;
    const turns = async () => (await api<{ turns: Array<{ topicId: string; message: string; response: string | null }> }>(node, session, "GET", `/personal-assistants/${assistantId}/turns`)).body.turns;
    const say = async (chatId: number, text: string) => {
      const replies = world.sent.length;
      const response = await fetch(`${node.url}/hooks/${created.body.secret}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ update_id: Date.now(), message: { message_id: 1, from: { id: chatId }, chat: { id: chatId }, text } }) });
      assert.equal(response.status, 202);
      const deadline = Date.now() + 60_000;
      while (world.sent.length === replies) {
        assert.ok(Date.now() < deadline, `no reply to "${text}": ${JSON.stringify(await deliveries())}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return world.sent.at(-1)!;
    };

    // The first message of a chat has nothing to continue, so Jev isn't asked.
    const first = await say(111, "Plan my Rome trip");
    assert.equal(world.decisions.length, 0);
    assert.equal(first.token, "bot-secret");
    assert.equal(first.chat_id, "111");
    assert.equal(first.parse_mode, "HTML");
    assert.match(first.text, /^<b>Done<\/b> in /, "Markdown is formatted for Telegram");
    const romeTopic = (await turns()).at(-1)!.topicId;
    assert.notEqual(romeTopic, `kiro:${source.id}`, "an outside caller doesn't land in the owner's conversation");

    // Jev chooses to continue: same conversation, and it read the person's words, not the webhook's wrapping.
    world.control.choice = "topic_0";
    await say(111, "What about hotels there?");
    assert.equal(world.decisions.length, 1);
    assert.deepEqual(world.decisions[0].criteria, ["topic_0", "new_topic"], "only this chat's conversation can be continued, and history can't be recalled");
    assert.equal(world.decisions[0].state.user_message, "What about hotels there?");
    assert.deepEqual(world.decisions[0].state.accessible_history, []);
    assert.equal((await turns()).at(-1)!.topicId, romeTopic, "the conversation continues");

    // Jev chooses a new one.
    world.control.choice = "new_topic";
    await say(111, "Unrelated: my bike has a flat");
    const bikeTopic = (await turns()).at(-1)!.topicId;
    assert.notEqual(bikeTopic, romeTopic);

    // Another chat never sees or joins the first chat's conversations.
    const decisionsBefore = world.decisions.length;
    const other = await say(222, "Hello");
    assert.equal(other.chat_id, "222");
    assert.equal(world.decisions.length, decisionsBefore, "a chat with no conversations of its own has nothing to choose from");
    const otherTopic = (await turns()).at(-1)!.topicId;
    assert.ok(![romeTopic, bikeTopic].includes(otherTopic));

    world.control.choice = "topic_1";
    await say(111, "Back to the bike");
    const offered = world.decisions.at(-1)!;
    assert.deepEqual(offered.criteria, ["topic_0", "topic_1", "new_topic"], "the first chat is offered its two conversations and not the other chat's");
    assert.ok(offered.state.saved_topics.every(topic => !topic.summary.includes('"text": "Hello"')));
    assert.equal((await turns()).at(-1)!.topicId, bikeTopic, "Jev can return to an earlier conversation");

    // Someone not on the list reaches nothing.
    const replies = world.sent.length;
    const refused = await fetch(`${node.url}/hooks/${created.body.secret}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: { from: { id: 999 }, chat: { id: 999 }, text: "let me in" } }) });
    assert.equal(refused.status, 202);
    assert.deepEqual(await refused.json(), { accepted: false });
    assert.equal(world.sent.length, replies);

    // When Jev can't answer, the person is told instead of waiting forever, and the call says why.
    world.control.down = true;
    const failure = await say(111, "Still there?");
    assert.match(failure.text, /couldn't be handled/);
    assert.ok((await deliveries()).some(delivery => delivery.status === "failed" && /classify/.test(delivery.detail)), JSON.stringify(await deliveries()));
    world.control.down = false;

    // Every topic knows the assistant's folder and memory, and the agent can write memory itself.
    world.control.choice = "topic_0";
    await say(111, "remember-this please");
    const prompts = (await readFile(promptLog, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { text: string });
    const last = prompts.at(-1)!.text;
    assert.match(last, /This assistant's folder: /);
    assert.match(last, /This assistant's memory: /);
    const memory = await api<{ enabled: boolean; content: string; revision: string }>(node, session, "GET", `/personal-assistants/${assistantId}/memory`);
    assert.equal(memory.body.content, "The owner prefers trains.\n", "the agent saved a note through its memory command");

    // The owner manages the same memory.
    const stale = await api(node, session, "PUT", `/personal-assistants/${assistantId}/memory`, { content: "x", expectedRevision: "0".repeat(64) });
    assert.equal(stale.status, 409, "an edit from a stale read is refused");
    const edited = await api<{ content: string }>(node, session, "PUT", `/personal-assistants/${assistantId}/memory`, { content: "Edited by the owner.\n", expectedRevision: memory.body.revision });
    assert.equal(edited.body.content, "Edited by the owner.\n");
    const off = await api<{ enabled: boolean }>(node, session, "PUT", `/personal-assistants/${assistantId}/memory/enabled`, { enabled: false });
    assert.equal(off.body.enabled, false);
    await say(111, "anything else");
    assert.doesNotMatch((await readFile(promptLog, "utf8")).trim().split("\n").at(-1)!, /This assistant's memory: /, "memory turned off isn't offered");

    // Files: upload, list, download, delete; nothing outside the folder.
    const files = `/personal-assistants/${assistantId}/files`;
    const uploaded = await api<{ files: Array<{ path: string; bytes: number }> }>(node, session, "POST", files, { name: "plan.txt", data: Buffer.from("Rome in May").toString("base64") });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.deepEqual(uploaded.body.files.map(file => [file.path, file.bytes]), [["plan.txt", 11]]);
    assert.equal((await api(node, session, "POST", files, { name: "../escape.txt", data: "" })).status, 400);
    const download = await fetch(`${node.url}/api${files}/download?path=plan.txt`, { headers: { Cookie: session.cookie } });
    assert.equal(await download.text(), "Rome in May");
    assert.match(download.headers.get("content-disposition") ?? "", /attachment/);
    assert.equal((await fetch(`${node.url}/api${files}/download?path=${encodeURIComponent("../../node.db")}`, { headers: { Cookie: session.cookie } })).status, 404, "a path out of the folder is not served");
    await say(111, "what files do you have");
    assert.match((await readFile(promptLog, "utf8")).trim().split("\n").at(-1)!, /It holds: plan\.txt/, "the agent is told what its folder holds");
    assert.deepEqual((await api<{ files: unknown[] }>(node, session, "DELETE", `${files}?path=plan.txt`)).body.files, []);

    // A skill only this assistant has.
    const skillFile = "---\nname: trip-planner\ndescription: Plans trips.\n---\nPlan the trip.\n";
    const skill = await api<{ skill: { id: string; name: string } }>(node, session, "POST", `/personal-assistants/${assistantId}/own-skills`, { action: "upload", files: [{ relativePath: "SKILL.md", data: Buffer.from(skillFile).toString("base64") }] });
    assert.equal(skill.status, 201, JSON.stringify(skill.body));
    assert.equal(skill.body.skill.name, "trip-planner");
    await say(111, "plan it");
    assert.match((await readFile(promptLog, "utf8")).trim().split("\n").at(-1)!, /trip-planner: .*SKILL\.md/, "the agent is told about its own skill");

    // The owner's own chat goes through the same turn: it completes and keeps the answer.
    world.control.choice = "new_topic";
    const chatTurn = await api<{ turn: { status: string; response: string } }>(node, session, "POST", `/personal-assistants/${assistantId}/turn`, { requestId: crypto.randomUUID(), message: "From the app", recentMessages: [] });
    assert.equal(chatTurn.status, 200, JSON.stringify(chatTurn.body));
    assert.equal(chatTurn.body.turn.status, "completed");
    assert.match(chatTurn.body.turn.response, /^\*\*Done\*\* in /);
    const timeline = await api<{ timeline: Array<{ role: string; text: string }> }>(node, session, "GET", `/personal-assistants/${assistantId}/transcript`);
    assert.ok(timeline.body.timeline.some(item => item.role === "user" && item.text === "From the app"));
    assert.ok(!timeline.body.timeline.some(item => item.text.includes("Personal assistant instructions")), "the chat shows what was said, not the context added for the agent");

    // Deleting the assistant takes what it kept with it.
    const folder = path.join(node.dataDir, "assistant-files", assistantId);
    assert.ok((await stat(folder)).isDirectory());
    const removed = await fetch(`${node.url}/api/personal-assistants/${assistantId}`, { method: "DELETE", headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken } });
    assert.equal(removed.status, 204);
    await assert.rejects(stat(folder), { code: "ENOENT" });
    await assert.rejects(stat(path.join(node.dataDir, "webhook-resources", assistantId)), { code: "ENOENT" });
  } finally {
    if (server) await stopDevNode(server);
    await world.close();
    await rm(root, { recursive: true, force: true });
  }
});
