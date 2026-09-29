import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDataDirectory } from "./data-directory.js";
import { enqueueReplicationEvent, ensureReplicationSchema, resolveProjectAlias, type ReplicationEvent } from "./replication.js";
import { usageDifficultySchema, usageEventSchema, type UsageDifficulty, type UsageDimension, type UsageEvent, type UsageFilters, type UsageTotals } from "./usage-types.js";
import { priceUsage } from "./usage-pricing.js";

let database: DatabaseSync | undefined;
export function ensureUsageSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS model_usage_events(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,conversation_id TEXT NOT NULL,session_id TEXT NOT NULL,engine TEXT NOT NULL,occurred_at TEXT NOT NULL,payload TEXT NOT NULL,origin_node_id TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS usage_events_project ON model_usage_events(project_id); CREATE INDEX IF NOT EXISTS usage_events_conversation ON model_usage_events(project_id,conversation_id); CREATE INDEX IF NOT EXISTS usage_events_time ON model_usage_events(occurred_at);
CREATE TABLE IF NOT EXISTS usage_difficulty(turn_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,conversation_id TEXT NOT NULL,session_id TEXT NOT NULL,engine TEXT NOT NULL,occurred_at TEXT NOT NULL,payload TEXT NOT NULL,origin_node_id TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS usage_difficulty_scope ON usage_difficulty(project_id,conversation_id,session_id,engine,occurred_at);
CREATE INDEX IF NOT EXISTS usage_difficulty_interval ON usage_difficulty(project_id,conversation_id,occurred_at DESC);
CREATE TABLE IF NOT EXISTS usage_inventory(project_id TEXT NOT NULL,conversation_id TEXT NOT NULL,session_id TEXT NOT NULL,engine TEXT NOT NULL,title TEXT NOT NULL,classification TEXT,usage_status TEXT NOT NULL,PRIMARY KEY(project_id,engine,session_id));
CREATE TABLE IF NOT EXISTS subscription_plans(id TEXT PRIMARY KEY,owner TEXT NOT NULL,payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS subscription_owner ON subscription_plans(owner);`);
}
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
    if (!better && !betterTools && !nativeUpgrade) return null;
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
    };
  }
  db.prepare(`INSERT INTO model_usage_events(id,project_id,conversation_id,session_id,engine,occurred_at,payload,origin_node_id)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,conversation_id=excluded.conversation_id,session_id=excluded.session_id,engine=excluded.engine,occurred_at=excluded.occurred_at,payload=excluded.payload,origin_node_id=excluded.origin_node_id`)
    .run(event.id, event.projectId, event.conversationId, event.sessionId, event.engine, event.occurredAt, JSON.stringify(event), origin);
  return event;
}

export function saveUsageEvents(raw: UsageEvent[], originNodeId: string): void {
  const db = usageDatabase();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const value of raw) {
      const event = putEvent(db, usageEventSchema.parse(value), originNodeId);
      if (event) enqueueReplicationEvent(db, { originNodeId, entityType: "model.usage", entityKey: event.id, operation: "upsert", payload: { projectId: event.projectId, event, originNodeId } });
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
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
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
function hasAliases(db: DatabaseSync): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_aliases'").get());
}
function canonicalProject(db: DatabaseSync, alias: string): string {
  return hasAliases(db) ? `COALESCE((SELECT project_id FROM project_aliases WHERE alias_id=${alias}.project_id),${alias}.project_id)` : `${alias}.project_id`;
}
/**
 * The stored project ids whose canonical project is one of `projectIds`. Filtering on these
 * raw ids keeps the project indexes usable; wrapping the column in the alias lookup forces a
 * full scan per query, which stalls every conversation listing.
 */
function rawProjectIds(db: DatabaseSync, filters: UsageFilters): string[] {
  const projectIds = filters.projectId ? filters.projectIds.filter((id) => id === filters.projectId) : filters.projectIds;
  if (!projectIds.length || !hasAliases(db)) return projectIds;
  const aliases = db.prepare("SELECT alias_id,project_id FROM project_aliases").all() as Array<{ alias_id: string; project_id: string }>;
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
  if (!filters.projectIds.length || filters.provider || filters.modelId || filters.from || filters.to || filters.difficulty) return 0;
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
  const condition = where(db, filters);
  const row = db.prepare(`SELECT ${aggregate} FROM ${source(db, filters)} WHERE 1=1${condition.sql}`).get(...condition.args) as Record<string, number | null>;
  row.unavailableSessions = unavailableInventory(db, filters);
  return totalsRow(row);
}
export function usageBreakdown(filters: UsageFilters, dimension: UsageDimension): Array<{ key: string; totals: UsageTotals }> {
  const db = usageDatabase();
  const condition = where(db, filters);
  const expressions: Record<UsageDimension, string> = {
    project: canonicalProject(db, "e"), conversation: "e.conversation_id", classification: classification(db),
    difficulty: difficultyExpression(),
    model: "json_extract(e.payload,'$.modelId')", day: "substr(e.occurred_at,1,10)", engine: "e.engine",
  };
  const rows = db.prepare(`SELECT ${expressions[dimension]} key,${aggregate} FROM ${source(db, filters, dimension)} WHERE 1=1${condition.sql} GROUP BY key ORDER BY key`)
    .all(...condition.args) as unknown as Array<Record<string, number | null> & { key: string }>;
  return rows.map((row) => ({ key: row.key, totals: totalsRow(row) }));
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
  usageDatabase().prepare(`INSERT INTO usage_inventory(project_id,conversation_id,session_id,engine,title,classification,usage_status) VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,engine,session_id) DO UPDATE SET conversation_id=excluded.conversation_id,title=excluded.title,classification=excluded.classification,usage_status=excluded.usage_status`)
    .run(value.projectId, value.conversationId, value.sessionId, value.engine, value.title, value.classification, value.usageStatus);
}
export function usageConversations(projectIds: string[]): unknown[] {
  if (!projectIds.length) return [];
  const db = usageDatabase();
  const inventoryProject = canonicalProject(db, "i");
  const eventProject = canonicalProject(db, "e");
  const placeholders = projectIds.map(() => "?").join(",");
  const names = hasNames(db)
    ? "COALESCE((SELECT name FROM name_overrides WHERE scope='session_classifications' AND key=u.conversationId),'Unclassified')"
    : "COALESCE(max(u.classification),'Unclassified')";
  return db.prepare(`WITH u AS (
    SELECT ${inventoryProject} projectId,i.conversation_id conversationId,i.title,i.classification,i.usage_status usageStatus FROM usage_inventory i WHERE ${inventoryProject} IN (${placeholders})
    UNION ALL
    SELECT ${eventProject},e.conversation_id,e.conversation_id,NULL,json_extract(e.payload,'$.usageStatus') FROM model_usage_events e WHERE ${eventProject} IN (${placeholders})
  ) SELECT u.projectId,u.conversationId,COALESCE(max(CASE WHEN u.title!=u.conversationId THEN u.title END),u.conversationId) title,${names} classification,min(u.usageStatus) usageStatus FROM u GROUP BY u.projectId,u.conversationId ORDER BY title`).all(...projectIds, ...projectIds);
}
export function applyUsageEvent(db: DatabaseSync, event: ReplicationEvent): void {
  if (event.entityType !== "model.usage" || event.operation !== "upsert") throw new Error("Unsupported usage replication event");
  const payload = event.payload as { projectId: string; event: UsageEvent; originNodeId: string };
  if (!payload || payload.projectId !== payload.event?.projectId || payload.originNodeId !== event.originNodeId || event.entityKey !== payload.event?.id) throw new Error("Malformed usage replication event");
  const parsed = usageEventSchema.parse(payload.event);
  putEvent(db, { ...parsed, projectId: resolveProjectAlias(db,parsed.projectId) }, event.originNodeId);
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
}
