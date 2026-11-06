import type { IncomingMessage, ServerResponse } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { actingAccountFromSession, runAsAccount } from "../account-context.js";
import { telegramBotInUse } from "../assistant-telegram.js";
import type { AuthSession } from "../auth.js";
import { bobSessionFor } from "./control-center-session.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { getClusterNode } from "../cluster.js";
import { runBobAction } from "../control-center/bob-actions.js";
import { bobDatabase } from "../control-center/bob-store.js";
import { telegramApiFor, setBobWebhook } from "../control-center/telegram-api.js";
import { handleTelegramUpdate, startTelegramPush, type BotDeps } from "../control-center/telegram-bot.js";
import { telegramReachableUrl } from "../control-center/telegram-format.js";
import {
  BOT_URL_PREFIX, ensureTelegramSchema, issueTelegramPairing, newTelegramSecrets, removeTelegramConnection, saveTelegramConnection, telegramBotIsBobs, telegramConnectionFor,
  telegramConnectionForUrlSecret, telegramHeaderValid, telegramPairingPending, type TelegramConnection,
} from "../control-center/telegram-store.js";
import { phoneAddress } from "../relay/protocol.js";
import { relayMachine } from "../relay/store.js";
import { relayRuntimeInstance, relayServerInstance } from "../relay/index.js";
import { deleteSecretAccount, saveSecretAccount, secretAccountVariable } from "../secrets.js";
import { telegramBot, telegramDeleteWebhook, TELEGRAM_TOKEN_VARIABLE } from "../webhook-telegram.js";
import { handleBobMessage } from "./bob.js";
import { broadcastToAllClients } from "./realtime.js";
import { urlBases } from "./routes/webhooks.js";
import { flags, requestInterceptors } from "./state.js";

/** Bob's Telegram bot on this machine: connecting it, the address Telegram calls, and what is wired to Bob's chat. */

export class TelegramConnectError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const withoutToken = (error: unknown, token: string): string => (error instanceof Error ? error.message : String(error)).split(token).join("[token]");
/** For the log, where the bot's token may not be at hand: anything shaped like one is hidden. */
const withoutAnyToken = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\d+:[A-Za-z0-9_-]{20,}/g, "[token]");

async function telegramDatabase(): Promise<DatabaseSync> {
  const db = await bobDatabase();
  ensureTelegramSchema(db);
  return db;
}

/** The person as a session here. Null when they have no account on this machine, or it is switched off. */
export const sessionForTelegram = (accountId: string): AuthSession | null => bobSessionFor(accountId, "telegram");

const asPerson = <T>(session: AuthSession, work: () => Promise<T>): Promise<T> => runAsAccount(actingAccountFromSession(session), work);

function botToken(known: TelegramConnection): string {
  const token = secretAccountVariable([known.tokenAccountId], TELEGRAM_TOKEN_VARIABLE);
  if (!token) throw new Error("Bob's bot token is no longer saved. Connect Telegram again.");
  return token;
}

/** Where the app can be opened from outside: this machine's own address or its relay address, when one is secure and public. */
async function appAddress(): Promise<string | null> {
  const node = await getClusterNode();
  const own = telegramReachableUrl(node.url);
  if (own) return own;
  const db = await clusterV2Database();
  const server = relayServerInstance();
  const self = server?.enabled ? relayMachine(db, node.id) : undefined;
  if (server?.enabled && self?.status === "admitted") return telegramReachableUrl(phoneAddress(server.origin, self.name));
  const joined = relayRuntimeInstance()?.status().find((item) => item.status === "admitted" && item.name);
  return joined ? telegramReachableUrl(phoneAddress(joined.origin, joined.name!)) : null;
}

async function botDeps(): Promise<BotDeps> {
  const db = await telegramDatabase();
  return {
    db,
    api: (known) => telegramApiFor(botToken(known)),
    session: sessionForTelegram,
    ask: async (session, text) => (await asPerson(session, () => handleBobMessage(session, { message: text }))).reply,
    press: (session, messageId, actionId) => asPerson(session, () => runBobAction(db, session, messageId, actionId)),
    appUrl: appAddress,
    changed: (accountId) => broadcastToAllClients({ type: "controlCenterChanged" }, accountId),
  };
}

// ── Connecting, from Bob's settings ────────────────────────────────────────────────────────────────────────

const pairingLink = (known: Pick<TelegramConnection, "botUsername">, code: string): string => `https://t.me/${known.botUsername}?start=${code}`;

export async function telegramStatus(accountId: string) {
  const db = await telegramDatabase();
  const known = telegramConnectionFor(db, accountId);
  if (!known) return { connected: false as const, bases: (await urlBases()).map(({ id, label }) => ({ id, label })) };
  return {
    connected: true as const, botUsername: known.botUsername,
    linked: known.telegramUserId ? { id: known.telegramUserId, name: known.telegramName ?? known.telegramUserId } : null,
    linkWaiting: telegramPairingPending(known),
  };
}

