import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The whole path with a real node: connecting Bob's bot from the settings routes, Telegram's calls arriving at the address it
// was given, and Bob's chat answering the linked person. Only Telegram is replaced, by a local server.

const BOT_TOKEN = "123456:AAtestTOKENtestTOKENtestTOKEN";
const PERSON = 111, STRANGER = 999, GROUP = -500;

interface Call { method: string; body: Record<string, unknown> }

async function fakeTelegram() {
  const calls: Call[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const json = (status: number, body: unknown) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      const method = /^\/bot(.+?)\/(\w+)$/.exec(request.url ?? "");
      if (!method || method[1] !== BOT_TOKEN) { json(401, { ok: false, description: "Unauthorized" }); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
      calls.push({ method: method[2], body });
      if (method[2] === "getMe") json(200, { ok: true, result: { id: 9000, username: "bob_test_bot", can_read_all_group_messages: false } });
      else json(200, { ok: true, result: method[2] === "sendMessage" ? { message_id: 700 + calls.length } : true });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    calls,
    named: (name: string) => calls.filter((call) => call.method === name),
    sent: () => calls.filter((call) => call.method === "sendMessage").map((call) => call.body),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const until = async <T>(check: () => T | undefined | false, what: string, seconds = 20): Promise<T> => {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const found = check();
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};
const quiet = () => new Promise((resolve) => setTimeout(resolve, 300));

test("Bob's Telegram bot is connected from the settings, answers only the linked person, pushes what matters and can be disconnected", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-control-telegram-"));
  const telegram = await fakeTelegram();
  const previous = { dataDir: process.env.PI_WEB_DATA_DIR, user: process.env.MASTER_BOB_ADMIN_USERNAME, password: process.env.MASTER_BOB_INITIAL_PASSWORD, telegram: process.env.JOINT_BOB_TELEGRAM_API };
  let closeNode: (() => Promise<void>) | undefined;
  try {
    process.env.PI_WEB_DATA_DIR = root;
    process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
    process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
    process.env.JOINT_BOB_TELEGRAM_API = telegram.url;
    const { server } = await import("../src/server.js");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closeNode = () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const { getClusterNode, updateClusterNode } = await import("../src/cluster.js");
    // A machine whose own address is plain http on a private name is not one Telegram can call.
    await updateClusterNode((await getClusterNode()).name, "http://homeserver.lan:3000");
    const { listLocalUsers } = await import("../src/auth.js");
    const { appendBobMessage, bobDatabase, getBobMessage } = await import("../src/control-center/bob-store.js");
    const { bobSays, registerBobAction } = await import("../src/control-center/bob-actions.js");

    const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    const { csrfToken } = await login.json() as { csrfToken: string };
    const changed = await fetch(`${baseUrl}/api/auth/change-password`, { method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "a-new-long-password-123" }) });
    assert.equal(changed.status, 204);
    const headers = { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };
    const call = async (method: string, route: string, body?: unknown) => {
      const response = await fetch(`${baseUrl}${route}`, { method, headers, ...body === undefined ? {} : { body: JSON.stringify(body) } });
      const text = await response.text();
      return { status: response.status, text, json: text ? JSON.parse(text) as any : null };
    };
    const accountId = listLocalUsers()[0].accountId;
    const db = await bobDatabase();

    // With no address Telegram can reach, the settings are told so and nothing is asked of Telegram.
    const none = await call("GET", "/api/control-center/telegram");
    assert.deepEqual([none.json.connected, none.json.bases], [false, []]);
    const refused = await call("POST", "/api/control-center/telegram", { token: BOT_TOKEN });
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, /no address Telegram can reach\. Join a relay in Settings/);
    assert.deepEqual(telegram.calls, []);

    // Not connected, with an address: the settings are told which addresses Telegram could use.
    await updateClusterNode((await getClusterNode()).name, baseUrl);
    const before = await call("GET", "/api/control-center/telegram");
    assert.equal(before.json.connected, false);
    assert.deepEqual(before.json.bases.map((base: { id: string }) => base.id), ["direct"]);

    // The token is checked before anything is set up.
    assert.equal((await call("POST", "/api/control-center/telegram", { token: "not a token" })).status, 400);
    assert.equal((await call("POST", "/api/control-center/telegram", { token: BOT_TOKEN, extra: true })).status, 400);
    const wrong = await call("POST", "/api/control-center/telegram", { token: "999:wrongwrongwrongwrongwrong" });
    assert.equal(wrong.status, 400);
    assert.match(wrong.json.error, /didn't accept this token/);
    assert.equal((await call("POST", "/api/control-center/telegram", { token: BOT_TOKEN, baseId: "nowhere" })).status, 409, "an address that does not exist");
    assert.deepEqual(telegram.named("setWebhook"), []);

    const connected = await call("POST", "/api/control-center/telegram", { token: BOT_TOKEN });
    assert.equal(connected.status, 201, connected.text);
    assert.deepEqual([connected.json.connected, connected.json.botUsername, connected.json.linked, connected.json.linkWaiting], [true, "bob_test_bot", null, true]);
    assert.equal(connected.text.includes(BOT_TOKEN), false, "the token never comes back");
    const code = new URL(connected.json.pairingLink).searchParams.get("start")!;
    assert.equal(new URL(connected.json.pairingLink).pathname, "/bob_test_bot");
    const webhook = telegram.named("setWebhook")[0].body as { url: string; secret_token: string; allowed_updates: string[]; drop_pending_updates: boolean };
    assert.ok(webhook.secret_token.length >= 32);
    assert.deepEqual(webhook.allowed_updates, ["message", "callback_query", "my_chat_member"]);
    assert.match(new URL(webhook.url).pathname, /^\/hooks\/bobtelegram-[A-Za-z0-9_-]{43}$/);
    assert.equal((await call("POST", "/api/control-center/telegram", { token: BOT_TOKEN })).status, 409, "one bot per person");
    const status = await call("GET", "/api/control-center/telegram");
    assert.equal(status.text.includes(BOT_TOKEN) || status.text.includes(webhook.secret_token) || status.text.includes(new URL(webhook.url).pathname), false);
    assert.equal((await call("GET", "/api/secrets")).text.includes(BOT_TOKEN), false, "no page can read the token again");
    assert.equal((await call("GET", "/api/webhooks")).json.webhooks.length, 0, "the bot's address is not a webhook to manage");

    let updateId = 5000;
    const post = (update: Record<string, unknown>, header = webhook.secret_token, url = webhook.url) => fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json", ...header ? { "X-Telegram-Bot-Api-Secret-Token": header } : {} }, body: JSON.stringify({ update_id: updateId += 1, ...update }),
    });
    const dm = (from: number, text: string, extra: Record<string, unknown> = {}) => ({ message: { message_id: updateId, from: { id: from, first_name: `User${from}` }, chat: { id: from, type: "private" }, text, ...extra } });
    const answered = (count: number) => until(() => telegram.sent().length >= count && telegram.sent(), `${count} messages sent to Telegram`);

    // Calls that do not prove they come from Telegram are refused before anything is read.
    assert.equal((await post(dm(PERSON, "hello"), "")).status, 401);
    assert.equal((await post(dm(PERSON, "hello"), "wrong")).status, 401);
    assert.equal((await post(dm(PERSON, "hello"), webhook.secret_token, `${baseUrl}/hooks/bobtelegram-${"A".repeat(43)}`)).status, 404);
    assert.equal((await fetch(webhook.url, { method: "GET" })).status, 405);
    // Until an account is linked, nobody is answered, and a wrong link opens nothing.
    assert.equal((await post(dm(PERSON, "hello"))).status, 200);
    assert.equal((await post(dm(STRANGER, "/start not-the-code"))).status, 200);
    await quiet();
    assert.deepEqual(telegram.sent(), []);

    // The one-time link links whoever opens it first.
    assert.equal((await post(dm(PERSON, `/start ${code}`))).status, 200);
    assert.match(String((await answered(1))[0].text), /^Connected\./);
    const linked = (await call("GET", "/api/control-center/telegram")).json;
    assert.deepEqual([linked.linked.id, linked.linked.name, linked.linkWaiting], [String(PERSON), `User${PERSON}`, false]);
    await post(dm(STRANGER, `/start ${code}`));
    await quiet();
    assert.equal(telegram.sent().length, 1);
    assert.equal((await call("GET", "/api/control-center/telegram")).json.linked.id, String(PERSON), "the link cannot be used twice");

    // Another sender gets nothing, and a group the bot is added to is left at once.
    await post(dm(STRANGER, "hello bob"));
    await post({ message: { message_id: 1, from: { id: STRANGER }, chat: { id: GROUP, type: "supergroup", title: "Family" }, text: "@bob_test_bot hi" } });
    await post({ my_chat_member: { chat: { id: -600, type: "group", title: "Other" }, from: { id: PERSON }, new_chat_member: { status: "member" } } });
    await until(() => telegram.named("leaveChat").length === 2 && telegram.named("leaveChat"), "the bot to leave both groups");
    assert.deepEqual(telegram.named("leaveChat").map((entry) => entry.body.chat_id).sort(), [String(GROUP), "-600"].sort());
    assert.equal(telegram.sent().length, 1);

    // A message from the linked person goes to Bob's chat as them, and Bob's answer comes back, once.
    const repeated = { update_id: 777, ...dm(PERSON, "what is running?") };
    for (let times = 0; times < 2; times += 1) await fetch(webhook.url, { method: "POST", headers: { "Content-Type": "application/json", "X-Telegram-Bot-Api-Secret-Token": webhook.secret_token }, body: JSON.stringify(repeated) });
    const reply = (await answered(2))[1];
    assert.equal(reply.chat_id, String(PERSON));
    assert.match(String(reply.text), /no projects yet/);
    await quiet();
    assert.equal(telegram.sent().length, 2, "a call Telegram repeats runs once, and the answer is not pushed a second time");
    const timeline = (await call("GET", "/api/control-center/bob/messages")).json.messages as Array<{ role: string; text: string }>;
    assert.deepEqual(timeline.map((entry) => entry.role), ["user", "bob"]);
    assert.equal(timeline[0].text, "what is running?");

    // A voice message is answered with a request to type it.
    await post(dm(PERSON, "", { voice: { file_id: "voice-1", file_size: 9, mime_type: "audio/ogg" } }));
    assert.match(String((await answered(3))[2].text), /can't listen to voice messages yet/);

    // Bob's own messages that matter reach Telegram with their buttons; pressing one runs it as the person, once.
    registerBobAction("test.telegram.allow", async ({ db: database, session }) => [bobSays(database, session, "Allowed once.")]);
    const review = appendBobMessage(db, accountId, {
      role: "system", importance: "needs-ok", projectName: "Julian", text: "Force a new deployment", via: "Guardian · production or destructive steps always ask you.",
      actions: [{ id: "test.telegram.allow", label: "Allow once", style: "warn" }, { id: "open", label: "Open", data: { open: { projectId: "p", conversationId: "c" } } }],
    });
    const pushed = (await answered(4))[3];
    assert.equal(pushed.chat_id, String(PERSON));
    assert.match(String(pushed.text), /Needs your OK · Julian/);
    assert.deepEqual((pushed.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard, [[{ text: "Allow once", callback_data: `b:${review.id}:0` }]], "the app has no public address here, so its link is left out");
    appendBobMessage(db, accountId, { role: "bob", text: "just so you know", importance: "fyi" });
    await quiet();
    assert.equal(telegram.sent().length, 4, "what does not matter stays in the app");

    const pressUpdate = (from: number, data: string) => ({ callback_query: { id: "cb-1", from: { id: from, first_name: "x" }, data, message: { message_id: 321, chat: { id: from, type: "private" } } } });
    await post(pressUpdate(STRANGER, `b:${review.id}:0`));
    await quiet();
    assert.equal(getBobMessage(db, accountId, review.id)?.actions.length, 2, "someone else pressing it does nothing");
    assert.equal(telegram.named("answerCallbackQuery").length, 0);
    await post(pressUpdate(PERSON, `b:${review.id}:0`));
    assert.equal((await answered(5))[4].text, "Allowed once.");
    assert.equal(getBobMessage(db, accountId, review.id)?.actions.length, 0, "the button was used up");
    assert.equal(telegram.named("answerCallbackQuery").length, 1);
    assert.deepEqual(telegram.named("editMessageReplyMarkup").map((entry) => (entry.body.reply_markup as { inline_keyboard: Array<Array<{ text: string }>> }).inline_keyboard[0][0].text), ["Allow once…", "Done: Allow once"]);
    await post(pressUpdate(PERSON, `b:${review.id}:0`));
    await until(() => telegram.named("answerCallbackQuery").length === 2, "the second press to be answered");
    assert.equal(telegram.named("answerCallbackQuery")[1].body.text, "That button is no longer available.");
    assert.equal(telegram.sent().length, 5, "the second press ran nothing");

    // Paused, Bob pushes nothing, and still answers a message.
    assert.equal((await call("PUT", "/api/control-center/bob/settings", { monitoring: false })).status, 200);
    appendBobMessage(db, accountId, { role: "system", text: "Prod is down", importance: "urgent" });
    await quiet();
    assert.equal(telegram.sent().length, 5);
    await post(dm(PERSON, "are you there?"));
    assert.match(String((await answered(6))[5].text), /no projects yet/);
    assert.equal((await call("PUT", "/api/control-center/bob/settings", { monitoring: true })).status, 200);

    // A new link is a new one-time code; the linked account stays until it is used.
    const fresh = await call("POST", "/api/control-center/telegram/pairing", {});
    assert.equal(fresh.status, 200);
    assert.notEqual(new URL(fresh.json.pairingLink).searchParams.get("start"), code);
    assert.deepEqual([fresh.json.linked.id, fresh.json.linkWaiting], [String(PERSON), true]);

    // Disconnecting applies from the next message: the address is gone, the token's secret too, and Telegram is told.
    const secretsBefore = (await call("GET", "/api/secrets")).json.accounts as Array<{ label: string }>;
    assert.ok(secretsBefore.some((account) => account.label === "Bob's Telegram bot @bob_test_bot"));
    assert.equal((await call("DELETE", "/api/control-center/telegram")).status, 204);
    assert.equal(telegram.named("deleteWebhook").length, 1);
    assert.equal((await post(dm(PERSON, "still there?"))).status, 404);
    assert.equal((await call("GET", "/api/control-center/telegram")).json.connected, false);
    assert.equal(((await call("GET", "/api/secrets")).json.accounts as Array<{ label: string }>).some((account) => account.label.startsWith("Bob's Telegram bot")), false);
    assert.equal((await call("DELETE", "/api/control-center/telegram")).status, 404);
    assert.equal((await call("POST", "/api/control-center/telegram/pairing", {})).status, 404);
    appendBobMessage(db, accountId, { role: "system", text: "after disconnect", importance: "urgent" });
    await quiet();
    assert.equal(telegram.sent().length, 6, "nothing is pushed once the bot is gone");

    // It can be connected again, with a fresh address, and the person links again.
    const again = await call("POST", "/api/control-center/telegram", { token: BOT_TOKEN });
    assert.equal(again.status, 201, again.text);
    assert.deepEqual(again.json.linked, null);
    assert.notEqual(telegram.named("setWebhook")[1].body.url, webhook.url);
    // The telegram bot is not the only thing on this node's webhooks: the old address stays dead.
    assert.equal((await post(dm(PERSON, "hello again"))).status, 404);
  } finally {
    await closeNode?.();
    await telegram.close();
    for (const [key, value] of [["PI_WEB_DATA_DIR", previous.dataDir], ["MASTER_BOB_ADMIN_USERNAME", previous.user], ["MASTER_BOB_INITIAL_PASSWORD", previous.password], ["JOINT_BOB_TELEGRAM_API", previous.telegram]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
