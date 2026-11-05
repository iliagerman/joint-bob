import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { AuthSession } from "../src/auth.js";
import { appendBobMessage, ensureBobSchema, getBobMessage, writeBobSettings, type BobMessage } from "../src/control-center/bob-store.js";
import { telegramApiFor, type TelegramApi } from "../src/control-center/telegram-api.js";
import { duringTelegramExchange, handleTelegramUpdate, startTelegramPush, type BotDeps } from "../src/control-center/telegram-bot.js";
import { callbackData, keyboardFor, parseCallbackData, pushedText, telegramReachableUrl, wantsTelegramPush, type InlineKeyboard } from "../src/control-center/telegram-format.js";
import {
  consumeTelegramPairing, ensureTelegramSchema, issueTelegramPairing, newTelegramSecrets, removeTelegramConnection, saveTelegramConnection, telegramConnectionFor, telegramConnectionForUrlSecret,
  telegramHeaderValid, telegramPairingPending, telegramUpdateIsNew, type TelegramConnection,
} from "../src/control-center/telegram-store.js";
import { readTelegramUpdate } from "../src/control-center/telegram-updates.js";

// No Telegram anywhere: the bot's side is a fake Telegram client, or a local server for the client itself.

const ACCOUNT = "account-ilia";
const PERSON = 111, STRANGER = 999, GROUP = -500;
const SESSION = { accountId: ACCOUNT, username: "ilia" } as AuthSession;

function database(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  ensureBobSchema(db);
  ensureTelegramSchema(db);
  return db;
}

/** A connection whose link was already used by PERSON, unless `linked` is false. */
function connect(db: DatabaseSync, linked = true): { known: TelegramConnection; secrets: ReturnType<typeof newTelegramSecrets> } {
  const secrets = newTelegramSecrets();
  saveTelegramConnection(db, { accountId: ACCOUNT, tokenAccountId: "secret-1", botId: "9000", botUsername: "bob_bot", ...secrets });
  if (linked) {
    const code = issueTelegramPairing(db, ACCOUNT);
    assert.ok(consumeTelegramPairing(db, telegramConnectionFor(db, ACCOUNT)!, code, String(PERSON), "Ilia"));
  }
  return { known: telegramConnectionFor(db, ACCOUNT)!, secrets };
}

const dm = (from: number, text: string, extra: Record<string, unknown> = {}, chat = from) => ({ message: { message_id: 1, from: { id: from, first_name: `User${from}` }, chat: { id: chat, type: "private" }, text, ...extra } });
const inGroup = (from: number, text: string, chat = GROUP) => ({ message: { message_id: 1, from: { id: from, first_name: `User${from}` }, chat: { id: chat, type: "supergroup", title: "Family" }, text } });
const press = (from: number, data: string, messageId = 55) => ({ callback_query: { id: "cb-1", from: { id: from, first_name: `User${from}` }, data, message: { message_id: messageId, chat: { id: from, type: "private" } } } });
let updateId = 1000;
const update = (body: Record<string, unknown>) => ({ update_id: (updateId += 1), ...body });

interface Sent { chatId: string; text: string; keyboard: InlineKeyboard | null | undefined }
interface Outside {
  sent: Sent[];
  calls: string[];
  keyboards: Array<{ messageId: number; keyboard: InlineKeyboard | null }>;
  answers: Array<{ id: string; text?: string }>;
  api: TelegramApi;
}

function fakeTelegram(): Outside {
  const outside: Outside = { sent: [], calls: [], keyboards: [], answers: [], api: undefined as never };
  outside.api = {
    async send(chatId, text, keyboard) { outside.calls.push("send"); outside.sent.push({ chatId, text, keyboard }); return [outside.sent.length]; },
    async answerCallback(id, text) { outside.calls.push("answer"); outside.answers.push({ id, ...text ? { text } : {} }); },
    async setKeyboard(_chatId, messageId, keyboard) { outside.calls.push("keyboard"); outside.keyboards.push({ messageId, keyboard }); },
    async typing() { outside.calls.push("typing"); },
    async leave(chatId) { outside.calls.push(`leave ${chatId}`); },
  };
  return outside;
}

