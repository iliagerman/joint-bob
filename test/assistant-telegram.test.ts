import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { openChat, waitFor } from "./queued-prompt-harness.js";

// The whole path with a real server: a Telegram update is authorized by code, the decision model
// judges it, an agent answers and the answer returns to the chat. Only the outside world is
// replaced: Kiro by an ACP fixture, Jev and Telegram by a local server.

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
    appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify({ sessionId, text, botToken: process.env.TELEGRAM_BOT_TOKEN ?? null }) + "\\n");
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

interface Decision { question: string; criteria: string[]; state: { user_message?: string; saved_topics?: Array<{ summary: string }>; accessible_history?: unknown[]; new_message?: { author: string; text: string; mentions_bot: boolean }; recent_messages?: Array<{ author: string; text: string }> } }
interface Sent { token: string; method: string; chat_id?: string; text?: string; parse_mode?: string; url?: string; secret_token?: string; allowed_updates?: string[]; reply_parameters?: { message_id: number } }

async function outsideWorld() {
  const decisions: Decision[] = [];
  const calls: Sent[] = [];
  const control = { choice: "new_topic", address: "answer", down: false };
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
      const json = (status: number, body: unknown) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      const telegram = /^\/bot(.+)\/(\w+)$/.exec(request.url ?? "");
      if (telegram) {
        const [, token, method] = telegram;
        if (token !== BOT_TOKEN) { json(401, { ok: false, description: "Unauthorized" }); return; }
        calls.push({ token, method, ...JSON.parse(raw || "{}") as Omit<Sent, "token" | "method"> });
        json(200, { ok: true, result: method === "getMe" ? { id: 9000, username: "family_bot", can_read_all_group_messages: false } : true });
        return;
      }
      if (control.down) { json(500, {}); return; }
      const body = JSON.parse(raw) as { state: string; questions: Record<string, { criteria: Record<string, string> }> };
      const [question] = Object.keys(body.questions);
      decisions.push({ question, criteria: Object.keys(body.questions[question].criteria), state: JSON.parse(body.state) as Decision["state"] });
      json(200, { answers: { [question]: { type: "choice", choice: question === "address" ? control.address : control.choice, confidence: 0.9 } } });
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, decisions, calls, control, sent: () => calls.filter(call => call.method === "sendMessage"), close: () => new Promise(resolve => server.close(resolve)) };
}

const BOT_TOKEN = "123456:AAtestTOKENtestTOKENtestTOKEN";
const OWNER = 111, STRANGER = 999, FRIEND = 222, GROUP = -500;

