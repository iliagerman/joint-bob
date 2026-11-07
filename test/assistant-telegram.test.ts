import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { LOCAL_VOICE_LOADER, localVoiceAllowed } from "../src/server/story-voice.js";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { openChat, waitFor } from "./queued-prompt-harness.js";
import { kiroV3SessionFixture } from "./kiro-v3-fixture.js";

// The whole path with a real server: a Telegram update is authorized by code, the decision model
// judges it, an agent answers and the answer returns to the chat. Only the outside world is
// replaced: Kiro by an ACP fixture, Jev and Telegram by a local server.

function kiroFixture(promptLog: string, note: string): string {
  return `#!/usr/bin/env node
${kiroV3SessionFixture}
const { execFileSync } = require("node:child_process");
const { appendFileSync, symlinkSync, writeFileSync } = require("node:fs");
const path = require("node:path");
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
  if (request.method === "session/new") { sessionId = randomUUID(); return send({ jsonrpc: "2.0", id: request.id, result: v3Session(request, sessionId) }); }
  if (request.method === "session/load") { sessionId = request.params.sessionId; return send({ jsonrpc: "2.0", id: request.id, result: v3Session(request, sessionId) }); }
  if (request.method === "session/prompt") {
    const text = request.params.prompt.map(block => block.text ?? "").join("");
    const images = request.params.prompt.filter(block => block.type === "image").map(block => block.mimeType);
    appendFileSync(${JSON.stringify(promptLog)}, JSON.stringify({ sessionId, text, images, botToken: process.env.TELEGRAM_BOT_TOKEN ?? null }) + "\\n");
    if (/"text":"[^"]*send-files-back/.test(text)) {
      const folder = /save them in (.+?): everything/.exec(text)[1];
      writeFileSync(path.join(folder, "report.pdf"), "the report");
      writeFileSync(path.join(folder, "chart.png"), "the chart");
      writeFileSync(path.join(folder, "hello.ogg"), "the voice");
      symlinkSync(${JSON.stringify(note)}, path.join(folder, "leak.txt"));
    }
    if (text.includes("remember-this")) {
      const cli = process.env.JOINT_BOB_ASSISTANT_MEMORY_CLI;
      const { revision } = JSON.parse(execFileSync(process.execPath, [cli, "read"], { encoding: "utf8" }));
      writeFileSync(${JSON.stringify(note)}, "The owner prefers trains.\\n");
      execFileSync(process.execPath, [cli, "write", revision, ${JSON.stringify(note)}]);
    }
    const answer = text.includes("answer-with-link") ? "See **this** at https://example.com/a" : text.includes("answer-in-hebrew") ? "המלון מוזמן." : "**Done** in " + sessionId;
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: answer } } } });
    return send({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
  }
});
`;
}

interface Decision { question: string; criteria: string[]; state: { user_message?: string; saved_topics?: Array<{ summary: string }>; accessible_history?: unknown[]; new_message?: { author: string; text: string; mentions_bot: boolean; files: string[] }; recent_messages?: Array<{ author: string; text: string }> } }
interface Sent { token: string; method: string; chat_id?: string; text?: string; parse_mode?: string; url?: string; secret_token?: string; allowed_updates?: string[]; reply_parameters?: { message_id: number }; file_id?: string; fileName?: string; fileText?: string }

