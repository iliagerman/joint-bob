import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { actingAccount, type ActingAccount } from "./account-context.js";
import { accountIdFor, canonicalLocalHome } from "./accounts.js";
import { resolveDataDirectory } from "./data-directory.js";

/**
 * Which person on this node owns each resource. One table for every kind, so a new kind of
 * resource needs no migration. A resource without a row belongs to the node's admin: that
 * is everything created before there were several users, and everything the admin creates.
 */
export type OwnedKind = "project" | "workspace" | "secret" | "routing_config" | "quick_note" | "browser_profile" | "ntfy_service" | "cron" | "skill";

let database: DatabaseSync | undefined;

export function ensureOwnershipSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS resource_account_owners (
    kind TEXT NOT NULL, resource_id TEXT NOT NULL, account_id TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (kind, resource_id));
  CREATE INDEX IF NOT EXISTS resource_account_owners_account ON resource_account_owners(account_id, kind);`);
}

function ownershipDatabase(): DatabaseSync {
  if (database) return database;
  const directory = resolveDataDirectory();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(directory, "node.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  ensureOwnershipSchema(db);
  database = db;
  return db;
}

/** The node admin's account, the owner of everything without an owner row. */
export function adminAccountId(db: DatabaseSync = ownershipDatabase()): string | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()) return undefined;
  const row = db.prepare("SELECT username FROM users WHERE role = 'admin' AND home_node_id IS NULL LIMIT 1").get() as { username: string } | undefined;
  const home = canonicalLocalHome(db);
  return row && home ? accountIdFor(home, row.username) : undefined;
}

export function resourceOwner(kind: OwnedKind, resourceId: string, db: DatabaseSync = ownershipDatabase()): string | undefined {
  ensureOwnershipSchema(db);
  const row = db.prepare("SELECT account_id FROM resource_account_owners WHERE kind = ? AND resource_id = ?").get(kind, resourceId) as { account_id: string } | undefined;
  return row?.account_id ?? adminAccountId(db);
}

/** Records the owner. The admin's resources carry no row, so they stay the node's. */
export function setResourceOwner(kind: OwnedKind, resourceId: string, accountId: string | undefined, db: DatabaseSync = ownershipDatabase()): void {
  ensureOwnershipSchema(db);
  if (!accountId || accountId === adminAccountId(db)) { db.prepare("DELETE FROM resource_account_owners WHERE kind = ? AND resource_id = ?").run(kind, resourceId); return; }
  db.prepare("INSERT INTO resource_account_owners (kind, resource_id, account_id, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, resource_id) DO UPDATE SET account_id = excluded.account_id")
    .run(kind, resourceId, accountId, new Date().toISOString());
}

export function forgetResourceOwner(kind: OwnedKind, resourceId: string, db: DatabaseSync = ownershipDatabase()): void {
  ensureOwnershipSchema(db);
  db.prepare("DELETE FROM resource_account_owners WHERE kind = ? AND resource_id = ?").run(kind, resourceId);
}

/** The owner a new resource gets: whoever is acting, or the admin when it's the node. */
export function newResourceOwner(account: ActingAccount | undefined = actingAccount()): string | undefined {
  return account && !account.isRemoteLogin ? account.accountId : undefined;
}

/** Whose personal things apply (ntfy servers, queue, routing choice): the acting person's own,
    a visitor's included, so nobody falls through to the admin's. Only the node's own work,
    with nobody acting, uses the admin's. */
export function personalAccount(account: ActingAccount | undefined = actingAccount()): string | undefined {
  return account?.accountId;
}

/** Whether an account is known here as someone other than the admin: a member of this node,
    or a visitor from another. The admin can be on record under an older id (before a twin
    was paired), so an id nobody here answers to counts as the admin's. */
export function accountOfSomeoneElse(accountId: string, db: DatabaseSync = ownershipDatabase()): boolean {
  let members: Array<{ username: string; account_id: string | null }>;
  try {
    if (db.prepare("SELECT 1 FROM users WHERE account_id = ? AND home_node_id IS NOT NULL").get(accountId)) return true;
    members = db.prepare("SELECT username, account_id FROM users WHERE home_node_id IS NULL AND role = 'member'").all() as unknown as Array<{ username: string; account_id: string | null }>;
  } catch { return false; } // No accounts table yet, or one from before roles: nobody but the admin.
  const home = canonicalLocalHome(db);
  return members.some((member) => member.account_id === accountId || (home !== "" && accountIdFor(home, member.username) === accountId));
}

/** Whether the acting person owns the resource. The node itself (no acting account) sees
    everything; a visitor from another node owns nothing here. */
export function actorOwns(kind: OwnedKind, resourceId: string, account: ActingAccount | undefined = actingAccount(), db: DatabaseSync = ownershipDatabase()): boolean {
  if (!account) return true;
  if (account.isRemoteLogin) return false;
  return resourceOwner(kind, resourceId, db) === account.accountId;
}

/** Resources of `kind` someone other than the admin owns. */
export function memberOwnedIds(kind: OwnedKind, db: DatabaseSync = ownershipDatabase()): Set<string> {
  ensureOwnershipSchema(db);
  return new Set((db.prepare("SELECT resource_id FROM resource_account_owners WHERE kind = ?").all(kind) as unknown as Array<{ resource_id: string }>).map((row) => row.resource_id));
}

export function ownedResourceIds(kind: OwnedKind, accountId: string, db: DatabaseSync = ownershipDatabase()): string[] {
  ensureOwnershipSchema(db);
  return (db.prepare("SELECT resource_id FROM resource_account_owners WHERE kind = ? AND account_id = ?").all(kind, accountId) as unknown as Array<{ resource_id: string }>).map((row) => row.resource_id);
}

/** Whether the admin owns it: only the admin's resources go to the node's twins. */
export function ownedByAdmin(kind: OwnedKind, resourceId: string, db: DatabaseSync = ownershipDatabase()): boolean {
  ensureOwnershipSchema(db);
  return !db.prepare("SELECT 1 FROM resource_account_owners WHERE kind = ? AND resource_id = ?").get(kind, resourceId);
}

/** Moves every resource of one account to another, for the twin account change. */
export function remapResourceOwners(from: string, to: string, db: DatabaseSync = ownershipDatabase()): void {
  ensureOwnershipSchema(db);
  db.prepare("UPDATE OR IGNORE resource_account_owners SET account_id = ? WHERE account_id = ?").run(to, from);
}

/** Acts as a resource's owner, for work the node does on their behalf (an agent's request,
    a scheduled run). The node's own resources act as the admin. */
export function ownerAsActor(accountId: string | undefined, db: DatabaseSync = ownershipDatabase()): ActingAccount | undefined {
  const admin = adminAccountId(db);
  const id = accountId ?? admin;
  if (!id) return undefined;
  return { accountId: id, username: "", role: id === admin ? "admin" : "member", isRemoteLogin: false, homeNodeId: null };
}