function setUp(options: { linked?: boolean } = {}) {
  const db = database();
  const { known, secrets } = connect(db, options.linked ?? true);
  const outside = fakeTelegram();
  const asked: string[] = [];
  const pressed: Array<{ messageId: string; actionId: string }> = [];
  const changed: string[] = [];
  const deps: BotDeps = {
    db,
    api: () => outside.api,
    session: (accountId) => accountId === ACCOUNT ? SESSION : null,
    ask: async (_session, text) => {
      asked.push(text);
      // Bob adds its own lines to the timeline while it answers; they are the answer, not news.
      appendBobMessage(db, ACCOUNT, { role: "user", text });
      return appendBobMessage(db, ACCOUNT, { role: "bob", text: `Echo: ${text}`, importance: "needs-you", actions: [{ id: "test.go", label: "Go", style: "primary" }, { id: "open", label: "Open", data: { open: { projectId: "p1", conversationId: "c1" } } }] });
    },
    press: async (_session, messageId, actionId) => {
      pressed.push({ messageId, actionId });
      if (actionId === "test.fail") throw new Error("it broke");
      return [appendBobMessage(db, ACCOUNT, { role: "bob", text: "Allowed once.", importance: "fyi" })];
    },
    appUrl: async () => "https://bob.example.com",
    changed: (accountId) => { changed.push(accountId); },
  };
  return { db, known, secrets, outside, asked, pressed, changed, deps };
}

test("a link works once, for ten minutes, and only the hash of each secret is kept", () => {
  const db = database();
  const { known, secrets } = connect(db, false);
  assert.equal(telegramConnectionForUrlSecret(db, secrets.urlSecret)?.accountId, ACCOUNT);
  assert.equal(telegramConnectionForUrlSecret(db, `${secrets.urlSecret}x`), undefined);
  assert.match(secrets.urlSecret, /^bobtelegram-[A-Za-z0-9_-]{43}$/);
  const stored = JSON.stringify(db.prepare("SELECT * FROM control_center_telegram").all());
  assert.equal(stored.includes(secrets.urlSecret) || stored.includes(secrets.headerSecret), false, "the secrets are not stored");
  assert.ok(telegramHeaderValid(known, secrets.headerSecret));
  assert.equal(telegramHeaderValid(known, "wrong"), false);
  assert.equal(telegramHeaderValid(known, undefined), false);
  assert.equal(telegramHeaderValid(known, ["a", "b"]), false);

  // Nobody is linked, so there is no link waiting yet either.
  assert.equal(telegramPairingPending(known), false);
  const now = Date.now();
  const code = issueTelegramPairing(db, ACCOUNT, now);
  const waiting = telegramConnectionFor(db, ACCOUNT)!;
  assert.equal(telegramPairingPending(waiting, now), true);
  assert.equal(consumeTelegramPairing(db, waiting, "wrong-code", "5", "Eve", now), false);
  assert.equal(telegramConnectionFor(db, ACCOUNT)!.telegramUserId, null, "a wrong code links nobody");
  assert.equal(consumeTelegramPairing(db, waiting, code, "5", "Eve", now + 10 * 60_000 + 1), false, "it expires after ten minutes");
  assert.equal(consumeTelegramPairing(db, waiting, code, String(PERSON), "Ilia", now + 9 * 60_000), true);
  assert.deepEqual([telegramConnectionFor(db, ACCOUNT)!.telegramUserId, telegramConnectionFor(db, ACCOUNT)!.telegramName], [String(PERSON), "Ilia"]);
  assert.equal(consumeTelegramPairing(db, waiting, code, "5", "Eve", now + 9 * 60_000), false, "the link cannot be used again");
  assert.equal(telegramConnectionFor(db, ACCOUNT)!.telegramUserId, String(PERSON));

  // A new link replaces an older one that was never used.
  const first = issueTelegramPairing(db, ACCOUNT, now);
  const second = issueTelegramPairing(db, ACCOUNT, now);
  assert.equal(consumeTelegramPairing(db, telegramConnectionFor(db, ACCOUNT)!, first, "5", "Eve", now), false);
  assert.equal(consumeTelegramPairing(db, telegramConnectionFor(db, ACCOUNT)!, second, "5", "Eve", now), true);

  assert.equal(telegramUpdateIsNew(db, ACCOUNT, 1), true);
  assert.equal(telegramUpdateIsNew(db, ACCOUNT, 1), false, "a repeated update is not new");
  assert.equal(telegramUpdateIsNew(db, ACCOUNT, 1, now + 8 * 24 * 60 * 60_000), true, "old ones are forgotten");
  removeTelegramConnection(db, ACCOUNT);
  assert.equal(telegramConnectionFor(db, ACCOUNT), undefined);
  assert.equal(telegramConnectionForUrlSecret(db, secrets.urlSecret), undefined);
});

