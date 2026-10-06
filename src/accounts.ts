import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type AccountRole = "admin" | "member";

/** An account is a person, not a node: a home node plus a username that never changes
    there. Every node derives the same id, so the id never has to travel or be agreed. */
export function accountIdFor(homeNodeId: string, username: string): string {
  return createHash("sha256").update(`joint-bob-account\n${homeNodeId}\n${username.toLowerCase()}`).digest("hex").slice(0, 32);
}

export function isAccountId(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

/** Twins are one person's machines, so their local users share a home: the lowest node id
    of this node and its twins. Every machine of the pair derives the same account. */
export function canonicalLocalHome(db: DatabaseSync): string {
  if (!tableExists(db, "cluster_node")) return "";
  const local = (db.prepare("SELECT id FROM cluster_node WHERE singleton = 1").get() as { id: string } | undefined)?.id ?? "";
  if (!local || !tableExists(db, "sharing_twins")) return local;
  const twins = db.prepare("SELECT left_node_id AS a, right_node_id AS b FROM sharing_twins WHERE left_node_id = ? OR right_node_id = ?").all(local, local) as unknown as Array<{ a: string; b: string }>;
  return [local, ...twins.flatMap((row) => [row.a, row.b])].sort()[0];
}

/** The account of this node's own user called `username`, if there is one. */
export function localAccountIdIn(db: DatabaseSync, username: string): string | undefined {
  if (!tableExists(db, "users") || !db.prepare("SELECT 1 FROM users WHERE username = ? COLLATE NOCASE AND home_node_id IS NULL").get(username)) return undefined;
  const home = canonicalLocalHome(db);
  return home ? accountIdFor(home, username) : undefined;
}
