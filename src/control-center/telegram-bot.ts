import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { AuthSession } from "../auth.js";
import { getBobMessage, onBobMessage, readBobSettings, type BobMessage } from "./bob-store.js";
import type { TelegramApi } from "./telegram-api.js";
import { keyboardFor, parseCallbackData, pushedText, SETTLED_BUTTON, wantsTelegramPush } from "./telegram-format.js";
import { consumeTelegramPairing, telegramConnectionFor, telegramPairingPending, telegramUpdateIsNew, type TelegramConnection } from "./telegram-store.js";
import { readTelegramUpdate, type TelegramVerdict } from "./telegram-updates.js";

/**
 * Bob's Telegram bot at work. `readTelegramUpdate` has already decided who may do anything; what is left is what the
 * person's messages and button presses do (the same as in Bob's chat, as the person), and which of Bob's own messages go
 * to Telegram without being asked for.
 */

/** The longest message Bob's chat takes. */
const MAX_MESSAGE = 8000;
const TYPING_REFRESH_MS = 4500;

export interface BotDeps {
  db: DatabaseSync;
  api(known: TelegramConnection): TelegramApi;
  /** The person as a session on this machine, or null when their account is gone or switched off. */
  session(accountId: string): AuthSession | null;
  /** Bob's front door, as the person: Bob's reply to what they said. */
  ask(session: AuthSession, text: string): Promise<BobMessage>;
  /** What a button on one of Bob's messages does, as the person. */
  press(session: AuthSession, messageId: string, actionId: string): Promise<BobMessage[]>;
  /** Where the app can be opened from outside, when it is known. */
  appUrl(): Promise<string | null>;
  /** Tells the person's open pages that the link changed. */
  changed(accountId: string): void;
}

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\d+:[A-Za-z0-9_-]{20,}/g, "[token]").replace(/\s+/g, " ").slice(0, 300);

// ── Order ──────────────────────────────────────────────────────────────────────────────────────────────────

const queues = new Map<string, Promise<unknown>>();

/** Runs work after everything earlier under the same key, whether that worked or not. */
function inOrder(key: string, work: () => Promise<void>): Promise<void> {
  const mine = (queues.get(key) ?? Promise.resolve()).then(work);
  const settled = mine.catch(() => undefined);
  queues.set(key, settled);
  void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
  return mine;
}

// ── Telegram exchanges: what Bob says in answer to the person is sent as the answer, not pushed again ───────

interface Exchange { accountId: string; open: boolean }
const exchanges = new AsyncLocalStorage<Exchange>();

/** Everything added to the person's timeline while this runs is part of the answer, so it is not also pushed. */
async function inTelegramExchange<T>(accountId: string, work: () => Promise<T>): Promise<T> {
  const exchange: Exchange = { accountId, open: true };
  try { return await exchanges.run(exchange, work); } finally { exchange.open = false; }
}

export function duringTelegramExchange(accountId: string): boolean {
  const exchange = exchanges.getStore();
  return exchange?.open === true && exchange.accountId === accountId;
}

/** Shows "typing" while the work takes. */
async function whileTyping<T>(api: TelegramApi, chatId: string, work: () => Promise<T>): Promise<T> {
  const show = (): void => { void api.typing(chatId).catch(() => undefined); };
  show();
  const timer = setInterval(show, TYPING_REFRESH_MS);
  try { return await work(); } finally { clearInterval(timer); }
}

// ── What the person says ───────────────────────────────────────────────────────────────────────────────────

async function answerMessage(deps: BotDeps, known: TelegramConnection, api: TelegramApi, verdict: Extract<TelegramVerdict, { kind: "message" }>): Promise<void> {
  const session = deps.session(known.accountId);
  if (!session) return;
  // Voice needs speech to text, which this build does not have yet; acting on a caption alone could miss what was said.
  if (verdict.voice) { await api.send(verdict.chatId, "I can't listen to voice messages yet. Type it, please."); return; }
  const text = verdict.text.trim();
  if (!text) { await api.send(verdict.chatId, "I read text messages. Send me one."); return; }
  let reply: BobMessage;
  try { reply = await inTelegramExchange(known.accountId, () => whileTyping(api, verdict.chatId, () => deps.ask(session, text.slice(0, MAX_MESSAGE)))); }
  catch (error) { await api.send(verdict.chatId, `I could not answer: ${reason(error)}`); return; }
  await api.send(verdict.chatId, reply.text, keyboardFor(reply, await deps.appUrl()));
}

// ── What the person presses ────────────────────────────────────────────────────────────────────────────────

const settled = (label: string) => ({ inline_keyboard: [[{ text: label, callback_data: SETTLED_BUTTON }]] });