async function outsideWorld() {
  const decisions: Decision[] = [];
  const calls: Sent[] = [];
  const control = { choice: "new_topic", address: "answer", down: false, transcript: "", speechDown: false, voiceDown: false };
  const files = new Map<string, Buffer>();
  const speech: Array<{ key: string; name: string; bytes: string }> = [];
  const spoken: Array<{ key: string; text: string; model: string }> = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => { chunks.push(chunk); });
    request.on("end", () => void (async () => {
      const bytes = Buffer.concat(chunks);
      const raw = bytes.toString();
      const contentType = String(request.headers["content-type"] ?? "");
      const form = () => new Response(bytes, { headers: { "Content-Type": contentType } }).formData();
      const json = (status: number, body: unknown) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      if (request.url === "/v1/speech-to-text") {
        const upload = (await form()).get("file") as File;
        speech.push({ key: String(request.headers["xi-api-key"]), name: upload.name, bytes: await upload.text() });
        json(control.speechDown ? 500 : 200, control.speechDown ? { detail: "down" } : { text: control.transcript });
        return;
      }
      if (request.url?.startsWith("/v1/text-to-speech/")) {
        const { text, model_id: model } = JSON.parse(raw) as { text: string; model_id: string };
        spoken.push({ key: String(request.headers["xi-api-key"]), text, model });
        if (control.voiceDown) { json(500, { detail: "down" }); return; }
        response.writeHead(200, { "Content-Type": "audio/mpeg" }).end("speech from eleven");
        return;
      }
      const download = /^\/file\/bot(.+?)\/files\/(.+)$/.exec(request.url ?? "");
      if (download) {
        if (download[1] !== BOT_TOKEN) { json(401, {}); return; }
        response.writeHead(200).end(files.get(download[2]));
        return;
      }
      const telegram = /^\/bot(.+)\/(\w+)$/.exec(request.url ?? "");
      if (telegram) {
        const [, token, method] = telegram;
        if (token !== BOT_TOKEN) { json(401, { ok: false, description: "Unauthorized" }); return; }
        if (contentType.startsWith("multipart/form-data")) {
          const fields = await form();
          const upload = [...fields.values()].find(value => value instanceof File) as File;
          calls.push({ token, method, chat_id: String(fields.get("chat_id")), fileName: upload.name, fileText: await upload.text(), ...(fields.has("reply_parameters") ? { reply_parameters: JSON.parse(String(fields.get("reply_parameters"))) as { message_id: number } } : {}) });
          json(200, { ok: true, result: {} });
          return;
        }
        const body = JSON.parse(raw || "{}") as Omit<Sent, "token" | "method">;
        calls.push({ token, method, ...body });
        if (method === "getFile") {
          if (!files.has(body.file_id!)) { json(400, { ok: false, description: "Bad Request: file is too big" }); return; }
          json(200, { ok: true, result: { file_id: body.file_id, file_path: `files/${body.file_id}` } });
          return;
        }
        json(200, { ok: true, result: method === "getMe" ? { id: 9000, username: "family_bot", can_read_all_group_messages: false } : true });
        return;
      }
      if (control.down) { json(500, {}); return; }
      const body = JSON.parse(raw) as { state: string; questions: Record<string, { criteria: Record<string, string> }> };
      const [question] = Object.keys(body.questions);
      decisions.push({ question, criteria: Object.keys(body.questions[question].criteria), state: JSON.parse(body.state) as Decision["state"] });
      json(200, { answers: { [question]: { type: "choice", choice: question === "address" ? control.address : control.choice, confidence: 0.9 } } });
    })());
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, decisions, calls, control, files, speech, spoken, sent: () => calls.filter(call => call.method === "sendMessage"), close: () => new Promise(resolve => server.close(resolve)) };
}

