import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { clusterPublicKeyFingerprint, signClusterMessage, verifyClusterMessage } from "../cluster-identity.js";
import { listMemberships, membership, type RelayMembership } from "./store.js";
import type { HarnessId } from "../types.js";

const rule = z.object({ action: z.enum(["enable", "block"]), name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/), harness: z.enum(["all", "pi", "claude", "kiro"]) }).strict();
export const relaySkillRulesSchema = z.array(rule).max(512).refine((rules) => new Set(rules.map((item) => `${item.name}\0${item.harness}\0${item.action}`)).size === rules.length, "Duplicate relay rule");
const bodySchema = z.object({ relayNodeId: z.string().uuid(), version: z.number().int().nonnegative(), rules: relaySkillRulesSchema }).strict();
export const signedRelaySkillPolicySchema = z.object({ body: bodySchema, signature: z.string().max(200) }).strict();
export type RelaySkillRule = z.infer<typeof rule>;
export type SignedRelaySkillPolicy = z.infer<typeof signedRelaySkillPolicySchema>;

function schema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS relay_skill_policy (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, rules TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS relay_skill_subscriptions (
    membership_id TEXT PRIMARY KEY, opted_in INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT -1, statement TEXT, updated_at TEXT
  )`);
}

export function publishedRelayPolicy(db: DatabaseSync, nodeId: string): SignedRelaySkillPolicy {
  schema(db);
  const row = db.prepare("SELECT version,rules FROM relay_skill_policy WHERE singleton=1").get() as { version: number; rules: string } | undefined;
  const body = bodySchema.parse({ relayNodeId: nodeId, version: row?.version ?? 0, rules: row ? JSON.parse(row.rules) : [] });
  return { body, signature: signClusterMessage(db, nodeId, "relay-skill-policy", JSON.stringify(body)) };
}

export function publishRelayPolicy(db: DatabaseSync, nodeId: string, rules: RelaySkillRule[]): SignedRelaySkillPolicy {
  relaySkillRulesSchema.parse(rules);
  schema(db);
  db.prepare("INSERT INTO relay_skill_policy(singleton,version,rules) VALUES(1,1,?) ON CONFLICT(singleton) DO UPDATE SET version=version+1,rules=excluded.rules")
    .run(JSON.stringify(rules));
  return publishedRelayPolicy(db, nodeId);
}

export function receiveRelayPolicy(db: DatabaseSync, relay: RelayMembership, publicKey: string, input: unknown): boolean {
  if (relay.status !== "admitted" || !relay.fingerprint || !relay.relayNodeId) throw new Error("Relay is not admitted");
  const statement = signedRelaySkillPolicySchema.parse(input);
  if (statement.body.relayNodeId !== relay.relayNodeId || clusterPublicKeyFingerprint(publicKey) !== relay.fingerprint
    || !verifyClusterMessage(publicKey, "relay-skill-policy", JSON.stringify(statement.body), statement.signature)) throw new Error("Relay policy signature is invalid");
  schema(db);
  const previous = db.prepare("SELECT version,statement FROM relay_skill_subscriptions WHERE membership_id=?").get(relay.id) as { version: number; statement: string | null } | undefined;
  if (previous && statement.body.version < previous.version) throw new Error("Stale relay policy");
  if (previous && statement.body.version === previous.version) {
    if (previous.statement && JSON.stringify(statement) !== previous.statement) throw new Error("Conflicting relay policy version");
    return false;
  }
  db.prepare("INSERT INTO relay_skill_subscriptions(membership_id,version,statement,updated_at) VALUES(?,?,?,?) ON CONFLICT(membership_id) DO UPDATE SET version=excluded.version,statement=excluded.statement,updated_at=excluded.updated_at")
    .run(relay.id, statement.body.version, JSON.stringify(statement), new Date().toISOString());
  return true;
}

export function subscribeRelayPolicy(db: DatabaseSync, membershipId: string, optedIn: boolean): void {
  const relay = membership(db, membershipId);
  if (!relay || relay.status !== "admitted") throw new Error("Only an admitted relay may control skills");
  schema(db);
  db.prepare("INSERT INTO relay_skill_subscriptions(membership_id,opted_in) VALUES(?,?) ON CONFLICT(membership_id) DO UPDATE SET opted_in=excluded.opted_in")
    .run(membershipId, Number(optedIn));
}

export function relayPolicySubscriptions(db: DatabaseSync): Array<{ relay: RelayMembership; optedIn: boolean; statement: SignedRelaySkillPolicy | null; updatedAt: string | null }> {
  schema(db);
  const rows = db.prepare("SELECT membership_id,opted_in,statement,updated_at FROM relay_skill_subscriptions").all() as Array<{ membership_id: string; opted_in: number; statement: string | null; updated_at: string | null }>;
  const byId = new Map(rows.map((row) => [row.membership_id, row]));
  return listMemberships(db).filter((relay) => relay.status === "admitted").map((relay) => {
    const row = byId.get(relay.id);
    return { relay, optedIn: row?.opted_in === 1, statement: row?.statement ? signedRelaySkillPolicySchema.parse(JSON.parse(row.statement)) : null, updatedAt: row?.updated_at ?? null };
  });
}

/** A relay is a policy author only after this machine opts in. Blocking wins across authors. */
export function relaySkillDirective(db: DatabaseSync, name: string, harness: HarnessId): { action: "enable" | "block"; relays: string[] } | null {
  const matched = relayPolicySubscriptions(db).filter(({ optedIn }) => optedIn).flatMap(({ relay, statement }) =>
    (statement?.body.rules ?? []).filter((item) => item.name === name && (item.harness === "all" || item.harness === harness))
      .map((item) => ({ action: item.action, label: relay.name || relay.origin })));
  const action = matched.some((item) => item.action === "block") ? "block" : matched.length ? "enable" : null;
  return action ? { action, relays: matched.filter((item) => item.action === action).map((item) => item.label) } : null;
}