test("only the linked account, in its own private chat, is read; anyone else is ignored and groups are left", () => {
  const db = database();
  const unlinked = connect(db, false).known;
  const linked = connect(database(), true).known;

  assert.deepEqual(readTelegramUpdate(linked, dm(PERSON, "hello")), { kind: "message", chatId: String(PERSON), text: "hello", voice: null });
  assert.deepEqual(readTelegramUpdate(linked, dm(PERSON, "/start")), { kind: "start", chatId: String(PERSON) });
  assert.deepEqual(readTelegramUpdate(linked, dm(PERSON, "", { photo: [{ file_id: "x" }], caption: "look" })), { kind: "message", chatId: String(PERSON), text: "look", voice: null });
  assert.deepEqual(readTelegramUpdate(linked, dm(PERSON, "", { voice: { file_id: "v1", file_size: 900, mime_type: "audio/ogg" } })), { kind: "message", chatId: String(PERSON), text: "", voice: { fileId: "v1", name: "voice.ogg", mimeType: "audio/ogg", bytes: 900 } });
  assert.equal((readTelegramUpdate(linked, dm(PERSON, "", { voice: { file_id: "v1", mime_type: "not a type" } })) as { voice: { mimeType: string } }).voice.mimeType, "audio/ogg", "a claimed type that is not plausible is replaced");

  // Nobody else gets anything: another account, a message that is not in the person's own chat, a bot.
  assert.deepEqual(readTelegramUpdate(linked, dm(STRANGER, "hello")), { kind: "ignore" });
  assert.deepEqual(readTelegramUpdate(linked, dm(STRANGER, "hello", {}, PERSON)), { kind: "ignore" }, "someone else writing in the person's chat id");
  assert.deepEqual(readTelegramUpdate(linked, dm(PERSON, "hello", {}, STRANGER)), { kind: "ignore" }, "the person's id in another private chat");
  assert.deepEqual(readTelegramUpdate(linked, dm(PERSON, "hello", { from: { id: PERSON, is_bot: true } })), { kind: "ignore" });
  assert.deepEqual(readTelegramUpdate(unlinked, dm(PERSON, "hello")), { kind: "ignore" }, "until an account is linked, nobody is answered");
  assert.deepEqual(readTelegramUpdate(linked, { edited_message: dm(PERSON, "hello").message }), { kind: "ignore" });
  assert.deepEqual(readTelegramUpdate(linked, { message: { text: "no sender" } }), { kind: "ignore" });
  assert.deepEqual(readTelegramUpdate(linked, "nonsense"), { kind: "ignore" });

  // A group is left whoever speaks in it, the person included, and a bot put into a group or channel leaves at once.
  assert.deepEqual(readTelegramUpdate(linked, inGroup(STRANGER, "@bob_bot hi")), { kind: "leave", chatId: String(GROUP) });
  assert.deepEqual(readTelegramUpdate(linked, inGroup(PERSON, "@bob_bot hi")), { kind: "leave", chatId: String(GROUP) });
  assert.deepEqual(readTelegramUpdate(unlinked, inGroup(STRANGER, "hi")), { kind: "leave", chatId: String(GROUP) });
  const added = (from: number, status: string, type = "supergroup") => ({ my_chat_member: { chat: { id: GROUP, type, title: "Family" }, from: { id: from }, new_chat_member: { status, user: { id: 9000 } } } });
  assert.deepEqual(readTelegramUpdate(linked, added(STRANGER, "member")), { kind: "leave", chatId: String(GROUP) });
  assert.deepEqual(readTelegramUpdate(linked, added(PERSON, "administrator")), { kind: "leave", chatId: String(GROUP) }, "even when the person adds it");
  assert.deepEqual(readTelegramUpdate(linked, added(STRANGER, "administrator", "channel")), { kind: "leave", chatId: String(GROUP) });
  assert.deepEqual(readTelegramUpdate(linked, added(STRANGER, "left")), { kind: "ignore" });
  assert.deepEqual(readTelegramUpdate(linked, { my_chat_member: { chat: { id: STRANGER, type: "private" }, from: { id: STRANGER }, new_chat_member: { status: "kicked" } } }), { kind: "ignore" });

  // Buttons: only the person's, on a message in their own chat.
  assert.deepEqual(readTelegramUpdate(linked, press(PERSON, "b:x:0")), { kind: "callback", callbackId: "cb-1", chatId: String(PERSON), messageId: 55, data: "b:x:0" });
  assert.deepEqual(readTelegramUpdate(linked, press(STRANGER, "b:x:0")), { kind: "ignore" });
  assert.deepEqual(readTelegramUpdate(unlinked, press(PERSON, "b:x:0")), { kind: "ignore" });
  assert.deepEqual(readTelegramUpdate(linked, { callback_query: { id: "c", from: { id: PERSON }, data: "x" } }), { kind: "ignore" }, "a press that names no message");
  assert.deepEqual(readTelegramUpdate(linked, { callback_query: { id: "c", from: { id: PERSON }, data: "x", message: { message_id: 1, chat: { id: GROUP, type: "group" } } } }), { kind: "leave", chatId: String(GROUP) });

  // The one-time link is read from anyone in a private chat; whether it works is for the stored code to say.
  assert.deepEqual(readTelegramUpdate(unlinked, dm(STRANGER, "/start abc123_-")), { kind: "link", chatId: String(STRANGER), userId: String(STRANGER), name: `User${STRANGER}`, code: "abc123_-" });
  assert.deepEqual(readTelegramUpdate(linked, dm(STRANGER, "/start@bob_bot code1")), { kind: "link", chatId: String(STRANGER), userId: String(STRANGER), name: `User${STRANGER}`, code: "code1" });
  assert.deepEqual(readTelegramUpdate(unlinked, inGroup(STRANGER, "/start code1")), { kind: "leave", chatId: String(GROUP) }, "never from a group");
});

