import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Bob's own Telegram bot, one per person. The record says which bot it is, which Telegram account is the person (linked
 * with a one-time code) and how Telegram proves a call is its own. The bot's token is not here: it is in a secret
 * account, which no agent or page can read.
 */

/** Marks the secret in the bot's webhook address, so the address can be recognised without a lookup. */
export const BOT_URL_PREFIX = "bobtelegram-";
const PAIRING_LIFETIME_MS = 10 * 60_000;
const KEPT_UPDATES_MS = 7 * 24 * 60 * 60_000;

export interface TelegramConnection {
  accountId: string;
  tokenAccountId: string;
  botId: string;
  botUsername: string;
  urlSecretHash: string;
  headerSecretHash: string;
  /** The Telegram account the bot answers; its private chat has the same id. Null until the link is used. */
  telegramUserId: string | null;
  telegramName: string | null;
  pairingHash: string | null;
  pairingExpiresAt: number | null;
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const COLUMNS = "account_id accountId, token_account_id tokenAccountId, bot_id botId, bot_username botUsername, url_secret_hash urlSecretHash, header_secret_hash headerSecretHash, telegram_user_id telegramUserId, telegram_name telegramName, pairing_hash pairingHash, pairing_expires_at pairingExpiresAt";

export function ensureTelegramSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS control_center_telegram (
    account_id TEXT PRIMARY KEY, token_account_id TEXT NOT NULL, bot_id TEXT NOT NULL UNIQUE, bot_username TEXT NOT NULL,
    url_secret_hash TEXT NOT NULL UNIQUE, header_secret_hash TEXT NOT NULL, telegram_user_id TEXT, telegram_name TEXT,
    pairing_hash TEXT, pairing_expires_at INTEGER, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS control_center_telegram_updates (account_id TEXT NOT NULL, update_id INTEGER NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(account_id, update_id));`);
}

export function telegramConnectionFor(db: DatabaseSync, accountId: string): TelegramConnection | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM control_center_telegram WHERE account_id=?`).get(accountId) as TelegramConnection | undefined;
}

/** The connection whose webhook address holds this secret. Only a hash of each secret is kept. */
export function telegramConnectionForUrlSecret(db: DatabaseSync, secret: string): TelegramConnection | undefined {
  return db.prepare(`SELECT ${COLUMNS} FROM control_center_telegram WHERE url_secret_hash=?`).get(sha256(secret)) as TelegramConnection | undefined;
}

export function telegramBotIsBobs(db: DatabaseSync, botId: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM control_center_telegram WHERE bot_id=?").get(botId));
}

/** The two secrets Telegram is given when the webhook is set: one in the address, one it must send with every call. */
export function newTelegramSecrets(): { urlSecret: string; headerSecret: string } {
  return { urlSecret: `${BOT_URL_PREFIX}${randomBytes(32).toString("base64url")}`, headerSecret: randomBytes(32).toString("hex") };
}

export function saveTelegramConnection(db: DatabaseSync, input: { accountId: string; tokenAccountId: string; botId: string; botUsername: string; urlSecret: string; headerSecret: string }): void {
  db.prepare("INSERT INTO control_center_telegram (account_id, token_account_id, bot_id, bot_username, url_secret_hash, header_secret_hash, created_at) VALUES (?,?,?,?,?,?,?)")
    .run(input.accountId, input.tokenAccountId, input.botId, input.botUsername, sha256(input.urlSecret), sha256(input.headerSecret), new Date().toISOString());
}

/** Takes the bot away from the person. Its next call finds no connection and is refused. */
export function removeTelegramConnection(db: DatabaseSync, accountId: string): void {
  db.prepare("DELETE FROM control_center_telegram WHERE account_id=?").run(accountId);
  db.prepare("DELETE FROM control_center_telegram_updates WHERE account_id=?").run(accountId);
}

export function telegramHeaderValid(known: TelegramConnection, header: unknown): boolean {
  if (typeof header !== "string" || !header) return false;
  return timingSafeEqual(Buffer.from(sha256(header)), Buffer.from(known.headerSecretHash));
}

/** A new one-time code for linking a Telegram account. It replaces any earlier code. */
export function issueTelegramPairing(db: DatabaseSync, accountId: string, now = Date.now()): string {
  const code = randomBytes(24).toString("base64url");
  db.prepare("UPDATE control_center_telegram SET pairing_hash=?, pairing_expires_at=? WHERE account_id=?").run(sha256(code), now + PAIRING_LIFETIME_MS, accountId);
  return code;
}

export const telegramPairingPending = (known: TelegramConnection, now = Date.now()): boolean => known.pairingHash !== null && known.pairingExpiresAt !== null && known.pairingExpiresAt >= now;

/** Links the Telegram account that used the code. One use: the code is gone whoever wins, and only a still valid code links. */
export function consumeTelegramPairing(db: DatabaseSync, known: TelegramConnection, code: string, telegramUserId: string, name: string, now = Date.now()): boolean {
  if (!telegramPairingPending(known, now) || sha256(code) !== known.pairingHash) return false;
  return db.prepare("UPDATE control_center_telegram SET telegram_user_id=?, telegram_name=?, pairing_hash=NULL, pairing_expires_at=NULL WHERE account_id=? AND pairing_hash=?")
    .run(telegramUserId, name.slice(0, 120), known.accountId, known.pairingHash).changes > 0;
}

/** False when Telegram sent this update before: a retry or a replay does nothing a second time. */
export function telegramUpdateIsNew(db: DatabaseSync, accountId: string, updateId: number, now = Date.now()): boolean {
  db.prepare("DELETE FROM control_center_telegram_updates WHERE account_id=? AND at<?").run(accountId, now - KEPT_UPDATES_MS);
  return db.prepare("INSERT OR IGNORE INTO control_center_telegram_updates (account_id, update_id, at) VALUES (?,?,?)").run(accountId, updateId, now).changes > 0;
}