/** The open-source voice's packages, standing in for the real ones so nothing is downloaded. Whisper's language pick and its words are read back by the test. */
async function seedLocalVoice(dataDir: string): Promise<{ say: (words: string) => Promise<void> }> {
  const runtime = path.join(dataDir, "story-voice-runtime");
  const modules = path.join(runtime, "node_modules");
  const fake = async (name: string, code: string) => {
    await mkdir(path.join(modules, name), { recursive: true });
    await writeFile(path.join(modules, name, "package.json"), JSON.stringify({ name, type: "module", main: "index.js" }));
    await writeFile(path.join(modules, name, "index.js"), code);
  };
  const ffmpeg = path.join(runtime, "fake-ffmpeg");
  await mkdir(runtime, { recursive: true });
  await writeFile(ffmpeg, "#!/bin/sh\nprintf '\\000\\000\\000\\000\\000\\000\\000\\000'\n");
  await chmod(ffmpeg, 0o700);
  await fake("ffmpeg-static", `export default ${JSON.stringify(ffmpeg)};`);
  await fake("kokoro-js", "export const KokoroTTS = { from_pretrained: async () => ({ generate: async () => ({ audio: new Float32Array(1152), sampling_rate: 24000 }) }) };");
  await fake("@breezystack/lamejs", "export class Mp3Encoder { encodeBuffer() { return Int8Array.of(75); } flush() { return Int8Array.of(79); } }");
  await fake("@huggingface/transformers", `import { readFileSync } from "node:fs";
export const env = {};
export class Tensor {}
export async function pipeline() {
  const transcriber = async (_audio, options) => ({ text: readFileSync(${JSON.stringify(path.join(runtime, "words.txt"))}, "utf8") + " (" + options.language + ")" });
  transcriber.processor = async () => ({ input_features: {} });
  transcriber.model = Object.assign(async () => ({ logits: { data: [0, 5] } }), { generation_config: { decoder_start_token_id: 0, lang_to_id: { "<|en|>": 0, "<|he|>": 1 } } });
  return transcriber;
}`);
  await writeFile(path.join(runtime, "load.mjs"), LOCAL_VOICE_LOADER);
  return { say: words => writeFile(path.join(runtime, "words.txt"), words) };
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
    server = await startDevNode(environment, node, { JOINT_BOB_TYPESAFE_ENDPOINT: `${world.url}/v1/systemone`, JOINT_BOB_TELEGRAM_API: world.url, JOINT_BOB_ELEVENLABS_API: world.url });
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
    const prompts = async () => (await readFile(promptLog, "utf8")).trim().split("\n").map(line => JSON.parse(line) as { text: string; images: string[]; botToken: string | null });
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

    // ---- Voice, photos and files. ----
    const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const own = (extra: Record<string, unknown>) => ({ message: { message_id: updateId, from: { id: OWNER, first_name: "Owner" }, chat: { id: OWNER, type: "private" }, ...extra } });
    const shared = (from: number, extra: Record<string, unknown>) => ({ message: { message_id: updateId, from: { id: from, first_name: `User${from}` }, chat: { id: GROUP, type: "supergroup", title: "Family" }, ...extra } });
    const held = (id: string, bytes: Buffer | string) => { world.files.set(id, Buffer.from(bytes)); return { file_id: id, file_unique_id: `unique-${id}`, file_size: Buffer.byteLength(bytes) }; };
    const attachedPath = (prompt: string, name: string) => new RegExp(`- ${name}: (.+)`).exec(prompt)?.[1];
    world.control.choice = "new_topic";

    // A photo reaches the agent as an image, with what its sender wrote.
    await replyAfter(() => send(own({ photo: [held("thumb", "small"), held("photo", JPEG)], caption: "what hotel is this?" })));
    const photoPrompt = (await prompts()).at(-1)!;
    assert.deepEqual(photoPrompt.images, ["image/jpeg"]);
    assert.match(photoPrompt.text, /what hotel is this\?\n\n\(Sent photo\.jpg\)/);
    assert.deepEqual(world.calls.filter(call => call.method === "getFile").at(-1)?.file_id, "photo", "the largest size");
    assert.equal(photoPrompt.botToken, null);
    assert.equal(photoPrompt.text.includes(BOT_TOKEN), false, "the download link never reaches the agent");
    const timelineTexts = (await api<{ timeline: Array<{ text: string }> }>(node, session, "GET", `/personal-assistants/${assistantId}/transcript`)).body.timeline.map(item => item.text);
    assert.ok(timelineTexts.some(text => text.startsWith("what hotel is this?")), "the app's chat shows what was said");
    assert.ok(!timelineTexts.some(text => text.includes("[Telegram: ")), "and not the note added for the agent");

    // A file of any type arrives by path. One that claims to be an image but isn't never goes in as one.
    await replyAfter(() => send(own({ document: { ...held("archive", "PK zipped"), file_name: "trip plan.zip", mime_type: "application/zip" } })));
    const documentPrompt = (await prompts()).at(-1)!;
    assert.deepEqual(documentPrompt.images, []);
    const savedPath = attachedPath(documentPrompt.text, "trip plan.zip");
    assert.ok(savedPath, documentPrompt.text);
    assert.equal(await readFile(savedPath, "utf8"), "PK zipped");
    await replyAfter(() => send(own({ document: { ...held("fake", "<script>"), file_name: "fake.png", mime_type: "image/png" } })));
    assert.deepEqual((await prompts()).at(-1)!.images, []);

    // A file too large for Telegram to hand over: the sender is told, and nothing runs for it.
    const beforeLarge = (await prompts()).length;
    const tooLarge = await replyAfter(() => send(own({ document: { file_id: "huge", file_unique_id: "huge", file_size: 30 * 1024 * 1024, file_name: "movie.mkv" } })));
    assert.match(tooLarge.text!, /movie\.mkv is larger than the 20 MB/);
    assert.equal(world.calls.some(call => call.file_id === "huge"), false, "it isn't even requested");
    await settle();
    assert.equal((await prompts()).length, beforeLarge);

    // An album is one turn, however many messages it arrives as.
    const beforeAlbum = (await prompts()).length;
    const album = { media_group_id: "album-1" };
    const repliesBeforeAlbum = world.sent().length;
    await send(own({ ...album, photo: [held("one", JPEG)], caption: "our rooms" }));
    await send(own({ ...album, photo: [held("two", JPEG)] }));
    await send(own({ ...album, photo: [held("three", JPEG)] }));
    const albumDeadline = Date.now() + 60_000;
    while (world.sent().length === repliesBeforeAlbum) { assert.ok(Date.now() < albumDeadline, "the album got no answer"); await new Promise(resolve => setTimeout(resolve, 100)); }
    const albumPrompts = (await prompts()).slice(beforeAlbum);
    assert.equal(albumPrompts.length, 1);
    assert.equal(albumPrompts[0].images.length, 3);
    assert.match(albumPrompts[0].text, /our rooms/);

    // Replying to an older file gives the agent that file.
    await replyAfter(() => send(own({ text: "and this one?", reply_to_message: { message_id: 5, document: { ...held("older", "%PDF older"), file_name: "older.pdf" } } })));
    assert.ok(attachedPath((await prompts()).at(-1)!.text, "older.pdf"));

    const callRecorded = async (detail: string) => {
      const deadline = Date.now() + 10_000;
      while (!(await status()).calls.some(call => call.detail === detail)) {
        assert.ok(Date.now() < deadline, `"${detail}" isn't in ${JSON.stringify((await status()).calls)}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    };
    const voiceSent = () => world.calls.filter(call => call.method === "sendVoice");
    const voiceAfter = async (action: () => Promise<Response>) => {
      const before = voiceSent().length;
      assert.equal((await action()).status, 200);
      const deadline = Date.now() + 60_000;
      while (voiceSent().length === before) {
        assert.ok(Date.now() < deadline, `no voice reply: ${JSON.stringify((await status()).calls)}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return voiceSent().at(-1)!;
    };
    const ownVoice = (id: string, sound: string) => own({ voice: { ...held(id, sound), mime_type: "audio/ogg" } });
    const voiceStatus = async () => (await api<{ voice: { replies: boolean; transcription: string | null; speech: string | null; local: { allowed: boolean; installed: boolean } } }>(node, session, "GET", telegram)).body.voice;
    const voiceReplies = (enabled: boolean) => api(node, session, "PUT", `${telegram}/voice-replies`, { enabled });

    // With nothing set up, a voice message reaches the agent as sound and the answer comes as text.
    assert.deepEqual([(await voiceStatus()).replies, (await voiceStatus()).transcription, (await voiceStatus()).speech], [true, null, null]);
    await replyAfter(() => send(ownVoice("voice-1", "ogg sound")));
    const unheard = (await prompts()).at(-1)!.text;
    assert.match(unheard, /couldn't transcribe/);
    assert.doesNotMatch(unheard, /read aloud/, "the agent isn't told to write for a voice that doesn't exist");
    assert.ok(attachedPath(unheard, "voice\\.ogg"), unheard);
    assert.deepEqual([world.speech.length, voiceSent().length], [0, 0]);

    // With an ElevenLabs account, the words are the message, and a voice message is answered with voice. The key stays here.
    const voiceKey = await api<{ account: { id: string } }>(node, session, "POST", "/secrets/accounts", { label: "voice", provider: "elevenlabs", variables: [{ name: "ELEVENLABS_API_KEY", kind: "value", value: "fixture-eleven-key" }] });
    assert.equal((await api(node, session, "PUT", `/secrets/scopes/project/${projectId}`, { accountIds: [decisionKey.body.account.id, voiceKey.body.account.id] })).status, 200);
    assert.deepEqual([(await voiceStatus()).transcription, (await voiceStatus()).speech], ["elevenlabs", "elevenlabs"]);
    assert.equal(JSON.stringify(await voiceStatus()).includes("fixture-eleven-key"), false);
    world.control.transcript = "מה עם המלון?";
    const textsBefore = world.sent().length;
    const voiced = await voiceAfter(() => send(ownVoice("voice-2", "second sound")));
    assert.deepEqual(world.speech.at(-1), { key: "fixture-eleven-key", name: "voice.ogg", bytes: "second sound" });
    const heard = (await prompts()).at(-1)!.text;
    assert.match(heard, /transcribed from a voice message/);
    assert.match(heard, /read aloud/);
    assert.match(heard, /מה עם המלון\?$/);
    assert.equal(world.decisions.at(-1)!.state.user_message, "מה עם המלון?", "the decision model judges the words");
    assert.deepEqual([voiced.chat_id, voiced.fileName, voiced.fileText], [String(OWNER), "voice.mp3", "speech from eleven"]);
    assert.match(world.spoken.at(-1)!.text, /^Done in /, "formatting isn't read out");
    assert.deepEqual([world.spoken.at(-1)!.key, world.spoken.at(-1)!.model], ["fixture-eleven-key", "eleven_v3"]);
    await callRecorded("Replied in Telegram by voice");
    assert.equal(world.sent().length, textsBefore, "the voice message is the answer");

    // A typed message still gets text.
    const voicesBeforeText = voiceSent().length;
    await replyAfter(() => send(own({ text: "typed question" })));
    assert.equal(voiceSent().length, voicesBeforeText);

    // Speech can't carry a link, so the text goes too.
    world.control.transcript = "answer-with-link please";
    const textsBeforeLink = world.sent().length;
    await voiceAfter(() => send(ownVoice("voice-link", "link sound")));
    assert.equal(world.spoken.at(-1)!.text, "See this at");
    const linkDeadline = Date.now() + 10_000;
    while (world.sent().length === textsBeforeLink) { assert.ok(Date.now() < linkDeadline, "the text didn't follow"); await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.match(world.sent().at(-1)!.text!, /https:\/\/example\.com\/a/);

    // The owner can turn voice replies off, and back on.
    world.control.transcript = "a question";
    assert.equal((await voiceReplies(false)).status, 200);
    assert.equal((await voiceStatus()).replies, false);
    const voicesWhileOff = voiceSent().length;
    await replyAfter(() => send(ownVoice("voice-off", "off sound")));
    assert.equal(voiceSent().length, voicesWhileOff, "it answers in text");
    assert.doesNotMatch((await prompts()).at(-1)!.text, /read aloud/);
    assert.equal((await voiceReplies(true)).status, 200);

    // When speaking fails, the answer still arrives as text, and the failure is on record.
    world.control.voiceDown = true;
    await replyAfter(() => send(ownVoice("voice-tts-down", "more sound")));
    assert.ok((await status()).calls.some(call => /^Answered in text: /.test(call.detail)), JSON.stringify((await status()).calls));
    world.control.voiceDown = false;

    // When transcribing fails, the sound still reaches the agent, and the failure is on record.
    world.control.speechDown = true;
    await voiceAfter(() => send(ownVoice("voice-3", "third sound")));
    assert.ok(attachedPath((await prompts()).at(-1)!.text, "voice\\.ogg"));
    world.control.speechDown = false;
    assert.ok((await status()).calls.some(call => /Couldn't transcribe voice\.ogg/.test(call.detail)), JSON.stringify((await status()).calls));

    // A recording someone shares comes with its words, and the file.
    world.control.transcript = "the words of the meeting";
    await replyAfter(() => send(own({ audio: { ...held("meeting", "mp3 meeting"), file_name: "meeting.mp3", mime_type: "audio/mpeg" } })));
    const recording = (await prompts()).at(-1)!.text;
    assert.match(recording, /\[Words in meeting\.mp3: the words of the meeting\]/);
    assert.ok(attachedPath(recording, "meeting\\.mp3"), recording);

    // The open-source voice needs no account: it listens and speaks here, in the language it hears.
    const { allowed: machineCanRunIt } = localVoiceAllowed(os.totalmem(), os.cpus().length);
    if (machineCanRunIt) {
      const local = await seedLocalVoice(node.dataDir);
      assert.deepEqual([(await voiceStatus()).transcription, (await voiceStatus()).speech], ["local", "kokoro"]);
      const heardByElevenLabs = world.speech.length, spokenByElevenLabs = world.spoken.length;
      await local.say("what about the hotel");
      const localVoice = await voiceAfter(() => send(ownVoice("voice-local", "local sound")));
      assert.match((await prompts()).at(-1)!.text, /what about the hotel \(he\)$/, "Whisper read the language first, and the words came back");
      assert.deepEqual([localVoice.fileName, localVoice.fileText], ["voice.mp3", "KO"], "Kokoro's speech, encoded");
      assert.deepEqual([world.speech.length, world.spoken.length], [heardByElevenLabs, spokenByElevenLabs], "ElevenLabs wasn't used");

      // Kokoro only speaks English. Another language goes to ElevenLabs if there's an account, and otherwise comes as text.
      await local.say("answer-in-hebrew please");
      await voiceAfter(() => send(ownVoice("voice-hebrew", "hebrew sound")));
      assert.equal(world.spoken.at(-1)!.text, "המלון מוזמן.");
      assert.equal((await api(node, session, "PUT", `/secrets/scopes/project/${projectId}`, { accountIds: [decisionKey.body.account.id] })).status, 200);
      const hebrewText = await replyAfter(() => send(ownVoice("voice-hebrew-2", "hebrew again")));
      assert.equal(hebrewText.text, "המלון מוזמן.");
      assert.equal((await api(node, session, "PUT", `/secrets/scopes/project/${projectId}`, { accountIds: [decisionKey.body.account.id, voiceKey.body.account.id] })).status, 200);
      await rm(path.join(node.dataDir, "story-voice-runtime"), { recursive: true, force: true });
    }

    // A stranger's file is never fetched or transcribed.
    const fetchedBefore = world.calls.filter(call => call.method === "getFile").length;
    const heardBefore = world.speech.length;
    await send(dm(STRANGER, "still blocked"));
    await send({ message: { message_id: updateId, from: { id: STRANGER, first_name: "Stranger" }, chat: { id: STRANGER, type: "private" }, voice: { ...held("stranger", "sound"), mime_type: "audio/ogg" } } });
    await settle();
    assert.equal(world.calls.filter(call => call.method === "getFile").length, fetchedBefore);
    assert.equal(world.speech.length, heardBefore);

    // In a group, a voice message is judged by its words; a file waits until the assistant answers.
    await send(addedBy(OWNER, GROUP));
    await settle();
    world.control.address = "stay_silent";
    world.control.transcript = "the flight moved to Friday";
    assert.equal((await voiceStatus()).transcription, "elevenlabs");
    const silentBefore = world.sent().length;
    await send(shared(FRIEND, { voice: { ...held("group-voice", "group sound"), mime_type: "audio/ogg" } }));
    await settle();
    assert.equal(world.decisions.at(-1)!.state.new_message?.text, "the flight moved to Friday");
    assert.equal(world.sent().length, silentBefore);
    const fetchedWhileSilent = world.calls.filter(call => call.method === "getFile").length;
    await send(shared(FRIEND, { document: { ...held("group-bill", "%PDF bill"), file_name: "bill.pdf" }, caption: "the bill" }));
    await settle();
    assert.deepEqual(world.decisions.at(-1)!.state.new_message?.files, ["bill.pdf"]);
    assert.equal(world.calls.filter(call => call.method === "getFile").length, fetchedWhileSilent, "people's files stay in Telegram until the assistant needs them");
    world.control.address = "answer";
    world.control.choice = "new_topic";
    await replyAfter(() => send(shared(STRANGER, { text: "@family_bot what does the bill say?" })));
    const groupFiles = (await prompts()).at(-1)!.text;
    assert.match(groupFiles, /the flight moved to Friday/, "what was said aloud is shared context");
    assert.match(groupFiles, /\[bill\.pdf\] the bill/);
    assert.ok(attachedPath(groupFiles, "bill\\.pdf"), groupFiles);
    assert.match(groupFiles, /along with any files sent with it/);
    await replyAfter(() => send(shared(STRANGER, { text: "@family_bot thanks" })));
    assert.equal(attachedPath((await prompts()).at(-1)!.text, "bill\\.pdf"), undefined, "a file goes once");

    // Sending files back: each goes the way its type shows best, and a link out of the folder never goes.
    const sendsBefore = world.calls.length;
    await replyAfter(() => send(shared(FRIEND, { text: "@family_bot send-files-back please" })));
    const postedFiles = async () => world.calls.slice(sendsBefore).filter(call => call.fileName).map(call => [call.method, call.fileName, call.fileText, call.chat_id]);
    const postDeadline = Date.now() + 10_000;
    while ((await postedFiles()).length < 3) { assert.ok(Date.now() < postDeadline, "the files weren't sent"); await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.deepEqual(await postedFiles(), [["sendPhoto", "chart.png", "the chart", String(GROUP)], ["sendVoice", "hello.ogg", "the voice", String(GROUP)], ["sendDocument", "report.pdf", "the report", String(GROUP)]]);
    await settle();
    assert.equal((await postedFiles()).length, 3, "the link was left out");
    const replyFolders = (await readdir(path.join(projectNamed(node, "Joint Bob").path, ".joint-bob-attachments"))).filter(name => name.startsWith("telegram-reply-"));
    assert.deepEqual(replyFolders, [], "the turn's folder is removed");
    await callRecorded("Replied in Telegram with 3 files");

    // In a group, a voice message is answered with voice too, on the message it was asked in.
    world.control.transcript = "@family_bot are the rooms booked?";
    const groupVoiceMessage = updateId;
    const groupVoice = await voiceAfter(() => send(shared(FRIEND, { voice: { ...held("group-question", "question sound"), mime_type: "audio/ogg" } })));
    assert.deepEqual([groupVoice.chat_id, groupVoice.fileName, groupVoice.reply_parameters?.message_id], [String(GROUP), "voice.mp3", groupVoiceMessage]);

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