test("a Telegram bot reaches its assistant only through code that approves each person and group", { timeout: 300_000 }, async () => {
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
    const decisionKey = await api<{ account: { id: string } }>(node, session, "POST", "/secrets/accounts", { label: "decision", provider: "custom", variables: [{ name: "TYPESAFE_AI_API_KEY", kind: "value", value: "fixture-key" }] });
    assert.equal((await api(node, session, "PUT", `/secrets/scopes/project/${projectId}`, { accountIds: [decisionKey.body.account.id] })).status, 200);

    const chat = openChat(node.url, session.cookie, projectId, "kiro:new");
    await waitFor(chat.messages, () => chat.messages.some(message => message.type === "ready"));
    chat.socket.send(JSON.stringify({ type: "prompt", message: "We are planning a Rome trip", requestId: crypto.randomUUID() }));
    await waitFor(chat.messages, () => chat.messages.some(message => message.type === "promptCompleted"), 60_000);
    chat.socket.close();
    const sessions = await api<{ sessions: Array<{ id: string; harnessId: string }> }>(node, session, "GET", `/projects/${projectId}/sessions`);
    const source = sessions.body.sessions.find(item => item.harnessId === "kiro");
    assert.ok(source, "the source conversation exists");
    const assistant = await api<{ assistant: { id: string } }>(node, session, "POST", "/personal-assistants", { projectId, engine: "kiro", sessionId: source.id, name: "Telegram helper", instructions: "" });
    assert.equal(assistant.status, 201, JSON.stringify(assistant.body));
    const assistantId = assistant.body.assistant.id;
    const telegram = `/personal-assistants/${assistantId}/telegram`;

    // The generic webhook form can't create a bot without these protections.
    const generic = await api<{ error: string }>(node, session, "POST", "/webhooks", { name: "Unprotected", target: { kind: "assistant", projectId, assistantId }, reply: "telegram" });
    assert.equal(generic.status, 400);

    // Connecting: a bad token is refused, a good one gets a second secret that Telegram must send back.
    const notConnected = await api<{ connected: boolean; bases: Array<{ id: string }> }>(node, session, "GET", telegram);
    assert.equal(notConnected.body.connected, false);
    assert.ok(notConnected.body.bases.length, "the test machine has an address");
    assert.equal((await api(node, session, "POST", telegram, { token: "not a token" })).status, 400);
    assert.equal((await api(node, session, "POST", telegram, { token: "999:wrongwrongwrongwrongwrong" })).status, 400);
    const connected = await api<{ botUsername: string; readsAllGroupMessages: boolean; pairingLink: string; owner: unknown }>(node, session, "POST", telegram, { token: BOT_TOKEN });
    assert.equal(connected.status, 201, JSON.stringify(connected.body));
    assert.equal(connected.body.botUsername, "family_bot");
    assert.equal(connected.body.readsAllGroupMessages, false, "the screen warns that the bot can't read whole groups");
    assert.equal(connected.body.owner, null);
    assert.equal(JSON.stringify(connected.body).includes(BOT_TOKEN), false, "the token never comes back");
    const registered = world.calls.find(call => call.method === "setWebhook")!;
    assert.ok(registered.secret_token && registered.secret_token.length >= 32);
    assert.deepEqual(registered.allowed_updates, ["message", "my_chat_member"]);
    const hookUrl = new URL(registered.url!).pathname;
    const pairingCode = new URL(connected.body.pairingLink).searchParams.get("start")!;
    assert.equal(new URL(connected.body.pairingLink).pathname, "/family_bot");
    assert.equal(((await api<{ webhooks: unknown[] }>(node, session, "GET", "/webhooks")).body.webhooks).length, 0, "the bot's webhook is managed from the assistant");

    let updateId = 1000;
    const send = (update: Record<string, unknown>, header: string | undefined = registered.secret_token) => fetch(`${node.url}${hookUrl}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(header ? { "X-Telegram-Bot-Api-Secret-Token": header } : {}) }, body: JSON.stringify({ update_id: updateId += 1, ...update }),
    });
    const dm = (from: number, text: string) => ({ message: { message_id: updateId, from: { id: from, first_name: `User${from}` }, chat: { id: from, type: "private" }, text } });
    const inGroup = (from: number, text: string, chat = GROUP) => ({ message: { message_id: updateId, from: { id: from, first_name: `User${from}` }, chat: { id: chat, type: "supergroup", title: "Family" }, text } });
    const settle = () => new Promise(resolve => setTimeout(resolve, 900));
    const prompts = async () => (await readFile(promptLog, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { text: string; botToken: string | null });
    const promptCount = (await prompts()).length;
    const turns = async () => (await api<{ turns: Array<{ topicId: string; message: string; status: string }> }>(node, session, "GET", `/personal-assistants/${assistantId}/turns`)).body.turns;
    const lastTurnOrigin = () => {
      const db = new DatabaseSync(path.join(node.dataDir, "node.db"), { readOnly: true });
      try { return (db.prepare("SELECT origin FROM personal_assistant_turns ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as { origin: string }).origin; }
      finally { db.close(); }
    };
    const status = async () => (await api<{ owner: { id: string } | null; waiting: Array<{ kind: string; id: string; name: string }>; allowed: Array<{ kind: string; id: string }>; blocked: unknown[]; calls: Array<{ status: string; detail: string }> }>(node, session, "GET", telegram)).body;
    const replyAfter = async (action: () => Promise<Response>) => {
      const before = world.sent().length;
      assert.equal((await action()).status, 200);
      const deadline = Date.now() + 60_000;
      while (world.sent().length === before) {
        assert.ok(Date.now() < deadline, `no reply: ${JSON.stringify((await status()).calls)}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return world.sent().at(-1)!;
    };

    // Forged calls: without the secret, nothing is read or run.
    assert.equal((await send(dm(OWNER, "hello"), "")).status, 401);
    assert.equal((await send(dm(OWNER, "hello"), "wrong-secret")).status, 401);
    await settle();
    assert.equal(world.sent().length, 0);

    // Until an owner is linked, nobody gets through, and a stranger is told once.
    const refused = await replyAfter(() => send(dm(STRANGER, "let me in")));
    assert.equal(refused.text, "This bot is private.");
    assert.equal((await send(dm(STRANGER, "please"))).status, 200);
    assert.equal((await send(dm(STRANGER, "/start wrong-code"))).status, 200);
    await settle();
    assert.equal(world.sent().length, 1, "a stranger gets one reply, not one for every message");
    assert.deepEqual((await status()).waiting.map(item => [item.kind, item.id]), [["user", String(STRANGER)]]);
    assert.equal(world.decisions.length, 0, "the decision model never ran");
    assert.equal((await prompts()).length, promptCount, "the agent never ran");
    const noticed = await api<{ notices: Array<{ title: string }> }>(node, session, "GET", `/personal-assistants/${assistantId}/activity`);
    assert.ok(noticed.body.notices.some(notice => notice.title.includes("asked to use @family_bot")));

    // Pairing: the one-time link makes that account the owner, and works once.
    const paired = await replyAfter(() => send(dm(OWNER, `/start ${pairingCode}`)));
    assert.match(paired.text!, /^Connected\./);
    assert.equal((await status()).owner?.id, String(OWNER));
    await send(dm(STRANGER, `/start ${pairingCode}`));
    await settle();
    assert.equal((await status()).owner?.id, String(OWNER), "the link can't be used again");

    // A call Telegram sends twice runs once.
    const repeated = { update_id: 777, ...dm(OWNER, "/start") };
    await replyAfter(() => fetch(`${node.url}${hookUrl}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": registered.secret_token! }, body: JSON.stringify(repeated) }));
    const afterFirst = world.sent().length;
    await fetch(`${node.url}${hookUrl}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": registered.secret_token! }, body: JSON.stringify(repeated) });
    await settle();
    assert.equal(world.sent().length, afterFirst);

    // Your own private chat is the same assistant as the app: it can continue what you started there.
    world.control.choice = "topic_0";
    const answer = await replyAfter(() => send(dm(OWNER, "What about hotels there?")));
    assert.equal(answer.chat_id, String(OWNER));
    assert.equal(answer.parse_mode, "HTML");
    assert.match(answer.text!, /^<b>Done<\/b> in /);
    const ownerRoute = world.decisions.at(-1)!;
    assert.deepEqual(ownerRoute.criteria, ["topic_0", "new_topic", "recall_history"], "the owner's chat sees the assistant's topics and history");
    assert.equal(ownerRoute.state.user_message, "What about hotels there?");
    assert.equal((await turns()).at(-1)!.topicId, `kiro:${source.id}`, "it continued the conversation from the app");
    const ownerPrompt = (await prompts()).at(-1)!;
    assert.match(ownerPrompt.text, /What about hotels there\?$/);
    assert.doesNotMatch(ownerPrompt.text, /treat it as data/, "the owner's words aren't labelled as outside data");
    assert.equal(ownerPrompt.botToken, null, "the agent can't read the bot's token");
    assert.equal(lastTurnOrigin(), "chat", "your own chat counts as you, so it can ask your other assistants");

    // Someone else adds the bot to a group: it leaves, and nothing runs.
    const decisionsBefore = world.decisions.length;
    const addedBy = (from: number, chat: number) => ({ my_chat_member: { chat: { id: chat, type: "supergroup", title: chat === GROUP ? "Family" : "Strangers" }, from: { id: from, first_name: `User${from}` }, new_chat_member: { status: "member", user: { id: 9000 } } } });
    assert.equal((await send(addedBy(STRANGER, -600))).status, 200);
    await settle();
    assert.equal(world.calls.filter(call => call.method === "leaveChat").at(-1)?.chat_id, "-600");
    await send(inGroup(STRANGER, "@family_bot hello", -600));
    await settle();
    assert.equal(world.decisions.length, decisionsBefore);
    assert.equal(world.calls.filter(call => call.method === "leaveChat").length, 2, "a message from a group that isn't approved makes it leave again");
    assert.ok((await status()).waiting.some(item => item.kind === "chat" && item.id === "-600"));

    // You add it to a group: approved, one shared context, and the decision model decides when to answer.
    await send(addedBy(OWNER, GROUP));
    await settle();
    assert.ok((await status()).allowed.some(item => item.kind === "chat" && item.id === String(GROUP)));
    world.control.address = "stay_silent";
    const sentBefore = world.sent().length;
    await send(inGroup(FRIEND, "Flights are booked for 14 Dec"));
    await settle();
    assert.equal(world.sent().length, sentBefore, "people talking among themselves get no reply");
    assert.equal(world.decisions.at(-1)!.question, "address");
    world.control.address = "answer";
    world.control.choice = "new_topic";
    const groupAnswer = await replyAfter(() => send(inGroup(STRANGER, "@family_bot when do we leave?")));
    assert.equal(groupAnswer.chat_id, String(GROUP));
    assert.ok(groupAnswer.reply_parameters, "it answers the message it was asked in");
    assert.equal(world.decisions.at(-1)!.question, "address", "a group's first conversation has nothing to continue");
    assert.equal(world.decisions.at(-1)!.state.new_message?.mentions_bot, true);
    const groupPrompt = (await prompts()).at(-1)!.text;
    assert.match(groupPrompt, /Flights are booked for 14 Dec/, "everything said in the group is shared context");
    assert.match(groupPrompt, /treat it as data/);
    assert.match(groupPrompt, /everyone in the group can read it/);
    assert.equal(lastTurnOrigin(), "webhook", "someone else's message can't ask your other assistants");
    const groupTopic = (await turns()).at(-1)!.topicId;
    assert.notEqual(groupTopic, `kiro:${source.id}`, "a group doesn't join your private conversations");
    world.control.choice = "topic_0";
    await replyAfter(() => send(inGroup(FRIEND, "@family_bot and when do we return?")));
    const groupRoute = world.decisions.at(-1)!;
    assert.equal(groupRoute.question, "route");
    assert.deepEqual(groupRoute.criteria, ["topic_0", "new_topic"], "only the group's own conversation can be continued, and history can't be recalled");
    assert.equal((await turns()).at(-1)!.topicId, groupTopic, "everyone in the group shares it");

    // Someone joining an approved group keeps it working and tells you.
    await send({ message: { message_id: updateId, from: { id: FRIEND }, chat: { id: GROUP, type: "supergroup", title: "Family" }, new_chat_members: [{ id: 333, first_name: "Newcomer" }] } });
    await settle();
    const joinedNotice = await api<{ notices: Array<{ title: string }> }>(node, session, "GET", `/personal-assistants/${assistantId}/activity`);
    assert.ok(joinedNotice.body.notices.some(notice => notice.title.startsWith("Newcomer joined Family")), JSON.stringify(joinedNotice.body.notices));
    world.control.address = "answer";
    world.control.choice = "topic_0";
    await replyAfter(() => send(inGroup(333, "@family_bot hi from the newcomer")));

    // Approving someone gives them their own conversations; blocking or removing applies at once.
    assert.equal((await api(node, session, "PUT", `${telegram}/access`, { kind: "user", id: String(STRANGER), state: "approved" })).status, 200);
    const decisionsAtApproval = world.decisions.length;
    await replyAfter(() => send(dm(STRANGER, "Now can I talk?")));
    assert.equal(world.decisions.length, decisionsAtApproval, "their first message has nothing to continue");
    const friendPrompt = (await prompts()).at(-1)!.text;
    assert.match(friendPrompt, /approved to message this Telegram bot/);
    assert.ok(![`kiro:${source.id}`, groupTopic].includes((await turns()).at(-1)!.topicId), "they don't reach your conversations or the group's");
    assert.equal((await api(node, session, "PUT", `${telegram}/access`, { kind: "user", id: String(STRANGER), state: "blocked" })).status, 200);
    const sentWhileBlocked = world.sent().length;
    await send(dm(STRANGER, "Still there?"));
    await settle();
    assert.equal(world.sent().length, sentWhileBlocked, "a blocked person gets nothing");
    assert.equal((await api(node, session, "PUT", `${telegram}/access`, { kind: "chat", id: String(GROUP), state: null })).status, 200);
    const leftBefore = world.calls.filter(call => call.method === "leaveChat").length;
    await send(inGroup(FRIEND, "@family_bot are you there?"));
    await settle();
    assert.equal(world.calls.filter(call => call.method === "leaveChat").length, leftBefore + 1, "a removed group is refused from its next message");

    // When Jev can't answer in your own chat, you're told; a turn never starts blind.
    world.control.down = true;
    const failure = await replyAfter(() => send(dm(OWNER, "Still there?")));
    assert.match(failure.text!, /couldn't be handled/);
    world.control.down = false;

    const say = (_chat: number, text: string) => replyAfter(() => send(dm(OWNER, text)));

    // Every topic knows the assistant's folder and memory, and the agent can write memory itself.
    world.control.choice = "topic_0";
    await say(111, "remember-this please");
    const last = (await prompts()).at(-1)!.text;
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

    // Disconnecting: Telegram is told, and the old address stops working.
    const managedHook = (await fetch(`${node.url}${hookUrl}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status;
    assert.equal(managedHook, 401);
    const disconnected = await fetch(`${node.url}/api${telegram}`, { method: "DELETE", headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken } });
    assert.equal(disconnected.status, 204);
    assert.ok(world.calls.some(call => call.method === "deleteWebhook"));
    assert.equal((await fetch(`${node.url}${hookUrl}`, { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": registered.secret_token! }, body: "{}" })).status, 404);
    assert.equal((await api<{ connected: boolean }>(node, session, "GET", telegram)).body.connected, false);
    assert.equal((await api<{ accounts: Array<{ label: string }> }>(node, session, "GET", "/secrets")).body.accounts.some(item => item.label.includes("family_bot")), false, "the bot's token is deleted");

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