test("a text message goes to Bob as the person and Bob's reply, with its buttons, comes back as the answer", async () => {
  const world = setUp();
  const stop = startTelegramPush(async () => world.deps);
  try {
    await handleTelegramUpdate(world.deps, world.known, update(dm(PERSON, "  what is running in dak?  ")));
    assert.deepEqual(world.asked, ["what is running in dak?"]);
    assert.equal(world.outside.sent.length, 1, "Bob's reply is the answer; it is not also pushed as news");
    const [answer] = world.outside.sent;
    assert.equal(answer.chatId, String(PERSON));
    assert.equal(answer.text, "Echo: what is running in dak?");
    const reply = [...world.db.prepare("SELECT id FROM control_center_bob_messages WHERE role='bob'").all() as Array<{ id: string }>][0];
    assert.deepEqual(answer.keyboard, { inline_keyboard: [[
      { text: "Go", callback_data: `b:${reply.id}:0` },
      { text: "Open", url: "https://bob.example.com/?projectId=p1&sessionId=c1" },
    ]] });
    assert.ok(world.outside.calls.includes("typing"), "it shows that Bob is working");
  } finally { stop(); }
});

test("a sender who is not the linked person gets no answer at all, a group is left and a repeated update runs once", async () => {
  const world = setUp();
  const handle = (body: Record<string, unknown>, known = world.known) => handleTelegramUpdate(world.deps, known, update(body));

  await handle(dm(STRANGER, "let me in"));
  await handle(dm(STRANGER, "/start wrong-code"));
  await handle(dm(STRANGER, "hello", {}, PERSON));
  await handle(press(STRANGER, "b:00000000-0000-0000-0000-000000000000:0"));
  assert.deepEqual(world.outside.calls, [], "nothing is sent to a stranger, not even a refusal");
  assert.deepEqual(world.asked, []);

  await handle(inGroup(STRANGER, "@bob_bot hello"));
  await handle(inGroup(PERSON, "@bob_bot hello"));
  await handle({ my_chat_member: { chat: { id: -600, type: "supergroup", title: "Strangers" }, from: { id: STRANGER }, new_chat_member: { status: "member" } } });
  assert.deepEqual(world.outside.calls, [`leave ${GROUP}`, `leave ${GROUP}`, "leave -600"]);
  assert.deepEqual(world.asked, [], "a group is never answered");

  const once = { update_id: 4242, ...dm(PERSON, "only once") };
  await handleTelegramUpdate(world.deps, world.known, once);
  await handleTelegramUpdate(world.deps, world.known, once);
  assert.deepEqual(world.asked, ["only once"]);

  // An account that is switched off, or gone from this machine, gets no answer either.
  const gone = { ...world.deps, session: () => null };
  await handleTelegramUpdate(gone, world.known, update(dm(PERSON, "anyone there?")));
  assert.deepEqual(world.asked, ["only once"]);
});