async function pressButton(deps: BotDeps, known: TelegramConnection, api: TelegramApi, verdict: Extract<TelegramVerdict, { kind: "callback" }>): Promise<void> {
  const session = deps.session(known.accountId);
  const target = parseCallbackData(verdict.data);
  if (!session || !target) { await api.answerCallback(verdict.callbackId); return; }
  const message = getBobMessage(deps.db, known.accountId, target.messageId);
  const action = message?.actions[target.index];
  if (!message || !action) {
    await api.answerCallback(verdict.callbackId, "That button is no longer available.");
    await api.setKeyboard(verdict.chatId, verdict.messageId, null);
    return;
  }
  await api.answerCallback(verdict.callbackId);
  // The buttons go at once, so a second tap cannot run it again; they come back if it did not happen.
  await api.setKeyboard(verdict.chatId, verdict.messageId, settled(`${action.label}…`));
  let results: BobMessage[];
  try { results = await inTelegramExchange(known.accountId, () => whileTyping(api, verdict.chatId, () => deps.press(session, message.id, action.id))); }
  catch (error) {
    await api.setKeyboard(verdict.chatId, verdict.messageId, keyboardFor(message, await deps.appUrl()));
    await api.send(verdict.chatId, `I could not do that: ${reason(error)}`);
    return;
  }
  await api.setKeyboard(verdict.chatId, verdict.messageId, settled(`Done: ${action.label}`));
  for (const result of results) if (result.role !== "user") await api.send(verdict.chatId, result.text, keyboardFor(result, await deps.appUrl()));
}

// ── Updates ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Handles one update that arrived with the right secrets. Anyone but the linked person gets no answer, and a group is left.
 * Resolves when the update has been dealt with; an error is Telegram or Bob failing, never a reply to the sender.
 */
export async function handleTelegramUpdate(deps: BotDeps, known: TelegramConnection, update: unknown): Promise<void> {
  const verdict = readTelegramUpdate(known, update);
  if (verdict.kind === "ignore") return;
  const api = deps.api(known);
  if (verdict.kind === "leave") { await api.leave(verdict.chatId); return; }
  const updateId = (update as { update_id?: unknown }).update_id;
  if (typeof updateId !== "number") return;
  if (verdict.kind === "link") {
    // Without a link waiting, the code is nothing; a stranger's guess costs nothing and records nothing.
    if (!telegramPairingPending(known) || !telegramUpdateIsNew(deps.db, known.accountId, updateId)) return;
    if (!consumeTelegramPairing(deps.db, known, verdict.code, verdict.userId, verdict.name)) return;
    deps.changed(known.accountId);
    await api.send(verdict.chatId, "Connected. This is your chat with Bob: ask about any project, give it tasks, answer its questions and approve or block what it asks. Nobody else gets an answer from this bot.");
    return;
  }
  if (!telegramUpdateIsNew(deps.db, known.accountId, updateId)) return;
  if (verdict.kind === "callback") { await pressButton(deps, known, api, verdict); return; }
  await inOrder(`chat:${known.accountId}`, async () => {
    // Removed or linked to someone else while this waited its turn: it applies to this message too.
    const now = telegramConnectionFor(deps.db, known.accountId);
    if (!now || now.telegramUserId !== known.telegramUserId) return;
    if (verdict.kind === "start") await api.send(verdict.chatId, "You're connected. Send a message; the buttons on mine work here too.");
    else await answerMessage(deps, now, api, verdict);
  });
}

// ── What Bob says on its own ───────────────────────────────────────────────────────────────────────────────

/** Sends a message of the person's timeline to their Telegram when it matters, unless they paused Bob. */
export async function pushToTelegram(deps: BotDeps, accountId: string, message: BobMessage): Promise<void> {
  if (!wantsTelegramPush(message) || !readBobSettings(deps.db, accountId).monitoring) return;
  await inOrder(`push:${accountId}`, async () => {
    const known = telegramConnectionFor(deps.db, accountId);
    if (!known?.telegramUserId) return;
    await deps.api(known).send(known.telegramUserId, pushedText(message), keyboardFor(message, await deps.appUrl()));
  });
}

/** Starts sending the person's new timeline messages to Telegram. Returns what stops it. */
export function startTelegramPush(deps: () => Promise<BotDeps>): () => void {
  return onBobMessage((accountId, message) => {
    // Read here, while the message is still being added: an answer to the person is not also pushed.
    if (duringTelegramExchange(accountId) || !wantsTelegramPush(message)) return;
    void deps().then((ready) => pushToTelegram(ready, accountId, message)).catch((error) => console.warn("Bob could not send a message to Telegram:", reason(error)));
  });
}
