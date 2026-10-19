import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { clusterPublicKeyFingerprint, signClusterMessage, verifyClusterMessage } from "../cluster-identity.js";
import { listMemberships, membership, type RelayMembership } from "./store.js";
import { encodeControl, MAX_FRAME } from "./protocol.js";
import type { HarnessId } from "../types.js";

const rule = z.object({ action: z.enum(["enable", "block"]), name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/), harness: z.enum(["all", "pi", "claude", "kiro"]) }).strict();
export const relaySkillRulesSchema = z.array(rule).max(512).refine((rules) => new Set(rules.map((item) => `${item.name}\0${item.harness}\0${item.action}`)).size === rules.length, "Duplicate relay rule");
export type RelayResourceKind = "skills" | "mcp" | "plugins";
const toggles = z.object({ allowOthers: z.boolean(), enforce: z.boolean() }).strict();
const names = z.array(z.string().max(220)).max(512);
const enabledNames = z.object({ pi: names, claude: names, kiro: names }).strict();
const defaultToggles = () => ({ allowOthers: true, enforce: false });
const defaultNames = () => ({ pi: [], claude: [], kiro: [] });
/** allowOthers=false blocks resources the relay has not enabled; enforce=true enables the relay's enabled resources even over a local disable. */
export const relayResourceSettingsSchema = z.object({ skills: toggles, mcp: toggles, plugins: toggles }).strict();
export const relayEnabledSchema = z.object({ skills: enabledNames, mcp: enabledNames, plugins: enabledNames }).strict();
export type RelayResourceSettings = z.infer<typeof relayResourceSettingsSchema>;
export type RelayEnabledResources = z.infer<typeof relayEnabledSchema>;
export const defaultRelayResourceSettings = (): RelayResourceSettings => ({ skills: defaultToggles(), mcp: defaultToggles(), plugins: defaultToggles() });
export const emptyRelayEnabledResources = (): RelayEnabledResources => ({ skills: defaultNames(), mcp: defaultNames(), plugins: defaultNames() });
const bodySchema = z.object({
  relayNodeId: z.string().uuid(), version: z.number().int().nonnegative(), rules: relaySkillRulesSchema,
  settings: relayResourceSettingsSchema.default(defaultRelayResourceSettings), enabled: relayEnabledSchema.default(emptyRelayEnabledResources),
}).strict();
export const signedRelaySkillPolicySchema = z.object({ body: bodySchema, signature: z.string().max(200) }).strict();
export type RelaySkillRule = z.infer<typeof rule>;
export type SignedRelaySkillPolicy = z.infer<typeof signedRelaySkillPolicySchema>;

function schema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS relay_skill_policy (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, rules TEXT NOT NULL, extra TEXT
  ); CREATE TABLE IF NOT EXISTS relay_skill_subscriptions (
    membership_id TEXT PRIMARY KEY, opted_in INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT -1, statement TEXT, updated_at TEXT
  )`);
  if (!(db.prepare("PRAGMA table_info(relay_skill_policy)").all() as Array<{ name: string }>).some((column) => column.name === "extra")) {
    db.exec("ALTER TABLE relay_skill_policy ADD COLUMN extra TEXT");
  }
}

export function publishedRelayPolicy(db: DatabaseSync, nodeId: string): SignedRelaySkillPolicy {
  schema(db);
  const row = db.prepare("SELECT version,rules,extra FROM relay_skill_policy WHERE singleton=1").get() as { version: number; rules: string; extra: string | null } | undefined;
  const extra = row?.extra ? JSON.parse(row.extra) as { settings?: unknown; enabled?: unknown } : {};
  const body = bodySchema.parse({ relayNodeId: nodeId, version: row?.version ?? 0, rules: row ? JSON.parse(row.rules) : [], ...extra });
  return { body, signature: signClusterMessage(db, nodeId, "relay-skill-policy", JSON.stringify(body)) };
}

export function publishRelayPolicy(db: DatabaseSync, nodeId: string, rules: RelaySkillRule[], resources?: { settings: RelayResourceSettings; enabled: RelayEnabledResources }): SignedRelaySkillPolicy {
  relaySkillRulesSchema.parse(rules);
  schema(db);
  const current = db.prepare("SELECT version FROM relay_skill_policy WHERE singleton=1").get() as { version: number } | undefined;
  const body = bodySchema.parse({ relayNodeId: nodeId, version: (current?.version ?? 0) + 1, rules, ...resources });
  const statement = { body, signature: signClusterMessage(db, nodeId, "relay-skill-policy", JSON.stringify(body)) };
  if (encodeControl({ t: "skill-policy", statement }).byteLength > MAX_FRAME) throw new Error(`Relay skill policy exceeds the ${MAX_FRAME}-byte frame limit`);
  db.prepare("INSERT INTO relay_skill_policy(singleton,version,rules,extra) VALUES(1,?,?,?) ON CONFLICT(singleton) DO UPDATE SET version=excluded.version,rules=excluded.rules,extra=excluded.extra")
    .run(body.version, JSON.stringify(rules), JSON.stringify({ settings: body.settings, enabled: body.enabled }));
  return statement;
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

/** Membership.name is this machine's assigned name, not the relay server's identity. */
export function relayPolicyLabel(relay: RelayMembership): string {
  const host = new URL(relay.origin).host;
  return relay.environment ? `${relay.environment} · ${host}` : host;
}

/** A relay is a policy author only after this machine opts in. Blocking wins across authors. */
export function relaySkillDirective(db: DatabaseSync, name: string, harness: HarnessId): { action: "enable" | "block"; relays: string[] } | null {
  const matched = relayPolicySubscriptions(db).filter(({ optedIn }) => optedIn).flatMap(({ relay, statement }) =>
    (statement?.body.rules ?? []).filter((item) => item.name === name && (item.harness === "all" || item.harness === harness))
      .map((item) => ({ action: item.action, label: relayPolicyLabel(relay) })));
  const action = matched.some((item) => item.action === "block") ? "block" : matched.length ? "enable" : null;
  return action ? { action, relays: matched.filter((item) => item.action === action).map((item) => item.label) } : null;
}

const KIND_KEY = { skill: "skills", mcp: "mcp", plugin: "plugins" } as const;

/**
 * What opted-in relays say about one resource beyond per-skill rules.
 * `forced` means the relay's enforce setting wins over a local disable.
 */
export function relayResourceDirective(db: DatabaseSync, kind: keyof typeof KIND_KEY, name: string, harness: HarnessId): { action: "enable" | "block"; relays: string[]; forced: boolean } | null {
  const key = KIND_KEY[kind];
  const listed = (enabled: RelayEnabledResources): string[] => (enabled[key] as Record<string, string[]>)[harness] ?? [];
  const subscribed = relayPolicySubscriptions(db).filter(({ optedIn, statement }) => optedIn && statement);
  const blocking = subscribed.filter(({ statement }) => !statement!.body.settings[key].allowOthers && !listed(statement!.body.enabled).includes(name));
  if (blocking.length) return { action: "block", relays: blocking.map(({ relay }) => relayPolicyLabel(relay)), forced: true };
  const enforcing = subscribed.filter(({ statement }) => statement!.body.settings[key].enforce && listed(statement!.body.enabled).includes(name));
  return enforcing.length ? { action: "enable", relays: enforcing.map(({ relay }) => relayPolicyLabel(relay)), forced: true } : null;
}