test("the one-time link links the account that opens it, tells the page, and a wrong or reused link does nothing", async () => {
  const world = setUp({ linked: false });
  const code = issueTelegramPairing(world.db, ACCOUNT);
  const waiting = telegramConnectionFor(world.db, ACCOUNT)!;

  await handleTelegramUpdate(world.deps, waiting, update(dm(STRANGER, "/start not-the-code")));
  assert.equal(telegramConnectionFor(world.db, ACCOUNT)!.telegramUserId, null);
  assert.deepEqual(world.outside.calls, [], "a wrong code gets no answer");

  await handleTelegramUpdate(world.deps, waiting, update(dm(PERSON, `/start ${code}`)));
  assert.equal(telegramConnectionFor(world.db, ACCOUNT)!.telegramUserId, String(PERSON));
  assert.deepEqual(world.changed, [ACCOUNT]);
  assert.match(world.outside.sent[0].text, /^Connected\./);
  assert.equal(world.outside.sent[0].chatId, String(PERSON));

  // The code is spent: someone else opening it is ignored, and the person stays linked.
  await handleTelegramUpdate(world.deps, telegramConnectionFor(world.db, ACCOUNT)!, update(dm(STRANGER, `/start ${code}`)));
  assert.equal(telegramConnectionFor(world.db, ACCOUNT)!.telegramUserId, String(PERSON));
  assert.equal(world.outside.sent.length, 1);

  // Linked, the person is answered. Before, they were not.
  await handleTelegramUpdate(world.deps, telegramConnectionFor(world.db, ACCOUNT)!, update(dm(PERSON, "hello")));
  assert.deepEqual(world.asked, ["hello"]);
});