export async function connectBobTelegram(session: AuthSession, token: string, baseId: string | undefined) {
  const db = await telegramDatabase();
  if (!sessionForTelegram(session.accountId)) throw new TelegramConnectError(409, "Telegram can be connected only by a person with an account on this machine.");
  if (telegramConnectionFor(db, session.accountId)) throw new TelegramConnectError(409, "Bob already has a Telegram bot. Disconnect it first.");
  const bases = await urlBases();
  const base = baseId ? bases.find((item) => item.id === baseId) : bases[0];
  if (!base) throw new TelegramConnectError(409, "This machine has no address Telegram can reach. Join a relay in Settings → Relays first.");
  let bot: Awaited<ReturnType<typeof telegramBot>>;
  try { bot = await telegramBot(token); }
  catch (error) {
    const why = withoutToken(error, token);
    throw /unauthorized|not found/i.test(why)
      ? new TelegramConnectError(400, "Telegram didn't accept this token. Copy it again from @BotFather.")
      : new TelegramConnectError(502, `Telegram couldn't be reached: ${why}`);
  }
  // One bot, one address: Telegram sends a bot's messages to a single webhook.
  if (telegramBotIsBobs(db, bot.id) || telegramBotInUse(db, bot.id)) throw new TelegramConnectError(409, `@${bot.username} is already connected. Disconnect it there first, or create another bot.`);
  const account = await saveSecretAccount({ label: `Bob's Telegram bot @${bot.username}`, provider: "custom", replicate: false, variables: [{ name: TELEGRAM_TOKEN_VARIABLE, kind: "value", value: token }] });
  const secrets = newTelegramSecrets();
  try { await setBobWebhook(token, `${base.base}/${secrets.urlSecret}`, secrets.headerSecret); }
  catch (error) {
    await deleteSecretAccount(account.id);
    throw new TelegramConnectError(502, `Telegram refused the address ${base.label}: ${withoutToken(error, token)}`);
  }
  saveTelegramConnection(db, { accountId: session.accountId, tokenAccountId: account.id, botId: bot.id, botUsername: bot.username, ...secrets });
  const code = issueTelegramPairing(db, session.accountId);
  return { ...await telegramStatus(session.accountId), pairingLink: pairingLink({ botUsername: bot.username }, code) };
}

/** A fresh one-time link, to link another Telegram account or the same one again. The linked account stays until the link is used. */
export async function newBobTelegramPairing(accountId: string) {
  const db = await telegramDatabase();
  const known = telegramConnectionFor(db, accountId);
  if (!known) throw new TelegramConnectError(404, "Bob has no Telegram bot");
  const code = issueTelegramPairing(db, accountId);
  return { ...await telegramStatus(accountId), pairingLink: pairingLink(known, code) };
}

export async function disconnectBobTelegram(accountId: string): Promise<boolean> {
  const db = await telegramDatabase();
  const known = telegramConnectionFor(db, accountId);
  if (!known) return false;
  const token = secretAccountVariable([known.tokenAccountId], TELEGRAM_TOKEN_VARIABLE);
  // Removed here whatever Telegram says: without the connection its calls are refused.
  removeTelegramConnection(db, accountId);
  if (token) await telegramDeleteWebhook(token).catch((error: unknown) => console.warn("Telegram kept Bob's webhook:", withoutToken(error, token)));
  await deleteSecretAccount(known.tokenAccountId).catch((error: unknown) => console.warn("Bob's bot secret account stayed:", error instanceof Error ? error.message : error));
  return true;
}

// ── Telegram's calls ───────────────────────────────────────────────────────────────────────────────────────

const BOT_HOOK_PATH = new RegExp(`^/hooks/(${BOT_URL_PREFIX}[A-Za-z0-9_-]{20,100})$`);
const MAX_UPDATE_BYTES = 256 * 1024;

function reply(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Connection: "close" }).end(text);
}

/** Reads the body, giving up past the cap. Resolves undefined when Telegram sent too much. */
function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_UPDATE_BYTES) { chunks.length = 0; request.removeAllListeners("data"); request.resume(); resolve(undefined); return; }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function receive(request: IncomingMessage, response: ServerResponse, secret: string): Promise<void> {
  if (request.method !== "POST") { request.resume(); reply(response, 405, "POST only"); return; }
  if (!flags.startupReady) { request.resume(); reply(response, 503, "Starting up; try again shortly"); return; }
  const deps = await botDeps();
  const known = telegramConnectionForUrlSecret(deps.db, secret);
  if (!known) { request.resume(); reply(response, 404, "Not found"); return; }
  // Nothing is read from a call that does not prove it comes from Telegram.
  if (!telegramHeaderValid(known, request.headers["x-telegram-bot-api-secret-token"])) { request.resume(); reply(response, 401, "Unauthorized"); return; }
  const body = await readBody(request);
  if (body === undefined) { reply(response, 413, "Payload too large"); return; }
  let update: unknown;
  try { update = JSON.parse(body.toString("utf8")); } catch { reply(response, 400, "Not JSON"); return; }
  // Answered at once, so Telegram does not retry while Bob works.
  response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store", Connection: "close" }).end("{}");
  void handleTelegramUpdate(deps, known, update).catch((error: unknown) => console.warn("Bob's Telegram update failed:", withoutAnyToken(error)));
}

// Ahead of the webhook handler, which would answer any /hooks/ address itself.
requestInterceptors.unshift((request, response) => {
  const match = BOT_HOOK_PATH.exec((request.url ?? "").split("?", 1)[0]);
  if (!match) return false;
  receive(request, response, match[1]).catch((error: unknown) => {
    console.warn("Bob's Telegram call failed:", error instanceof Error ? error.message : error);
    if (!response.headersSent) reply(response, 500, "Failed");
    else response.destroy();
  });
  return true;
});

startTelegramPush(botDeps);
