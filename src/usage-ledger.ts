import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "./data-directory.js";
import { enqueueReplicationEvent, ensureReplicationSchema, resolveProjectAlias, type ReplicationEvent } from "./replication.js";
import { usageDifficultySchema, usageEventSchema, type UsageDifficulty, type UsageDimension, type UsageEvent, type UsageFilters, type UsageTotals } from "./usage-types.js";
import { priceUsage } from "./usage-pricing.js";
import { calendarHourKey, calendarKey } from "./usage-calendar.js";

let database: DatabaseSync | undefined;
// Listings need numeric totals, not skill evidence or pricing metadata. SQLite maintains
// these expression values on writes, so a cold total need not decode every historical payload.
const totalFields = ["apiCostUsd", "usageStatus", "input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h", "cacheWriteUnknown", "reasoning", "toolCalls", "toolErrors"];
export function ensureUsageSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS model_usage_events(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,conversation_id TEXT NOT NULL,session_id TEXT NOT NULL,engine TEXT NOT NULL,occurred_at TEXT NOT NULL,payload TEXT NOT NULL,origin_node_id TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS usage_events_project ON model_usage_events(project_id); CREATE INDEX IF NOT EXISTS usage_events_conversation ON model_usage_events(project_id,conversation_id); CREATE INDEX IF NOT EXISTS usage_events_time ON model_usage_events(occurred_at);
CREATE INDEX IF NOT EXISTS usage_events_totals ON model_usage_events(project_id,conversation_id,session_id,engine,${totalFields.map(field => `json_extract(payload,'$.${field}')`).join(",")});
CREATE TABLE IF NOT EXISTS usage_difficulty(turn_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,conversation_id TEXT NOT NULL,session_id TEXT NOT NULL,engine TEXT NOT NULL,occurred_at TEXT NOT NULL,payload TEXT NOT NULL,origin_node_id TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS usage_difficulty_scope ON usage_difficulty(project_id,conversation_id,session_id,engine,occurred_at);
CREATE INDEX IF NOT EXISTS usage_difficulty_interval ON usage_difficulty(project_id,conversation_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS usage_difficulty_session ON usage_difficulty(session_id,engine);
CREATE TABLE IF NOT EXISTS usage_inventory(project_id TEXT NOT NULL,conversation_id TEXT NOT NULL,session_id TEXT NOT NULL,engine TEXT NOT NULL,title TEXT NOT NULL,classification TEXT,usage_status TEXT NOT NULL,PRIMARY KEY(project_id,engine,session_id));
CREATE TABLE IF NOT EXISTS subscription_plans(id TEXT PRIMARY KEY,owner TEXT NOT NULL,payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS subscription_owner ON subscription_plans(owner);
CREATE TABLE IF NOT EXISTS usage_ingest_files(file_key TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,status TEXT NOT NULL);`);
}
/** Local-only: fingerprints name this machine's files, so they never replicate. */
export function usageIngestFingerprint(key: string): { fingerprint: string; status: string } | undefined {
  return usageDatabase().prepare("SELECT fingerprint,status FROM usage_ingest_files WHERE file_key=?").get(key) as { fingerprint: string; status: string } | undefined;
}
export function saveUsageIngestFingerprint(key: string, fingerprint: string, status: string): void {
  usageDatabase().prepare("INSERT INTO usage_ingest_files(file_key,fingerprint,status) VALUES(?,?,?) ON CONFLICT(file_key) DO UPDATE SET fingerprint=excluded.fingerprint,status=excluded.status").run(key, fingerprint, status);
}

/**
 * Every listing poll reads each conversation's totals, and computing one aggregates all of its
 * event payloads. Totals stay cached until a write touches their scope.
 */
type UsageScope = { projectId: string; conversationId?: string; sessionId?: string; engine?: string };
const totalsCache = new Map<string, { projectIds: string[]; filters: UsageFilters; totals: UsageTotals }>();
let revision = 0;
/** Changes whenever saved usage changes, so a viewer can tell an unchanged ledger without re-reading it. */
export function usageLedgerRevision(): number { return revision; }
function invalidateTotals(scopes: UsageScope[]): void {
  if (!scopes.length) return;
  revision++;
  for (const [key, { projectIds, filters }] of totalsCache) {
    if (scopes.some((scope) => projectIds.includes(scope.projectId)
      && (!scope.conversationId || !filters.conversationId || scope.conversationId === filters.conversationId)
      && (!scope.sessionId || !filters.sessionId || scope.sessionId === filters.sessionId)
      && (!scope.engine || !filters.engine || scope.engine === filters.engine))) totalsCache.delete(key);
  }
}
/** For writers outside this module, such as tests that edit the tables directly. */
export function clearUsageTotalsCache(): void { totalsCache.clear(); revision++; }
export function usageDatabase(): DatabaseSync {
  if (database) return database;
  const directory = resolveDataDirectory(); mkdirSync(directory, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(path.join(directory, "node.db")); database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;"); ensureReplicationSchema(database); ensureUsageSchema(database); return database;
}
function compareQuality(next: UsageEvent, current: UsageEvent): number {
  const quality = (event: UsageEvent) => {
    const billed = [event.input, event.output, event.cacheRead, event.cacheWrite5m, event.cacheWrite1h];
    return [event.usageStatus === "reported" ? 1 : 0, billed.filter((value) => value !== null).length,
      event.output ?? -1, event.input ?? -1, event.cacheRead ?? -1, event.cacheWrite5m ?? -1, event.cacheWrite1h ?? -1,
      event.reasoning ?? -1, event.cacheWriteUnknown ?? -1];
  };
  const a = quality(next), b = quality(current);
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

function putEvent(db: DatabaseSync, raw: UsageEvent, origin: string): UsageEvent | null {
  let event = usageEventSchema.parse(raw);
  const row = db.prepare("SELECT payload FROM model_usage_events WHERE id=?").get(event.id) as { payload: string } | undefined;
  if (row) {
    const current = usageEventSchema.parse(JSON.parse(row.payload));
    if (current.sessionId !== event.sessionId) return null;
    const better = compareQuality(event, current) > 0;
    const betterTools = event.toolCalls > current.toolCalls || event.toolErrors > current.toolErrors;
    const nativeUpgrade = current.pricing?.source !== "pi-reported" && event.pricing?.source === "pi-reported" && event.apiCostUsd !== null;
    const betterSkills = JSON.stringify(event.skillReads ?? []) !== JSON.stringify(current.skillReads ?? []) && Boolean(event.skillReads?.length);
    const betterInvocations = JSON.stringify(event.skillInvocations ?? []) !== JSON.stringify(current.skillInvocations ?? []) && Boolean(event.skillInvocations?.length);
    const betterTiming = event.toolDurationMs !== undefined && event.toolDurationMs !== null && (current.toolDurationMs === undefined || current.toolDurationMs === null || event.toolDurationMs > current.toolDurationMs);
    if (!better && !betterTools && !nativeUpgrade && !betterSkills && !betterInvocations && !betterTiming) return null;
    const incoming = better ? event : current;
    const currentNative = current.pricing?.source === "pi-reported";
    const incomingNative = event.pricing?.source === "pi-reported" && event.apiCostUsd !== null;
    const pricing = currentNative ? current.pricing : incomingNative ? event.pricing : current.pricing ?? event.pricing;
    let apiCostUsd = currentNative ? (better && incomingNative ? event.apiCostUsd : current.apiCostUsd) : incomingNative ? event.apiCostUsd : incoming.apiCostUsd;
    if (!currentNative && !incomingNative && pricing?.rates) apiCostUsd = (incoming.cacheWriteUnknown ?? 0) > 0 ? null : priceUsage(incoming, pricing.rates);
    event = { ...incoming,
      projectId: current.projectId, conversationId: current.conversationId, sessionId: current.sessionId, engine: current.engine,
      occurredAt: current.usageStatus === "missing" && incoming.usageStatus === "reported" ? incoming.occurredAt : current.occurredAt,
      pricing, apiCostUsd, toolCalls: Math.max(current.toolCalls, event.toolCalls), toolErrors: Math.max(current.toolErrors, event.toolErrors),
      skillReads: betterSkills ? event.skillReads : current.skillReads, skillInvocations: betterInvocations ? event.skillInvocations : current.skillInvocations,
      skillTurnId: betterSkills || betterInvocations ? event.skillTurnId : current.skillTurnId,
      toolDurationMs: betterTiming ? event.toolDurationMs : current.toolDurationMs,
    };
  }
  db.prepare(`INSERT INTO model_usage_events(id,project_id,conversation_id,session_id,engine,occurred_at,payload,origin_node_id)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,conversation_id=excluded.conversation_id,session_id=excluded.session_id,engine=excluded.engine,occurred_at=excluded.occurred_at,payload=excluded.payload,origin_node_id=excluded.origin_node_id`)
    .run(event.id, event.projectId, event.conversationId, event.sessionId, event.engine, event.occurredAt, JSON.stringify(event), origin);
  return event;
}

export function saveUsageEvents(raw: UsageEvent[], originNodeId: string): void {
  const db = usageDatabase();
  const changed: UsageEvent[] = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const value of raw) {
      const event = putEvent(db, usageEventSchema.parse(value), originNodeId);
      if (event) { changed.push(event); enqueueReplicationEvent(db, { originNodeId, entityType: "model.usage", entityKey: event.id, operation: "upsert", payload: { projectId: event.projectId, event, originNodeId } }); }
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  invalidateTotals(changed);
}
export function saveUsageEvent(raw: UsageEvent, originNodeId: string): void { saveUsageEvents([raw], originNodeId); }

export function saveDifficulty(raw: UsageDifficulty, originNodeId: string): void {
  const record = usageDifficultySchema.parse(raw);
  const db = usageDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT payload FROM usage_difficulty WHERE turn_id=?").get(record.turnId) as { payload: string } | undefined;
    const current = existing ? usageDifficultySchema.parse(JSON.parse(existing.payload)) : undefined;
    const accepted = !current?.endedAt && (!current || JSON.stringify(current) !== JSON.stringify(record));
    if (!accepted) { db.exec("COMMIT"); return; }
    db.prepare(`INSERT INTO usage_difficulty(turn_id,project_id,conversation_id,session_id,engine,occurred_at,payload,origin_node_id)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(turn_id) DO UPDATE SET payload=excluded.payload,occurred_at=excluded.occurred_at`)
      .run(record.turnId, record.projectId, record.conversationId, record.sessionId, record.engine, record.occurredAt, JSON.stringify(record), originNodeId);
    enqueueReplicationEvent(db, { originNodeId, entityType: "usage.difficulty", entityKey: record.turnId, operation: "upsert", payload: { projectId: record.projectId, record, originNodeId } });
    db.exec("COMMIT");
    revision++;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
// A listing asks for one total per conversation in a single synchronous run, and every
// total starts by resolving project aliases. Nothing else runs until that run returns, so
// the alias table is read once per run rather than once per conversation.
let aliasPass: { db: DatabaseSync; rows: Array<{ alias_id: string; project_id: string }> | null } | undefined;
function projectAliases(db: DatabaseSync): Array<{ alias_id: string; project_id: string }> | null {
  if (aliasPass?.db === db) return aliasPass.rows;
  const exists = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_aliases'").get());
  aliasPass = { db, rows: exists ? db.prepare("SELECT alias_id,project_id FROM project_aliases").all() as Array<{ alias_id: string; project_id: string }> : null };
  queueMicrotask(() => { aliasPass = undefined; });
  return aliasPass.rows;
}
/** With no alias recorded every project is its own canonical one, and the plain column keeps its indexes usable. */
function canonicalProject(db: DatabaseSync, alias: string): string {
  return projectAliases(db)?.length ? `COALESCE((SELECT project_id FROM project_aliases WHERE alias_id=${alias}.project_id),${alias}.project_id)` : `${alias}.project_id`;
}
/**
 * The stored project ids whose canonical project is one of `projectIds`. Filtering on these
 * raw ids keeps the project indexes usable; wrapping the column in the alias lookup forces a
 * full scan per query, which stalls every conversation listing.
 */
function rawProjectIds(db: DatabaseSync, filters: UsageFilters): string[] {
  const projectIds = filters.projectId ? filters.projectIds.filter((id) => id === filters.projectId) : filters.projectIds;
  const aliases = projectIds.length ? projectAliases(db) : null;
  if (!aliases) return projectIds;
  const aliased = new Set(aliases.map((row) => row.alias_id));
  return [...new Set([...projectIds.filter((id) => !aliased.has(id)), ...aliases.filter((row) => projectIds.includes(row.project_id)).map((row) => row.alias_id)])];
}
function where(db: DatabaseSync, filters: UsageFilters, alias = "e"): { sql: string; args: string[] } {
  const projectIds = rawProjectIds(db, filters);
  if (!projectIds.length) return { sql: " AND 0", args: [] };
  const args = [...projectIds];
  const clauses = [`${alias}.project_id IN (${projectIds.map(() => "?").join(",")})`];
  for (const [key, column] of [["conversationId", "conversation_id"], ["sessionId", "session_id"], ["engine", "engine"]] as const) if (filters[key]) { clauses.push(`${alias}.${column}=?`); args.push(filters[key]!); }
  for (const [key, json] of [["provider", "provider"], ["modelId", "modelId"]] as const) if (filters[key]) { clauses.push(`json_extract(${alias}.payload,'$.${json}')=?`); args.push(filters[key]!); }
  if (filters.difficulty) { clauses.push(`${difficultyExpression()}=?`); args.push(filters.difficulty); }
  if (filters.from) { clauses.push(`${alias}.occurred_at>=?`); args.push(filters.from); }
  if (filters.to) { clauses.push(`${alias}.occurred_at<?`); args.push(filters.to); }
  if (filters.classification) { clauses.push(`${classification(db)}=?`); args.push(filters.classification); }
  if (filters.originNodeIds) {
    if (!filters.originNodeIds.length) return { sql: " AND 0", args: [] };
    clauses.push(`${alias}.origin_node_id IN (${filters.originNodeIds.map(() => "?").join(",")})`); args.push(...filters.originNodeIds);
  }
  return { sql: ` AND ${clauses.join(" AND ")}`, args };
}
function totalsRow(row: Record<string, number | null>): UsageTotals {
  const requests = Number(row.requests ?? 0);
  const pricedRequests = Number(row.priced ?? 0);
  const missingRequests = Number(row.missing ?? 0);
  const unavailableSessions = Number(row.unavailableSessions ?? 0);
  const input = Number(row.input ?? 0);
  const output = Number(row.output ?? 0);
  const cacheRead = Number(row.cacheRead ?? 0);
  const cacheWrite5m = Number(row.cacheWrite5m ?? 0);
  const cacheWrite1h = Number(row.cacheWrite1h ?? 0);
  const cacheWriteUnknown = Number(row.cacheWriteUnknown ?? 0);
  return {
    apiCostUsd: pricedRequests ? Number(row.cost) : null,
    input, output, cacheRead, cacheWrite5m, cacheWrite1h, cacheWriteUnknown,
    reasoning: Number(row.reasoning ?? 0),
    totalTokens: input + output + cacheRead + cacheWrite5m + cacheWrite1h + cacheWriteUnknown,
    requests, pricedRequests, missingRequests, unavailableSessions,
    toolCalls: Number(row.toolCalls ?? 0),
    toolErrors: Number(row.toolErrors ?? 0),
    partial: missingRequests > 0 || pricedRequests < requests || unavailableSessions > 0,
  };
}
const aggregate = `COUNT(*) requests,SUM(json_extract(e.payload,'$.apiCostUsd') IS NOT NULL) priced,SUM(json_extract(e.payload,'$.usageStatus')='missing') missing,SUM(json_extract(e.payload,'$.apiCostUsd')) cost,SUM(COALESCE(json_extract(e.payload,'$.input'),0)) input,SUM(COALESCE(json_extract(e.payload,'$.output'),0)) output,SUM(COALESCE(json_extract(e.payload,'$.cacheRead'),0)) cacheRead,SUM(COALESCE(json_extract(e.payload,'$.cacheWrite5m'),0)) cacheWrite5m,SUM(COALESCE(json_extract(e.payload,'$.cacheWrite1h'),0)) cacheWrite1h,SUM(COALESCE(json_extract(e.payload,'$.cacheWriteUnknown'),0)) cacheWriteUnknown,SUM(COALESCE(json_extract(e.payload,'$.reasoning'),0)) reasoning,SUM(json_extract(e.payload,'$.toolCalls')) toolCalls,SUM(json_extract(e.payload,'$.toolErrors')) toolErrors,0 unavailableSessions`;
function hasNames(db: DatabaseSync): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='name_overrides'").get());
}
function classification(db: DatabaseSync, alias = "e", inventoryAlias = "i"): string {
  return hasNames(db)
    ? `COALESCE((SELECT name FROM name_overrides WHERE scope='session_classifications' AND key=${alias}.conversation_id),'Unclassified')`
    : `COALESCE(${inventoryAlias}.classification,'Unclassified')`;
}
function difficultyExpression(): string { return "COALESCE(CAST(json_extract(d.payload,'$.level') AS TEXT),'not-classified')"; }
/** Joins only what the filter or grouping reads: each join is evaluated per event row. */
function source(db: DatabaseSync, filters: UsageFilters, dimension?: UsageDimension): string {
  const eventProject = canonicalProject(db, "e");
  const difficultyProject = canonicalProject(db, "x");
  const inventory = !hasNames(db) && (Boolean(filters.classification) || dimension === "classification");
  const difficulty = Boolean(filters.difficulty) || dimension === "difficulty";
  return `model_usage_events e${inventory ? ` LEFT JOIN usage_inventory i ON ${canonicalProject(db, "i")}=${eventProject} AND i.engine=e.engine AND i.session_id=e.session_id` : ""}${difficulty ? `
    LEFT JOIN usage_difficulty d ON d.turn_id=(SELECT x.turn_id FROM usage_difficulty x WHERE ${difficultyProject}=${eventProject} AND x.conversation_id=e.conversation_id AND x.session_id=e.session_id AND x.engine=e.engine AND json_extract(x.payload,'$.endedAt') IS NOT NULL AND json_extract(x.payload,'$.status') IN ('classified','inherited') AND e.occurred_at>=json_extract(x.payload,'$.startedAt') AND e.occurred_at<=json_extract(x.payload,'$.endedAt') ORDER BY json_extract(x.payload,'$.startedAt') DESC LIMIT 1)` : ""}`;
}
function unavailableInventory(db: DatabaseSync, filters: UsageFilters): number {
  // Inventory rows carry no origin node, so node-scoped totals cannot attribute them.
  if (!filters.projectIds.length || filters.provider || filters.modelId || filters.from || filters.to || filters.difficulty || filters.originNodeIds) return 0;
  const projectIds = rawProjectIds(db, filters);
  if (!projectIds.length) return 0;
  const clauses = [`i.project_id IN (${projectIds.map(() => "?").join(",")})`, "i.usage_status IN ('missing','unavailable')"];
  const args = [...projectIds];
  for (const [key, column] of [["conversationId", "conversation_id"], ["sessionId", "session_id"], ["engine", "engine"]] as const) if (filters[key]) { clauses.push(`i.${column}=?`); args.push(filters[key]!); }
  if (filters.classification) { clauses.push(`${classification(db, "i", "i")}=?`); args.push(filters.classification); }
  const row = db.prepare(`SELECT COUNT(*) count FROM usage_inventory i WHERE ${clauses.join(" AND ")}`).get(...args) as { count: number };
  return Number(row.count);
}
export function usageTotals(filters: UsageFilters): UsageTotals {
  const db = usageDatabase();
  // Classification and difficulty labels change outside the usage writers, so those stay live.
  // The resolved project ids are part of the key, so an alias change is a new entry.
  const cacheable = !filters.classification && !filters.difficulty;
  const projectIds = rawProjectIds(db, filters);
  const key = JSON.stringify([projectIds, filters]);
  const cached = cacheable ? totalsCache.get(key) : undefined;
  if (cached) return cached.totals;
  const condition = where(db, filters);
  const row = db.prepare(`SELECT ${aggregate} FROM ${source(db, filters)} WHERE 1=1${condition.sql}`).get(...condition.args) as Record<string, number | null>;
  row.unavailableSessions = unavailableInventory(db, filters);
  const totals = totalsRow(row);
  if (cacheable) {
    if (totalsCache.size >= 20_000) totalsCache.clear();
    totalsCache.set(key, { projectIds, filters, totals });
  }
  return totals;
}
export interface UsageConversationPage { rows: Array<{ key: string; totals: UsageTotals }>; total: number }
export function usageConversationPage(filters: UsageFilters, page: number, pageSize: number): UsageConversationPage {
  const db = usageDatabase();
  const condition = where(db, filters);
  const from = `${source(db, filters, "conversation")} WHERE 1=1${condition.sql}`;
  const count = db.prepare(`SELECT COUNT(*) total FROM (SELECT e.conversation_id FROM ${from} GROUP BY e.conversation_id)`).get(...condition.args) as { total: number };
  const rows = db.prepare(`SELECT e.conversation_id key,${aggregate} FROM ${from} GROUP BY key ORDER BY cost DESC,key ASC LIMIT ? OFFSET ?`)
    .all(...condition.args, pageSize, (page - 1) * pageSize) as unknown as Array<Record<string, number | null> & { key: string }>;
  return { rows: rows.map((row) => ({ key: row.key, totals: totalsRow(row) })), total: Number(count.total) };
}
function dayExpression(offsetMinutes = 0): string {
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > 840) throw new RangeError("Invalid day offset");
  return offsetMinutes ? `date(e.occurred_at,'${offsetMinutes > 0 ? "+" : ""}${offsetMinutes} minutes')` : "substr(e.occurred_at,1,10)";
}
function breakdownQuery(db: DatabaseSync, filters: UsageFilters, dimension: UsageDimension): { sql: string; args: string[] } {
  const condition = where(db, filters);
  const expressions: Record<UsageDimension, string> = {
    project: canonicalProject(db, "e"), conversation: "e.conversation_id", classification: classification(db),
    difficulty: difficultyExpression(),
    model: "json_extract(e.payload,'$.modelId')", day: dayExpression(filters.dayOffsetMinutes), engine: "e.engine",
  };
  return { sql: `SELECT ${expressions[dimension]} key,${aggregate} FROM ${source(db, filters, dimension)} WHERE 1=1${condition.sql} GROUP BY key ORDER BY key`, args: condition.args };
}
export function usageBreakdown(filters: UsageFilters, dimension: UsageDimension): Array<{ key: string; totals: UsageTotals }> {
  const db = usageDatabase();
  const query = breakdownQuery(db, filters, dimension);
  const rows = db.prepare(query.sql).all(...query.args) as unknown as Array<Record<string, number | null> & { key: string }>;
  return rows.map((row) => ({ key: row.key, totals: totalsRow(row) }));
}
/**
 * How SQLite reads a grouping, one line per step. The difficulty grouping looks a turn up for
 * every request: when that lookup scanned the whole table, the dashboard took a minute and timed out.
 */
export function usageBreakdownPlan(filters: UsageFilters, dimension: UsageDimension): string[] {
  const db = usageDatabase();
  const query = breakdownQuery(db, filters, dimension);
  return (db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.args) as unknown as Array<{ detail: string }>).map((row) => row.detail);
}
/** Aggregate at UTC-minute granularity, then bucket in the viewer's IANA zone. Bounded by
 * the requested date range, not the number of conversations or their transcript sizes. */
export function usageCalendarBreakdown(filters: UsageFilters, timeZone: string, granularity: "day" | "hour" = "day"): Array<{ key: string; totals: UsageTotals }> {
  const db = usageDatabase();
  const condition = where(db, filters);
  const rows = db.prepare(`SELECT substr(e.occurred_at,1,16) minute,${aggregate} FROM ${source(db, filters)} WHERE 1=1${condition.sql} GROUP BY minute ORDER BY minute`)
    .all(...condition.args) as unknown as Array<Record<string, number | null> & { minute: string }>;
  const buckets = new Map<string, UsageTotals>();
  for (const row of rows) {
    const key = granularity === "hour" ? calendarHourKey(`${row.minute}:00.000Z`, timeZone) : calendarKey(`${row.minute}:00.000Z`, timeZone);
    const value = totalsRow(row);
    const previous = buckets.get(key);
    if (!previous) { buckets.set(key, value); continue; }
    for (const field of ["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h", "cacheWriteUnknown", "reasoning", "totalTokens", "requests", "pricedRequests", "missingRequests", "unavailableSessions", "toolCalls", "toolErrors"] as const) previous[field] += value[field];
    previous.apiCostUsd = previous.apiCostUsd === null ? value.apiCostUsd : previous.apiCostUsd + (value.apiCostUsd ?? 0);
    previous.partial ||= value.partial;
  }
  return [...buckets].map(([key, totals]) => ({ key, totals })).sort((a, b) => a.key.localeCompare(b.key));
}
/** The middle value, the lower of the two for an even count; null without values. */
function medianOf(values: Iterable<number>): number | null {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered.length ? ordered[Math.floor((ordered.length - 1) / 2)] : null;
}
/** The nearest-rank percentile; null without values. */
function percentileOf(values: Iterable<number>, fraction: number): number | null {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered.length ? ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)] : null;
}
export interface SkillUsage {
  /** The skill's name: one row per skill, whichever folder or node it was loaded from. */
  id: string; name: string;
  /** The newest observed content hash, or "unknown". */
  version: string;
  associatedTurns: number; observedReads: number; explicitInvocations: number; conversations: number;
  associatedRequests: number; pricedRequests: number; apiEquivalentCostUsd: number;
  toolCalls: number; toolErrors: number;
  medianDurationMs: number | null; timedTurns: number;
  firstUsedAt: string; lastUsedAt: string;
  models: Array<{ modelId: string; requests: number; toolErrors: number; knownCostUsd: number }>;
  /** Tokens by kind over every request in the skill's turns, and the share of input served from cache. */
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
  p90DurationMs: number | null;
  engines: Array<{ engine: string; turns: number }>;
  projects: Array<{ projectId: string; turns: number; conversations: number; knownCostUsd: number }>;
  /** Turns and known cost per local day, oldest first; days without a use are left out. */
  daily: Array<{ key: string; turns: number; knownCostUsd: number }>;
  /** The costliest conversations that loaded the skill. */
  topConversations: Array<{ projectId: string; conversationId: string; turns: number; knownCostUsd: number }>;
}
export interface SkillUsageGroup { requests: number; pricedRequests: number; costUsd: number; toolCalls: number; toolErrors: number }
export interface SkillUsageBreakdown {
  skills: SkillUsage[];
  unattributedRequests: number; scopeRequests: number;
  /** Requests in turns that loaded any skill, each counted once, and the rest of the scope. */
  withSkill: SkillUsageGroup & { turns: number; timedTurns: number; medianDurationMs: number | null };
  withoutSkill: SkillUsageGroup;
  /** Every timed turn in scope; null under a filter that turns do not record. */
  turnTiming: { timedTurns: number; medianDurationMs: number | null } | null;
  note: string;
}
const SKILL_REQUEST_LIMIT = 200_000;
/**
 * One row per skill name. The same skill installed under two folders, or on two nodes, or edited
 * during the period, is still one skill to the person reading the list. Only requests that carry
 * skill evidence are read one by one; the rest of the scope is a single aggregate.
 */
export function usageSkillBreakdown(filters: UsageFilters, timeZone = "UTC"): SkillUsageBreakdown {
  const db = usageDatabase();
  const condition = where(db, filters);
  const scope = usageTotals(filters);
  const rows = db.prepare(`SELECT e.id,e.project_id projectId,e.conversation_id conversationId,e.session_id sessionId,e.engine,e.occurred_at occurredAt,
    json_extract(e.payload,'$.modelId') modelId,json_extract(e.payload,'$.apiCostUsd') cost,json_extract(e.payload,'$.toolCalls') toolCalls,json_extract(e.payload,'$.toolErrors') toolErrors,
    json_extract(e.payload,'$.skillTurnId') turnId,json_extract(e.payload,'$.skillReads') reads,json_extract(e.payload,'$.skillInvocations') invocations,
    COALESCE(json_extract(e.payload,'$.input'),0) tIn,COALESCE(json_extract(e.payload,'$.output'),0) tOut,COALESCE(json_extract(e.payload,'$.cacheRead'),0) tCacheRead,
    COALESCE(json_extract(e.payload,'$.cacheWrite5m'),0)+COALESCE(json_extract(e.payload,'$.cacheWrite1h'),0)+COALESCE(json_extract(e.payload,'$.cacheWriteUnknown'),0) tCacheWrite,COALESCE(json_extract(e.payload,'$.reasoning'),0) tReasoning
    FROM ${source(db, filters)} WHERE 1=1${condition.sql} AND (json_extract(e.payload,'$.skillReads') IS NOT NULL OR json_extract(e.payload,'$.skillInvocations') IS NOT NULL)
    ORDER BY e.occurred_at LIMIT ${SKILL_REQUEST_LIMIT + 1}`).all(...condition.args) as unknown as Array<{ id: string; projectId: string; conversationId: string; sessionId: string; engine: string; occurredAt: string; modelId: string | null; cost: number | null; toolCalls: number | null; toolErrors: number | null; turnId: string | null; reads: string | null; invocations: string | null; tIn: number; tOut: number; tCacheRead: number; tCacheWrite: number; tReasoning: number }>;
  if (rows.length > SKILL_REQUEST_LIMIT) throw new RangeError("Too many requests; select a shorter window");

  // Turns record a project, conversation, agent and node, so only those filters reach them.
  const ids = rawProjectIds(db, filters);
  const turnClauses = [`project_id IN (${ids.map(() => "?").join(",")})`, "json_extract(payload,'$.startedAt') IS NOT NULL", "json_extract(payload,'$.endedAt') IS NOT NULL"];
  const turnArgs = [...ids];
  for (const [key, column] of [["conversationId", "conversation_id"], ["engine", "engine"]] as const) if (filters[key]) { turnClauses.push(`${column}=?`); turnArgs.push(filters[key]!); }
  if (filters.from) { turnClauses.push("occurred_at>=?"); turnArgs.push(filters.from); }
  if (filters.to) { turnClauses.push("occurred_at<?"); turnArgs.push(filters.to); }
  if (filters.originNodeIds?.length) { turnClauses.push(`origin_node_id IN (${filters.originNodeIds.map(() => "?").join(",")})`); turnArgs.push(...filters.originNodeIds); }
  const turns = ids.length && (!filters.originNodeIds || filters.originNodeIds.length)
    ? db.prepare(`SELECT session_id sessionId,engine,json_extract(payload,'$.startedAt') startedAt,json_extract(payload,'$.endedAt') endedAt FROM usage_difficulty WHERE ${turnClauses.join(" AND ")}`)
      .all(...turnArgs) as unknown as Array<{ sessionId: string; engine: string; startedAt: string; endedAt: string }>
    : [];
  const intervals = new Map<string, Array<{ start: number; end: number; duration: number }>>();
  for (const turn of turns) {
    const start = Date.parse(turn.startedAt), end = Date.parse(turn.endedAt);
    if (!(end >= start)) continue;
    // A session belongs to one project, which an alias may have renamed on either table.
    const key = `${turn.engine}:${turn.sessionId}`;
    const ranges = intervals.get(key) ?? []; ranges.push({ start, end, duration: end - start }); intervals.set(key, ranges);
  }

  type Tally = { name: string; version: string; turns: Set<string>; readTurns: Set<string>; invokedTurns: Set<string>; conversations: Set<string>; durations: Map<string, number>; requests: number; priced: number; cost: number; toolCalls: number; errors: number; first: string; last: string; models: Map<string, { requests: number; toolErrors: number; knownCostUsd: number }>;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }; engines: Map<string, Set<string>>;
    projects: Map<string, { turns: Set<string>; conversations: Set<string>; cost: number }>; daily: Map<string, { turns: Set<string>; cost: number }>; byConversation: Map<string, { projectId: string; conversationId: string; turns: Set<string>; cost: number }> };
  const skills = new Map<string, Tally>();
  const used: SkillUsageGroup = { requests: 0, pricedRequests: 0, costUsd: 0, toolCalls: 0, toolErrors: 0 };
  const usedTurns = new Set<string>();
  const usedDurations = new Map<string, number>();
  const evidence = (raw: string | null): Array<{ name?: unknown; version?: unknown }> => { const value: unknown = raw ? JSON.parse(raw) : []; return Array.isArray(value) ? value : []; };
  for (const row of rows) {
    // A request that lists one skill twice, read from two folders, still counts once for it.
    const named = new Map<string, { read: boolean; invoked: boolean; version: string }>();
    for (const [kind, items] of [["read", evidence(row.reads)], ["invoked", evidence(row.invocations)]] as const) for (const item of items) {
      if (typeof item.name !== "string" || !item.name) continue;
      const entry = named.get(item.name) ?? { read: false, invoked: false, version: "unknown" };
      entry[kind] = true;
      if (typeof item.version === "string" && item.version !== "unknown") entry.version = item.version;
      named.set(item.name, entry);
    }
    if (!named.size) continue;
    const turnId = row.turnId ?? `${row.sessionId}:${row.id}`;
    const timestamp = Date.parse(row.occurredAt);
    const duration = intervals.get(`${row.engine}:${row.sessionId}`)?.find(({ start, end }) => timestamp >= start && timestamp <= end)?.duration;
    const toolCalls = Number(row.toolCalls ?? 0), toolErrors = Number(row.toolErrors ?? 0), modelId = row.modelId ?? "unknown";
    used.requests++; used.toolCalls += toolCalls; used.toolErrors += toolErrors;
    if (row.cost !== null) { used.pricedRequests++; used.costUsd += row.cost; }
    usedTurns.add(turnId);
    if (duration !== undefined && !usedDurations.has(turnId)) usedDurations.set(turnId, duration);
    for (const [name, seen] of named) {
      let tally = skills.get(name);
      if (!tally) { tally = { name, version: "unknown", turns: new Set(), readTurns: new Set(), invokedTurns: new Set(), conversations: new Set(), durations: new Map(), requests: 0, priced: 0, cost: 0, toolCalls: 0, errors: 0, first: row.occurredAt, last: row.occurredAt, models: new Map(),
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, engines: new Map(), projects: new Map(), daily: new Map(), byConversation: new Map() }; skills.set(name, tally); }
      if (seen.version !== "unknown") tally.version = seen.version;
      tally.turns.add(turnId);
      if (seen.read) tally.readTurns.add(turnId);
      if (seen.invoked) tally.invokedTurns.add(turnId);
      tally.conversations.add(`${row.projectId}:${row.conversationId}`);
      if (duration !== undefined && !tally.durations.has(turnId)) tally.durations.set(turnId, duration);
      tally.requests++; tally.toolCalls += toolCalls; tally.errors += toolErrors; tally.last = row.occurredAt;
      if (row.cost !== null) { tally.priced++; tally.cost += row.cost; }
      const model = tally.models.get(modelId) ?? { requests: 0, toolErrors: 0, knownCostUsd: 0 };
      model.requests++; model.toolErrors += toolErrors; model.knownCostUsd += row.cost ?? 0;
      tally.models.set(modelId, model);
      tally.tokens.input += Number(row.tIn); tally.tokens.output += Number(row.tOut); tally.tokens.cacheRead += Number(row.tCacheRead);
      tally.tokens.cacheWrite += Number(row.tCacheWrite); tally.tokens.reasoning += Number(row.tReasoning);
      const engineTurns = tally.engines.get(row.engine) ?? new Set<string>(); engineTurns.add(turnId); tally.engines.set(row.engine, engineTurns);
      const project = tally.projects.get(row.projectId) ?? { turns: new Set<string>(), conversations: new Set<string>(), cost: 0 };
      project.turns.add(turnId); project.conversations.add(row.conversationId); project.cost += row.cost ?? 0; tally.projects.set(row.projectId, project);
      const dayKey = calendarKey(row.occurredAt, timeZone);
      const day = tally.daily.get(dayKey) ?? { turns: new Set<string>(), cost: 0 };
      day.turns.add(turnId); day.cost += row.cost ?? 0; tally.daily.set(dayKey, day);
      const conversationKey = `${row.projectId}\0${row.conversationId}`;
      const conversation = tally.byConversation.get(conversationKey) ?? { projectId: row.projectId, conversationId: row.conversationId, turns: new Set<string>(), cost: 0 };
      conversation.turns.add(turnId); conversation.cost += row.cost ?? 0; tally.byConversation.set(conversationKey, conversation);
    }
  }
  const turnFiltersApply = !filters.provider && !filters.modelId && !filters.classification && !filters.difficulty && !filters.sessionId;
  const everyDuration = [...intervals.values()].flat().map(({ duration }) => duration);
  return {
    skills: [...skills.values()].map((tally) => ({ id: tally.name, name: tally.name, version: tally.version, associatedTurns: tally.turns.size,
      observedReads: tally.readTurns.size, explicitInvocations: tally.invokedTurns.size, conversations: tally.conversations.size,
      associatedRequests: tally.requests, pricedRequests: tally.priced, apiEquivalentCostUsd: tally.cost, toolCalls: tally.toolCalls, toolErrors: tally.errors,
      timedTurns: tally.durations.size, medianDurationMs: medianOf(tally.durations.values()), firstUsedAt: tally.first, lastUsedAt: tally.last,
      models: [...tally.models].map(([modelId, totals]) => ({ modelId, ...totals })).sort((a, b) => b.requests - a.requests),
      tokens: tally.tokens, p90DurationMs: percentileOf(tally.durations.values(), 0.9),
      engines: [...tally.engines].map(([engine, turns]) => ({ engine, turns: turns.size })).sort((a, b) => b.turns - a.turns),
      projects: [...tally.projects].map(([projectId, value]) => ({ projectId, turns: value.turns.size, conversations: value.conversations.size, knownCostUsd: value.cost })).sort((a, b) => b.knownCostUsd - a.knownCostUsd || b.turns - a.turns),
      daily: [...tally.daily].map(([key, value]) => ({ key, turns: value.turns.size, knownCostUsd: value.cost })).sort((a, b) => a.key.localeCompare(b.key)),
      topConversations: [...tally.byConversation.values()].map((value) => ({ projectId: value.projectId, conversationId: value.conversationId, turns: value.turns.size, knownCostUsd: value.cost }))
        .sort((a, b) => b.knownCostUsd - a.knownCostUsd || b.turns - a.turns).slice(0, 8) }))
      .sort((a, b) => b.apiEquivalentCostUsd - a.apiEquivalentCostUsd),
    unattributedRequests: Math.max(0, scope.requests - used.requests), scopeRequests: scope.requests,
    withSkill: { ...used, turns: usedTurns.size, timedTurns: usedDurations.size, medianDurationMs: medianOf(usedDurations.values()) },
    withoutSkill: { requests: Math.max(0, scope.requests - used.requests), pricedRequests: Math.max(0, scope.pricedRequests - used.pricedRequests),
      costUsd: Math.max(0, (scope.apiCostUsd ?? 0) - used.costUsd), toolCalls: Math.max(0, scope.toolCalls - used.toolCalls), toolErrors: Math.max(0, scope.toolErrors - used.toolErrors) },
    turnTiming: turnFiltersApply ? { timedTurns: everyDuration.length, medianDurationMs: medianOf(everyDuration) } : null,
    note: "A turn that loads several skills counts under each, so rows overlap and do not add up. Use and duration are unknown unless observed." };
}
export interface TurnTimingTotals { turns: number; failed: number; medianAgentMs: number | null; medianQueueMs: number | null; medianToolMs: number | null }
export function usageTurnTiming(filters: UsageFilters, timeZone: string): { days: Array<{ key: string; turns: number; failed: number; medianAgentMs: number; medianQueueMs: number | null; medianToolMs: number | null; toolTimedRequests: number; toolRequestsUnknown: number }>; totals: TurnTimingTotals; unknownHistoricalTiming: number } {
  const db = usageDatabase();
  const ids = rawProjectIds(db, filters);
  const none: TurnTimingTotals = { turns: 0, failed: 0, medianAgentMs: null, medianQueueMs: null, medianToolMs: null };
  if (!ids.length) return { days: [], totals: none, unknownHistoricalTiming: 0 };
  const clauses = [`project_id IN (${ids.map(() => "?").join(",")})`];
  const args = [...ids];
  for (const [key, column] of [["conversationId", "conversation_id"], ["engine", "engine"]] as const) if (filters[key]) { clauses.push(`${column}=?`); args.push(filters[key]!); }
  if (filters.from) { clauses.push("occurred_at>=?"); args.push(filters.from); }
  if (filters.to) { clauses.push("occurred_at<?"); args.push(filters.to); }
  if (filters.originNodeIds) {
    if (!filters.originNodeIds.length) return { days: [], totals: none, unknownHistoricalTiming: 0 };
    clauses.push(`origin_node_id IN (${filters.originNodeIds.map(() => "?").join(",")})`); args.push(...filters.originNodeIds);
  }
  const records = db.prepare(`SELECT payload FROM usage_difficulty WHERE ${clauses.join(" AND ")} ORDER BY occurred_at LIMIT 50001`).all(...args) as unknown as Array<{ payload: string }>;
  if (records.length > 50000) throw new RangeError("Too many turns; select a shorter window");
  const days = new Map<string, Array<{ agent: number; queue: number | null; failed: boolean }>>();
  const intervals = new Map<string, Array<{ start: number; end: number }>>();
  for (const { payload } of records) {
    const item = usageDifficultySchema.parse(JSON.parse(payload));
    if (!item.startedAt || !item.endedAt) continue;
    const agent = Date.parse(item.endedAt) - Date.parse(item.startedAt);
    const queue = item.queuedAt ? Date.parse(item.startedAt) - Date.parse(item.queuedAt) : null;
    if (agent < 0 || queue !== null && queue < 0) continue;
    const key = calendarKey(item.startedAt, timeZone);
    const session = `${item.projectId}:${item.engine}:${item.sessionId}`;
    const ranges = intervals.get(session) ?? [];
    ranges.push({ start: Date.parse(item.startedAt), end: Date.parse(item.endedAt) }); intervals.set(session, ranges);
    const group = days.get(key) ?? [];
    group.push({ agent, queue, failed: item.outcome === "failed" }); days.set(key, group);
  }
  const condition = where(db, filters);
  const events = db.prepare(`SELECT e.payload FROM model_usage_events e WHERE 1=1${condition.sql} LIMIT 50001`).all(...condition.args) as unknown as Array<{ payload: string }>;
  if (events.length > 50000) throw new RangeError("Too many requests; select a shorter window");
  const toolDays = new Map<string, { measured: number[]; unknown: number }>();
  let unknownHistoricalTiming = 0;
  for (const { payload } of events) {
    const event = usageEventSchema.parse(JSON.parse(payload));
    const timestamp = Date.parse(event.occurredAt);
    if (!intervals.get(`${event.projectId}:${event.engine}:${event.sessionId}`)?.some(({ start, end }) => timestamp >= start && timestamp <= end)) unknownHistoricalTiming++;
    if (!event.toolCalls) continue;
    const key = calendarKey(event.occurredAt, timeZone);
    const tool = toolDays.get(key) ?? { measured: [], unknown: 0 };
    if (event.toolDurationMs === undefined || event.toolDurationMs === null) tool.unknown++;
    else tool.measured.push(event.toolDurationMs);
    toolDays.set(key, tool);
  }
  const everyTurn = [...days.values()].flat();
  return { days: [...new Set([...days.keys(), ...toolDays.keys()])].map((key) => {
    const rows = days.get(key) ?? [], tool = toolDays.get(key);
    return { key, turns: rows.length, failed: rows.filter((row) => row.failed).length,
      medianAgentMs: medianOf(rows.map((row) => row.agent)) ?? 0, medianQueueMs: medianOf(rows.flatMap((row) => row.queue === null ? [] : [row.queue])),
      medianToolMs: medianOf(tool?.measured ?? []), toolTimedRequests: tool?.measured.length ?? 0, toolRequestsUnknown: tool?.unknown ?? 0 };
  }).sort((a, b) => a.key.localeCompare(b.key)),
    // A period's median is not the median of its days' medians, so it is taken over every turn.
    totals: { turns: everyTurn.length, failed: everyTurn.filter((row) => row.failed).length, medianAgentMs: medianOf(everyTurn.map((row) => row.agent)),
      medianQueueMs: medianOf(everyTurn.flatMap((row) => row.queue === null ? [] : [row.queue])), medianToolMs: medianOf([...toolDays.values()].flatMap((tool) => tool.measured)) },
    unknownHistoricalTiming };
}
export function conversationUsage(projectId:string,conversationId:string):UsageTotals{return usageTotals({projectIds:[projectId],projectId,conversationId});} export function projectUsage(projectId:string):UsageTotals{return usageTotals({projectIds:[projectId],projectId});}
export function latestDifficultyForConversation(projectId: string, conversationId: string, configId: string, configRevision: number): UsageDifficulty | null {
  const db = usageDatabase();
  const row = db.prepare(`SELECT payload FROM usage_difficulty x WHERE ${canonicalProject(db, "x")}=? AND conversation_id=? AND json_extract(payload,'$.endedAt') IS NOT NULL ORDER BY occurred_at DESC LIMIT 1`).get(resolveProjectAlias(db, projectId), conversationId) as { payload: string } | undefined;
  if (!row) return null;
  const value = usageDifficultySchema.parse(JSON.parse(row.payload));
  return ["classified", "inherited"].includes(value.status) && value.configId === configId && value.configRevision === configRevision ? value : null;
}
export function inheritedDifficulty(base: UsageDifficulty, previous: UsageDifficulty | null): UsageDifficulty {
  return previous ? { ...base, status: "inherited", level: previous.level, confidence: previous.confidence, inheritedFrom: previous.turnId, classifierId: previous.classifierId, configId: previous.configId, configRevision: previous.configRevision } : base;
}
export function usageInventoryCoverage(projectIds?: string[]): { projects: number; sessions: number; missing: number } {
  if (projectIds && !projectIds.length) return { projects: 0, sessions: 0, missing: 0 };
  const db = usageDatabase();
  const condition = projectIds ? ` WHERE ${canonicalProject(db, "i")} IN (${projectIds.map(() => "?").join(",")})` : "";
  const row = db.prepare(`SELECT COUNT(DISTINCT ${canonicalProject(db, "i")}) projects,COUNT(*) sessions,SUM(usage_status IN ('missing','unavailable')) missing FROM usage_inventory i${condition}`).get(...(projectIds ?? [])) as Record<string, number>;
  return { projects: Number(row.projects), sessions: Number(row.sessions), missing: Number(row.missing ?? 0) };
}
export function upsertUsageInventory(value: { projectId: string; conversationId: string; sessionId: string; engine: string; title: string; classification: string | null; usageStatus: string }): void {
  // Every listing re-reports every session; an unchanged row must not rewrite the database.
  const { changes } = usageDatabase().prepare(`INSERT INTO usage_inventory(project_id,conversation_id,session_id,engine,title,classification,usage_status) VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,engine,session_id) DO UPDATE SET conversation_id=excluded.conversation_id,title=excluded.title,classification=excluded.classification,usage_status=excluded.usage_status
    WHERE conversation_id IS NOT excluded.conversation_id OR title IS NOT excluded.title OR classification IS NOT excluded.classification OR usage_status IS NOT excluded.usage_status`)
    .run(value.projectId, value.conversationId, value.sessionId, value.engine, value.title, value.classification, value.usageStatus);
  // The row may have moved between conversations, so drop the whole project's session totals.
  if (Number(changes)) invalidateTotals([{ projectId: value.projectId, sessionId: value.sessionId, engine: value.engine }]);
}
/** The costliest conversations in a scope with when they ran and what they cost, for grouping by title. */
export function usageConversationSummaries(filters: UsageFilters, limit: number): Array<{ projectId: string; conversationId: string; costUsd: number | null; requests: number; firstAt: string; lastAt: string }> {
  const db = usageDatabase();
  const condition = where(db, filters);
  const rows = db.prepare(`SELECT ${canonicalProject(db, "e")} projectId,e.conversation_id conversationId,SUM(json_extract(e.payload,'$.apiCostUsd')) cost,COUNT(*) requests,MIN(e.occurred_at) firstAt,MAX(e.occurred_at) lastAt
    FROM ${source(db, filters)} WHERE 1=1${condition.sql} GROUP BY projectId,conversationId ORDER BY cost DESC,conversationId LIMIT ?`)
    .all(...condition.args, limit) as unknown as Array<{ projectId: string; conversationId: string; cost: number | null; requests: number; firstAt: string; lastAt: string }>;
  return rows.map((row) => ({ projectId: row.projectId, conversationId: row.conversationId, costUsd: row.cost === null ? null : Number(row.cost), requests: Number(row.requests), firstAt: row.firstAt, lastAt: row.lastAt }));
}
/** When the ledger's first request was recorded, or null for an empty ledger. */
export function usageObservedSince(): string | null {
  return (usageDatabase().prepare("SELECT MIN(occurred_at) since FROM model_usage_events").get() as { since: string | null }).since;
}
export function usageConversations(projectIds: string[], conversationIds?: string[]): unknown[] {
  if (!projectIds.length || conversationIds && !conversationIds.length) return [];
  const db = usageDatabase();
  const inventoryProject = canonicalProject(db, "i");
  const eventProject = canonicalProject(db, "e");
  const placeholders = projectIds.map(() => "?").join(",");
  const conversationClause = conversationIds ? ` AND i.conversation_id IN (${conversationIds.map(() => "?").join(",")})` : "";
  const eventConversationClause = conversationIds ? ` AND e.conversation_id IN (${conversationIds.map(() => "?").join(",")})` : "";
  const names = hasNames(db)
    ? "COALESCE((SELECT name FROM name_overrides WHERE scope='session_classifications' AND key=u.conversationId),'Unclassified')"
    : "COALESCE(max(u.classification),'Unclassified')";
  return db.prepare(`WITH u AS (
    SELECT ${inventoryProject} projectId,i.conversation_id conversationId,i.title,i.classification,i.usage_status usageStatus FROM usage_inventory i WHERE ${inventoryProject} IN (${placeholders})${conversationClause}
    UNION ALL
    SELECT ${eventProject},e.conversation_id,e.conversation_id,NULL,json_extract(e.payload,'$.usageStatus') FROM model_usage_events e WHERE ${eventProject} IN (${placeholders})${eventConversationClause}
  ) SELECT u.projectId,u.conversationId,COALESCE(max(CASE WHEN u.title!=u.conversationId THEN u.title END),u.conversationId) title,${names} classification,min(u.usageStatus) usageStatus FROM u GROUP BY u.projectId,u.conversationId ORDER BY title`).all(...projectIds, ...(conversationIds ?? []), ...projectIds, ...(conversationIds ?? []));
}
export function applyUsageEvent(db: DatabaseSync, event: ReplicationEvent): void {
  if (event.entityType !== "model.usage" || event.operation !== "upsert") throw new Error("Unsupported usage replication event");
  const payload = event.payload as { projectId: string; event: UsageEvent; originNodeId: string };
  if (!payload || payload.projectId !== payload.event?.projectId || payload.originNodeId !== event.originNodeId || event.entityKey !== payload.event?.id) throw new Error("Malformed usage replication event");
  const parsed = usageEventSchema.parse(payload.event);
  const stored = putEvent(db, { ...parsed, projectId: resolveProjectAlias(db,parsed.projectId) }, event.originNodeId);
  if (stored) invalidateTotals([stored]);
}
export function applyUsageDifficultyEvent(db: DatabaseSync, event: ReplicationEvent): void {
  if (event.entityType !== "usage.difficulty" || event.operation !== "upsert") throw new Error("Unsupported usage difficulty event");
  const payload = event.payload as { projectId: string; record: UsageDifficulty; originNodeId: string };
  if (!payload || payload.projectId !== payload.record?.projectId || payload.originNodeId !== event.originNodeId || event.entityKey !== payload.record?.turnId) throw new Error("Malformed usage difficulty event");
  const record = usageDifficultySchema.parse(payload.record);
  const projectId = resolveProjectAlias(db, record.projectId);
  const existing = db.prepare("SELECT payload FROM usage_difficulty WHERE turn_id=?").get(record.turnId) as { payload: string } | undefined;
  const current = existing ? usageDifficultySchema.parse(JSON.parse(existing.payload)) : undefined;
  if (current?.endedAt || current && JSON.stringify(current) === JSON.stringify(record)) return;
  db.prepare(`INSERT INTO usage_difficulty VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(turn_id) DO UPDATE SET payload=excluded.payload,occurred_at=excluded.occurred_at`)
    .run(record.turnId, projectId, record.conversationId, record.sessionId, record.engine, record.occurredAt, JSON.stringify({ ...record, projectId }), event.originNodeId);
  revision++;
}