test("a voice message is answered with a request to type it, and Bob is not asked", async () => {
  const world = setUp();
  await handleTelegramUpdate(world.deps, world.known, update(dm(PERSON, "", { voice: { file_id: "v1", file_size: 1200, mime_type: "audio/ogg" }, caption: "for dak" })));
  assert.match(world.outside.sent[0].text, /can't listen to voice messages yet/);
  assert.deepEqual(world.asked, [], "a caption alone is not what was said");

  // Something Bob cannot read is said so, kindly.
  const sent = world.outside.sent.length;
  await handleTelegramUpdate(world.deps, world.known, update(dm(PERSON, "", { sticker: { emoji: "x" } })));
  assert.match(world.outside.sent[sent].text, /I read text messages/);
});

test("a failing answer is told to the person, not hidden", async () => {
  const world = setUp();
  const broken = { ...world.deps, ask: async () => { throw new Error("No harness is set up"); } };
  await handleTelegramUpdate(broken, world.known, update(dm(PERSON, "hello")));
  assert.equal(world.outside.sent.at(-1)!.text, "I could not answer: No harness is set up");
});

test("a button runs once as the person, the buttons are replaced while it runs, and they come back if it fails", async () => {
  const world = setUp();
  const message = appendBobMessage(world.db, ACCOUNT, { role: "system", text: "Guardian asks", importance: "needs-ok", actions: [{ id: "test.allow", label: "Allow once", style: "warn" }, { id: "test.fail", label: "Fail" }] });

  await handleTelegramUpdate(world.deps, world.known, update(press(PERSON, callbackData(message.id, 0), 77)));
  assert.deepEqual(world.pressed, [{ messageId: message.id, actionId: "test.allow" }]);
  assert.deepEqual(world.outside.answers, [{ id: "cb-1" }], "the press is answered at once");
  assert.deepEqual(world.outside.keyboards.map((entry) => [entry.messageId, entry.keyboard?.inline_keyboard[0][0].text]), [[77, "Allow once…"], [77, "Done: Allow once"]]);
  assert.deepEqual(world.outside.sent.map((entry) => entry.text), ["Allowed once."], "what Bob answers goes back to the chat, in words");

  // A button that is gone (answered already, in the app or here) says so and loses its keyboard.
  world.pressed.length = 0;
  world.outside.answers.length = 0;
  world.outside.keyboards.length = 0;
  const spent = appendBobMessage(world.db, ACCOUNT, { role: "system", text: "Old", importance: "needs-ok", actions: [] });
  await handleTelegramUpdate(world.deps, world.known, update(press(PERSON, callbackData(spent.id, 0), 78)));
  assert.deepEqual(world.pressed, []);
  assert.deepEqual(world.outside.answers, [{ id: "cb-1", text: "That button is no longer available." }]);
  assert.deepEqual(world.outside.keyboards, [{ messageId: 78, keyboard: null }]);

  // A failure puts the buttons back and says what went wrong.
  world.outside.keyboards.length = 0;
  const sent = world.outside.sent.length;
  await handleTelegramUpdate(world.deps, world.known, update(press(PERSON, callbackData(message.id, 1), 79)));
  assert.equal(world.outside.keyboards.at(-1)!.keyboard?.inline_keyboard.flat().map((button) => button.text).join(","), "Allow once,Fail");
  assert.equal(world.outside.sent[sent].text, "I could not do that: it broke");

  // Data that is not one of Bob's buttons, such as a settled one, only stops the spinner.
  world.outside.answers.length = 0;
  await handleTelegramUpdate(world.deps, world.known, update(press(PERSON, "settled")));
  assert.deepEqual(world.outside.answers, [{ id: "cb-1" }]);
  assert.equal(getBobMessage(world.db, ACCOUNT, message.id)?.actions.length, 2, "nothing was run");
});

test("Bob's own messages go to Telegram when they matter, with their buttons, never while paused, and never twice", async () => {
  const world = setUp();
  const stop = startTelegramPush(async () => world.deps);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));
  try {
    for (const importance of ["fyi", "done"] as const) appendBobMessage(world.db, ACCOUNT, { role: "bob", text: `quiet ${importance}`, importance });
    appendBobMessage(world.db, ACCOUNT, { role: "user", text: "my own words", importance: "urgent" });
    await settle();
    assert.deepEqual(world.outside.sent, [], "fyi, done and the person's own messages stay in the app");

    const guardian = appendBobMessage(world.db, ACCOUNT, {
      role: "system", importance: "needs-ok", projectName: "Julian", text: "Force a new deployment\necs update-service", via: "Guardian · production or destructive steps always ask you.",
      actions: [{ id: "guardian.allow", label: "Allow once", style: "warn" }, { id: "guardian.block", label: "Block" }, { id: "open", label: "Open", data: { open: { projectId: "p1", conversationId: "c9" } } }],
    });
    for (const importance of ["urgent", "needs-you", "report"] as const) appendBobMessage(world.db, ACCOUNT, { role: "bob", text: `about ${importance}`, importance });
    await settle();
    assert.deepEqual(world.outside.sent.map((entry) => entry.chatId), Array(4).fill(String(PERSON)));
    assert.equal(world.outside.sent[0].text, "**Needs your OK · Julian**\n\nForce a new deployment\necs update-service\n\nGuardian · production or destructive steps always ask you.");
    assert.deepEqual(world.outside.sent[0].keyboard, { inline_keyboard: [
      [{ text: "Allow once", callback_data: `b:${guardian.id}:0` }, { text: "Block", callback_data: `b:${guardian.id}:1` }],
      [{ text: "Open", url: "https://bob.example.com/?projectId=p1&sessionId=c9" }],
    ] });
    assert.deepEqual(world.outside.sent.slice(1).map((entry) => entry.text), ["**Urgent**\n\nabout urgent", "**Needs you**\n\nabout needs-you", "**Report**\n\nabout report"], "in the order they happened");

    // Paused: nothing is pushed, and a direct message is still answered.
    const count = world.outside.sent.length;
    writeBobSettings(world.db, ACCOUNT, { monitoring: false });
    appendBobMessage(world.db, ACCOUNT, { role: "system", text: "Prod is down", importance: "urgent" });
    await settle();
    assert.equal(world.outside.sent.length, count);
    await handleTelegramUpdate(world.deps, world.known, update(dm(PERSON, "still there?")));
    assert.equal(world.outside.sent.at(-1)!.text, "Echo: still there?");
    writeBobSettings(world.db, ACCOUNT, { monitoring: true });

    // Disconnected, there is nowhere to send it.
    removeTelegramConnection(world.db, ACCOUNT);
    const before = world.outside.sent.length;
    appendBobMessage(world.db, ACCOUNT, { role: "system", text: "after disconnect", importance: "urgent" });
    await settle();
    assert.equal(world.outside.sent.length, before);
  } finally { stop(); }
});

test("a message that was waiting its turn is dropped when the bot is disconnected or linked to someone else meanwhile", async () => {
  const world = setUp();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slow = { ...world.deps, ask: async (session: AuthSession, text: string) => { await gate; return world.deps.ask(session, text); } };
  const first = handleTelegramUpdate(slow, world.known, update(dm(PERSON, "first")));
  const second = handleTelegramUpdate(slow, world.known, update(dm(PERSON, "second")));
  await new Promise((resolve) => setTimeout(resolve, 20));
  removeTelegramConnection(world.db, ACCOUNT);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(world.asked, ["first"], "the second message was refused because the bot was removed");
});

test("no exchange is open outside a Telegram answer", () => {
  assert.equal(duringTelegramExchange(ACCOUNT), false);
});

test("what is pushed, how buttons are laid out and which addresses Telegram can open", () => {
  for (const importance of ["needs-ok", "urgent", "needs-you", "report"] as const) assert.equal(wantsTelegramPush({ role: "bob", importance }), true, importance);
  for (const importance of ["fyi", "done"] as const) assert.equal(wantsTelegramPush({ role: "bob", importance }), false, importance);
  assert.equal(wantsTelegramPush({ role: "user", importance: "urgent" }), false);

  const id = "11111111-2222-3333-4444-555555555555";
  assert.deepEqual(parseCallbackData(callbackData(id, 3)), { messageId: id, index: 3 });
  assert.ok(Buffer.byteLength(callbackData(id, 99)) <= 64, "Telegram keeps a button's data to 64 bytes");
  for (const bad of ["", "settled", "b:short:1", `b:${id}:x`, `b:${id}:`, `x:${id}:1`]) assert.equal(parseCallbackData(bad), null, bad);

  const message = { id, actions: [{ id: "a", label: "One" }, { id: "b", label: "Two" }, { id: "c", label: "Three", data: { open: { projectId: "p", conversationId: "c" } } }, { id: "d", label: "Four", data: { open: {} } }] } as BobMessage;
  assert.deepEqual(keyboardFor(message, null)?.inline_keyboard, [[{ text: "One", callback_data: `b:${id}:0` }, { text: "Two", callback_data: `b:${id}:1` }]], "a link to the app is left out when it has no address");
  assert.deepEqual(keyboardFor(message, "https://bob.example.com")?.inline_keyboard, [
    [{ text: "One", callback_data: `b:${id}:0` }, { text: "Two", callback_data: `b:${id}:1` }],
    [{ text: "Three", url: "https://bob.example.com/?projectId=p&sessionId=c" }, { text: "Four", url: "https://bob.example.com/" }],
  ]);
  assert.equal(keyboardFor({ id, actions: [] }, "https://bob.example.com"), null);
  assert.equal(keyboardFor({ id, actions: [{ id: "x", label: "Open", data: { open: {} } }] }, null), null, "a message left with no buttons has no keyboard");

  assert.equal(pushedText({ importance: "report", projectName: null, text: "Morning report\n- all quiet", via: null }), "**Report**\n\nMorning report\n- all quiet");
  assert.equal(pushedText({ importance: "needs-you", projectName: "Joint *Bob*", text: "Auto respond stopped", via: "Auto respond ended" }), "**Needs you · Joint Bob**\n\nAuto respond stopped\n\nAuto respond ended");

  assert.equal(telegramReachableUrl("https://bob.example.com/anything?x=1"), "https://bob.example.com");
  for (const unreachable of [null, undefined, "", "not a url", "http://bob.example.com", "https://localhost:3000", "https://127.0.0.1", "https://192.168.1.4", "https://10.0.0.2"]) assert.equal(telegramReachableUrl(unreachable), null, String(unreachable));
});

// ── The client itself, against a local stand-in for Telegram ───────────────────────────────────────────────

const TOKEN = "123456:AAtestTOKENtestTOKENtestTOKEN";

async function localTelegram() {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const method = /^\/bot(.+?)\/(\w+)$/.exec(request.url ?? "");
      const json = (status: number, body: unknown) => response.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      if (!method || method[1] !== TOKEN) { json(401, { ok: false, description: "Unauthorized" }); return; }
      const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as Record<string, unknown>;
      calls.push({ method: method[2], body });
      if (method[2] === "sendMessage" && body.parse_mode === "HTML" && String(body.text).includes("REJECT")) { json(400, { ok: false, description: "Bad Request: can't parse entities" }); return; }
      if (method[2] === "sendMessage" && String(body.text).includes("NOPE")) { json(403, { ok: false, description: "Forbidden: bot was blocked by the user" }); return; }
      json(200, { ok: true, result: method[2] === "sendMessage" ? { message_id: 500 + calls.length } : true });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previous = process.env.JOINT_BOB_TELEGRAM_API;
  process.env.JOINT_BOB_TELEGRAM_API = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    calls,
    close: async () => {
      if (previous === undefined) delete process.env.JOINT_BOB_TELEGRAM_API; else process.env.JOINT_BOB_TELEGRAM_API = previous;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("long replies are split into messages that fit, the buttons go on the last, and refused formatting falls back to plain", async () => {
  const telegram = await localTelegram();
  try {
    const api = telegramApiFor(TOKEN);
    const paragraphs = Array.from({ length: 12 }, (_, index) => `Paragraph ${index}: ${"word ".repeat(150)}`.trim());
    const keyboard: InlineKeyboard = { inline_keyboard: [[{ text: "Go", callback_data: "b:x:0" }]] };
    const ids = await api.send("111", paragraphs.join("\n\n"), keyboard);
    const sends = telegram.calls.filter((call) => call.method === "sendMessage");
    assert.ok(sends.length >= 2, "it was split");
    assert.equal(ids.length, sends.length);
    for (const send of sends) assert.ok(String(send.body.text).length <= 4096, "each part fits Telegram's limit");
    assert.deepEqual(sends.map((send) => "reply_markup" in send.body), sends.map((_, index) => index === sends.length - 1), "only the last message carries the buttons");
    assert.equal(sends[0].body.parse_mode, "HTML");
    assert.equal(sends.every((send) => send.body.chat_id === "111"), true);
    assert.equal(sends.map((send) => String(send.body.text)).join(" ").includes("Paragraph 11"), true, "nothing is lost");

    // Markdown is shown as Telegram formatting; text Telegram refuses to format is sent plain.
    telegram.calls.length = 0;
    await api.send("111", "**Done** REJECT <b>", keyboard);
    assert.deepEqual(telegram.calls.map((call) => [call.method, call.body.parse_mode ?? "plain"]), [["sendMessage", "HTML"], ["sendMessage", "plain"]]);
    assert.equal(telegram.calls[1].body.text, "**Done** REJECT <b>");
    assert.ok(telegram.calls[1].body.reply_markup, "the plain copy has the buttons too");

    // An empty reply still says something; a refusal is an error, with Telegram's reason and without the token.
    telegram.calls.length = 0;
    await api.send("111", "   ");
    assert.equal(telegram.calls[0].body.text, "(nothing to say)");
    await assert.rejects(api.send("111", "NOPE"), (error: Error) => /blocked by the user/.test(error.message) && !error.message.includes(TOKEN));

    telegram.calls.length = 0;
    await api.answerCallback("cb", "x".repeat(300));
    await api.setKeyboard("111", 7, null);
    await api.typing("111");
    assert.equal(String(telegram.calls[0].body.text).length, 200);
    assert.deepEqual(telegram.calls[1].body, { chat_id: "111", message_id: 7, reply_markup: { inline_keyboard: [] } });
    assert.deepEqual(telegram.calls[2].body, { chat_id: "111", action: "typing" });
    await assert.rejects(telegramApiFor("1:wrongwrongwrongwrongwrong").typing("111"), /Telegram refused sendChatAction: Unauthorized/);
  } finally { await telegram.close(); }
});
