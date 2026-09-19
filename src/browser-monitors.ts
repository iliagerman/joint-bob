import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { resolveDataDirectory } from "./data-directory.js";
import { monitorBindingSchema, monitorCheckpointSchema, monitorCheckResultSchema, monitorInputSchema, type MonitorBinding, type MonitorCheckResult, type MonitorEvent, type MonitorHealth, type MonitorInput, type MonitorItem, type MonitorPartition, type MonitorRecord, type MonitorRun } from "./browser-monitor-types.js";

type MonitorRow = { id: string; owner_node_id: string; input: string; generation: number; enabled: number; baseline: number; checkpoint: string; health: MonitorHealth; detail: string; next_due_at: number | null; last_started_at: number | null; last_finished_at: number | null; created_at: number; updated_at: number };
type RunRow = { id: string; monitor_id: string; generation: number; due_at: number; started_at: number; finished_at: number | null; status: MonitorRun["status"]; detail: string };
type EventRow = { id: string; monitor_id: string; item: string; observed_at: number; processed: number; review_required: number };
type PartitionRow = { monitor_id: string; target_id: string; baseline: number; cursor: string | null; continuation: string | null; complete: number; detail: string; last_checked_at: number };
const patchSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), intervalSeconds: z.number().int().min(10).max(86400).optional(), readAcknowledged: z.boolean().optional() }).strict();
const failureHealthSchema = z.enum(["needs-login", "wrong-account", "target-missing", "incompatible", "browser-stopped", "paused-by-human", "unavailable", "error"]);
const blockedHealth = new Set<MonitorHealth>(["needs-login", "wrong-account", "target-missing", "incompatible", "browser-stopped", "paused-by-human"]);

export class BrowserMonitorStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS browser_monitor_monitors (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_node_id TEXT NOT NULL, input TEXT NOT NULL, generation INTEGER NOT NULL, enabled INTEGER NOT NULL, baseline INTEGER NOT NULL, checkpoint TEXT NOT NULL, health TEXT NOT NULL, detail TEXT NOT NULL, next_due_at INTEGER, last_started_at INTEGER, last_finished_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS browser_monitor_runs (id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, generation INTEGER NOT NULL, due_at INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS browser_monitor_events (id TEXT PRIMARY KEY, monitor_id TEXT NOT NULL, external_id TEXT NOT NULL, item TEXT NOT NULL, observed_at INTEGER NOT NULL, processed INTEGER NOT NULL, review_required INTEGER NOT NULL DEFAULT 1, UNIQUE(monitor_id, external_id));
      CREATE TABLE IF NOT EXISTS browser_monitor_activation (monitor_id TEXT PRIMARY KEY REFERENCES browser_monitor_monitors(id) ON DELETE CASCADE, activated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS browser_monitor_partitions (monitor_id TEXT NOT NULL REFERENCES browser_monitor_monitors(id) ON DELETE CASCADE, target_id TEXT NOT NULL, baseline INTEGER NOT NULL, cursor TEXT, continuation TEXT, complete INTEGER NOT NULL, detail TEXT NOT NULL, last_checked_at INTEGER NOT NULL, PRIMARY KEY(monitor_id, target_id));
      CREATE INDEX IF NOT EXISTS browser_monitor_due ON browser_monitor_monitors(owner_node_id, enabled, next_due_at);
      CREATE INDEX IF NOT EXISTS browser_monitor_latest_runs ON browser_monitor_runs(monitor_id, started_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS browser_monitor_pending_events ON browser_monitor_events(monitor_id, processed, observed_at, id);
      CREATE UNIQUE INDEX IF NOT EXISTS browser_monitor_active_run ON browser_monitor_runs(monitor_id) WHERE status = 'running';`);
    db.exec("BEGIN IMMEDIATE");
    try {
      const eventColumns = db.prepare("PRAGMA table_info(browser_monitor_events)").all() as unknown as Array<{ name: string }>;
      if (!eventColumns.some(column => column.name === "review_required")) db.exec("ALTER TABLE browser_monitor_events ADD COLUMN review_required INTEGER NOT NULL DEFAULT 1");
      db.exec("DROP TABLE IF EXISTS browser_monitor_action_events; DROP TABLE IF EXISTS browser_monitor_actions; DROP TABLE IF EXISTS browser_monitor_rules;");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  /** Closes the caller-owned injected connection. */
  close(): void { this.db.close(); }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private row(id: string): MonitorRow {
    const row = this.db.prepare("SELECT * FROM browser_monitor_monitors WHERE id = ?").get(id) as MonitorRow | undefined;
    if (!row) throw new Error("Browser monitor not found");
    return row;
  }
  private record(row: MonitorRow): MonitorRecord {
    const input = monitorInputSchema.parse(JSON.parse(row.input));
    const checkpoint = monitorCheckpointSchema.parse(JSON.parse(row.checkpoint));
    return { ...input, id: row.id, ownerNodeId: row.owner_node_id, generation: row.generation, enabled: Boolean(row.enabled), baseline: Boolean(row.baseline), checkpoint, health: row.health, detail: row.detail, nextDueAt: row.next_due_at, lastStartedAt: row.last_started_at, lastFinishedAt: row.last_finished_at, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  get(id: string): MonitorRecord { return this.record(this.row(id)); }
  getForProject(id: string, projectId: string): MonitorRecord {
    const row = this.db.prepare("SELECT * FROM browser_monitor_monitors WHERE id = ? AND project_id = ?").get(id, projectId) as MonitorRow | undefined;
    if (!row) throw new Error("Browser monitor not found");
    return this.record(row);
  }
  private timestamp(now: number): void { z.number().int().nonnegative().safe().parse(now); }
  list(projectId?: string): MonitorRecord[] {
    const sql = projectId === undefined ? "SELECT * FROM browser_monitor_monitors ORDER BY created_at, id" : "SELECT * FROM browser_monitor_monitors WHERE project_id = ? ORDER BY created_at, id";
    const rows = (projectId === undefined ? this.db.prepare(sql).all() : this.db.prepare(sql).all(projectId)) as unknown as MonitorRow[];
    return rows.map(row => this.record(row));
  }
  create(input: MonitorInput, ownerNodeId: string, now = Date.now()): MonitorRecord {
    const data = monitorInputSchema.parse(input); z.string().uuid().parse(ownerNodeId); const id = randomUUID();
    this.db.prepare("INSERT INTO browser_monitor_monitors VALUES (?, ?, ?, ?, 1, 0, 0, '{}', 'paused', 'Preview and enable this monitor', NULL, NULL, NULL, ?, ?)").run(id, data.projectId, ownerNodeId, JSON.stringify(data), now, now);
    return this.get(id);
  }
  private current(id: string, generation: number): MonitorRecord {
    const monitor = this.get(id);
    if (monitor.generation !== generation) throw new Error("Browser monitor changed; refresh before continuing");
    return monitor;
  }
  private cancel(id: string, now: number): void {
    this.db.prepare("UPDATE browser_monitor_runs SET status = 'cancelled', finished_at = ?, detail = 'Monitor changed during check' WHERE monitor_id = ? AND status = 'running'").run(now, id);
  }
  setEnabled(id: string, generation: number, enabled: boolean, now = Date.now()): MonitorRecord {
    return this.transaction(() => {
      const monitor = this.current(id, generation);
      if (enabled && !monitor.readAcknowledged) throw new Error("Acknowledge browser read effects before enabling");
      this.cancel(id, now);
      if (enabled) this.db.prepare("INSERT OR IGNORE INTO browser_monitor_activation (monitor_id, activated_at) VALUES (?, ?)").run(id, now);
      this.db.prepare("UPDATE browser_monitor_monitors SET generation = generation + 1, enabled = ?, health = ?, detail = ?, next_due_at = ?, updated_at = ? WHERE id = ?").run(Number(enabled), enabled ? "ready" : "paused", enabled ? "" : "Monitor paused", enabled ? now : null, now, id);
      return this.get(id);
    });
  }
  rebind(id: string, generation: number, binding: MonitorBinding, now = Date.now()): MonitorRecord {
    const valid = monitorBindingSchema.parse(binding);
    return this.transaction(() => {
      const monitor = this.current(id, generation); const next = monitorInputSchema.parse({ ...this.inputOf(monitor), binding: valid });
      this.cancel(id, now); this.pauseWithInput(id, next, now); return this.get(id);
    });
  }
  update(id: string, generation: number, patch: { name?: string; intervalSeconds?: number; readAcknowledged?: boolean }, now = Date.now()): MonitorRecord {
    const valid = patchSchema.parse(patch);
    return this.transaction(() => {
      const monitor = this.current(id, generation); const next = monitorInputSchema.parse({ ...this.inputOf(monitor), ...valid });
      this.cancel(id, now); this.pauseWithInput(id, next, now); return this.get(id);
    });
  }
  private inputOf({ id: _id, ownerNodeId: _owner, generation: _generation, enabled: _enabled, baseline: _baseline, checkpoint: _checkpoint, health: _health, detail: _detail, nextDueAt: _next, lastStartedAt: _started, lastFinishedAt: _finished, createdAt: _created, updatedAt: _updated, ...input }: MonitorRecord): MonitorInput { return input; }
  private pauseWithInput(id: string, input: MonitorInput, now: number): void {
    this.db.prepare("UPDATE browser_monitor_monitors SET input = ?, generation = generation + 1, enabled = 0, health = 'paused', detail = 'Monitor paused', next_due_at = NULL, updated_at = ? WHERE id = ?").run(JSON.stringify(input), now, id);
  }
  requestCheck(id: string, generation: number, now = Date.now()): MonitorRecord {
    return this.transaction(() => {
      const monitor = this.current(id, generation); if (!monitor.enabled) throw new Error("Browser monitor is paused");
      if (this.active(id)) throw new Error("Browser monitor is already checking");
      this.db.prepare("UPDATE browser_monitor_monitors SET next_due_at = ?, updated_at = ? WHERE id = ?").run(now, now, id); return this.get(id);
    });
  }
  private active(id: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM browser_monitor_runs WHERE monitor_id = ? AND status = 'running'").get(id)); }
  claim(id: string, ownerNodeId: string, now = Date.now()): MonitorRun | null {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM browser_monitor_monitors WHERE id = ?").get(id) as MonitorRow | undefined;
      if (!row) return null; const monitor = this.record(row);
      if (monitor.ownerNodeId !== ownerNodeId || !monitor.enabled || monitor.nextDueAt === null || monitor.nextDueAt > now || this.active(id)) return null;
      const run: MonitorRun = { id: randomUUID(), monitorId: id, generation: monitor.generation, dueAt: monitor.nextDueAt, startedAt: now, finishedAt: null, status: "running", detail: "" };
      this.db.prepare("INSERT INTO browser_monitor_runs VALUES (?, ?, ?, ?, ?, NULL, 'running', '')").run(run.id, id, run.generation, run.dueAt, now);
      this.db.prepare("UPDATE browser_monitor_monitors SET last_started_at = ?, health = 'checking', detail = '', next_due_at = ?, updated_at = ? WHERE id = ?").run(now, now + monitor.intervalSeconds * 1000, now, id); return run;
    });
  }
  complete(runId: string, result: MonitorCheckResult, now = Date.now()): MonitorEvent[] {
    const valid = monitorCheckResultSchema.parse(result);
    return this.transaction(() => {
      const run = this.runRow(runId); const monitor = this.get(run.monitor_id);
      if (run.status !== "running" || run.generation !== monitor.generation || !monitor.enabled) return [];
      if (valid.accountId !== monitor.accountId) throw new Error("Browser account does not match monitor");
      if (valid.coverage) return this.completeCoverage(run, monitor, { ...valid, coverage: valid.coverage }, now);
      const events = !monitor.baseline && !valid.complete ? [] : this.ingest(monitor, valid.items, now, !monitor.baseline);
      const checkpoint = valid.complete ? JSON.stringify(valid.checkpoint) : JSON.stringify(monitor.checkpoint);
      this.db.prepare("UPDATE browser_monitor_runs SET status = 'succeeded', finished_at = ?, detail = ? WHERE id = ?").run(now, valid.detail, runId);
      this.db.prepare("UPDATE browser_monitor_monitors SET baseline = ?, checkpoint = ?, health = ?, detail = ?, last_finished_at = ?, next_due_at = MAX(next_due_at, ?), updated_at = ? WHERE id = ?").run(Number(monitor.baseline || valid.complete), checkpoint, valid.complete ? "ready" : "partial", valid.detail, now, now, now, monitor.id);
      return events;
    });
  }
  private completeCoverage(run: RunRow, monitor: MonitorRecord, result: MonitorCheckResult & { coverage: NonNullable<MonitorCheckResult["coverage"]> }, now: number): MonitorEvent[] {
    const selected = new Set(monitor.targetIds); const covered = new Set(result.coverage.partitions.map(partition => partition.targetId));
    if (selected.size && ([...covered].some(target => !selected.has(target)) || result.items.some(item => !selected.has(item.targetId)))) throw new Error("Browser monitor target is outside scope");
    let activation = this.db.prepare("SELECT activated_at FROM browser_monitor_activation WHERE monitor_id = ?").get(monitor.id) as { activated_at: number } | undefined;
    if (!activation) { this.db.prepare("INSERT INTO browser_monitor_activation (monitor_id, activated_at) VALUES (?, ?)").run(monitor.id, run.started_at); activation = { activated_at: run.started_at }; }
    const checkpoint = { ...monitor.checkpoint };
    for (const partition of result.coverage.partitions) this.savePartition(monitor, partition, checkpoint, now);
    const validCheckpoint = monitorCheckpointSchema.parse(checkpoint);
    const events = this.ingestCoverage(monitor, result.items, covered, activation.activated_at, now);
    const counts = this.db.prepare("SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN baseline=1 THEN 1 ELSE 0 END),0) baselines, COALESCE(SUM(CASE WHEN complete=1 THEN 1 ELSE 0 END),0) completed FROM browser_monitor_partitions WHERE monitor_id=?").get(monitor.id) as { total: number; baselines: number; completed: number };
    const selectedPartition = this.db.prepare("SELECT baseline, complete FROM browser_monitor_partitions WHERE monitor_id=? AND target_id=?");
    const selectedRows = [...selected].map(target => selectedPartition.get(monitor.id, target) as Pick<PartitionRow, "baseline" | "complete"> | undefined);
    const selectedBaseline = selectedRows.every(row => Boolean(row?.baseline));
    const selectedComplete = selectedRows.every(row => Boolean(row?.complete));
    const baseline = monitor.baseline || (result.coverage.discoveryComplete && counts.total === counts.baselines && selectedBaseline);
    const ready = result.complete && counts.total === counts.completed && selectedComplete;
    const detail = ready || result.detail ? result.detail : "Some monitor targets remain unchecked";
    this.db.prepare("UPDATE browser_monitor_runs SET status='succeeded', finished_at=?, detail=? WHERE id=?").run(now, result.detail, run.id);
    this.db.prepare("UPDATE browser_monitor_monitors SET baseline=?, checkpoint=?, health=?, detail=?, last_finished_at=?, next_due_at=MAX(next_due_at,?), updated_at=? WHERE id=?").run(Number(baseline), JSON.stringify(validCheckpoint), ready ? "ready" : "partial", detail, now, now, now, monitor.id);
    return events;
  }
  private savePartition(monitor: MonitorRecord, partition: NonNullable<MonitorCheckResult["coverage"]>["partitions"][number], checkpoint: Record<string, string>, now: number): void {
    const row = this.db.prepare("SELECT * FROM browser_monitor_partitions WHERE monitor_id=? AND target_id=?").get(monitor.id, partition.targetId) as PartitionRow | undefined;
    const legacyCursor = monitor.baseline ? monitor.checkpoint[partition.targetId] : undefined;
    const previousBaseline = Boolean(row?.baseline) || legacyCursor !== undefined; const previousCursor = row?.cursor ?? legacyCursor ?? null;
    if (partition.complete && partition.cursor === null && previousCursor !== null) throw new Error("Complete partition cannot erase its saved cursor");
    const cursor = partition.complete ? partition.cursor : previousCursor;
    if (partition.complete && cursor !== null) checkpoint[partition.targetId] = cursor;
    this.db.prepare("INSERT INTO browser_monitor_partitions (monitor_id,target_id,baseline,cursor,continuation,complete,detail,last_checked_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(monitor_id,target_id) DO UPDATE SET baseline=excluded.baseline,cursor=excluded.cursor,continuation=excluded.continuation,complete=excluded.complete,detail=excluded.detail,last_checked_at=excluded.last_checked_at").run(monitor.id, partition.targetId, Number(previousBaseline || partition.complete), cursor, partition.continuation, Number(partition.complete), partition.detail, now);
  }
  private ingestCoverage(monitor: MonitorRecord, items: MonitorItem[], covered: Set<string>, activatedAt: number, now: number): MonitorEvent[] {
    const emitted: MonitorEvent[] = [];
    for (const item of items) {
      if (!covered.has(item.targetId)) throw new Error("Browser monitor target is outside scope");
      if (item.occurredAt !== null && item.occurredAt > now) throw new Error("Browser monitor item timestamp is in the future");
      const partition = this.db.prepare("SELECT complete FROM browser_monitor_partitions WHERE monitor_id=? AND target_id=?").get(monitor.id, item.targetId) as { complete: number };
      const incoming = item.direction === "incoming" && ["message.received", "page.changed"].includes(item.kind); const historical = item.occurredAt !== null && item.occurredAt <= activatedAt;
      const processed = !incoming || historical; const reviewRequired = processed || item.occurredAt === null || item.identity !== "stable" || !partition.complete || item.kind === "page.changed";
      const event: MonitorEvent = { ...item, id: randomUUID(), monitorId: monitor.id, observedAt: now, processed, reviewRequired };
      const inserted = this.db.prepare("INSERT OR IGNORE INTO browser_monitor_events (id,monitor_id,external_id,item,observed_at,processed,review_required) VALUES (?,?,?,?,?,?,?)").run(event.id, monitor.id, item.externalId, JSON.stringify(item), now, Number(processed), Number(reviewRequired));
      if (inserted.changes && !processed) emitted.push(event);
    }
    return emitted;
  }
  private runRow(id: string): RunRow {
    const row = this.db.prepare("SELECT * FROM browser_monitor_runs WHERE id = ?").get(id) as RunRow | undefined;
    if (!row) throw new Error("Browser monitor run not found"); return row;
  }
  private ingest(monitor: MonitorRecord, items: MonitorItem[], now: number, baseline: boolean): MonitorEvent[] {
    const emitted: MonitorEvent[] = [];
    for (const item of items) {
      const pending = !baseline && item.direction === "incoming" && ["message.received", "page.changed"].includes(item.kind);
      const event: MonitorEvent = { ...item, id: randomUUID(), monitorId: monitor.id, observedAt: now, processed: !pending, reviewRequired: true };
      const result = this.db.prepare("INSERT OR IGNORE INTO browser_monitor_events (id, monitor_id, external_id, item, observed_at, processed, review_required) VALUES (?, ?, ?, ?, ?, ?, ?)").run(event.id, monitor.id, item.externalId, JSON.stringify(item), now, Number(event.processed), 1);
      if (result.changes && pending) emitted.push(event);
    }
    return emitted;
  }
  fail(runId: string, health: Exclude<MonitorHealth, "paused" | "ready" | "partial" | "checking">, detail: string, now = Date.now()): void {
    const validHealth = failureHealthSchema.parse(health); z.string().max(2000).parse(detail);
    this.transaction(() => {
      const run = this.runRow(runId); const monitor = this.get(run.monitor_id);
      if (run.status !== "running" || run.generation !== monitor.generation || !monitor.enabled) return;
      const blocked = blockedHealth.has(validHealth); const next = blocked ? null : now + Math.max(monitor.intervalSeconds * 1000, 30000);
      this.db.prepare("UPDATE browser_monitor_runs SET status = 'failed', finished_at = ?, detail = ? WHERE id = ?").run(now, detail, runId);
      this.db.prepare("UPDATE browser_monitor_monitors SET enabled = ?, health = ?, detail = ?, last_finished_at = ?, next_due_at = ?, updated_at = ? WHERE id = ?").run(Number(!blocked), validHealth, detail, now, next, now, monitor.id);
    });
  }
  history(id: string, limit = 50): MonitorRun[] { this.get(id); this.limit(limit); return (this.db.prepare("SELECT id, monitor_id AS monitorId, generation, due_at AS dueAt, started_at AS startedAt, finished_at AS finishedAt, status, detail FROM browser_monitor_runs WHERE monitor_id = ? ORDER BY started_at DESC, id DESC LIMIT ?").all(id, limit) as unknown as MonitorRun[]); }
  events(id: string, limit = 100): MonitorEvent[] { this.get(id); this.limit(limit); return this.eventRows("SELECT * FROM browser_monitor_events WHERE monitor_id = ? ORDER BY observed_at DESC, id DESC LIMIT ?", id, limit); }
  eventsByIds(monitorId: string, eventIds: string[]): MonitorEvent[] {
    this.get(monitorId);
    const ids = z.array(z.string().uuid()).max(100)
      .refine(values => new Set(values).size === values.length, "Event IDs must be unique")
      .parse(eventIds);
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    const events = this.eventRows(`SELECT * FROM browser_monitor_events WHERE monitor_id = ? AND id IN (${placeholders})`, monitorId, ...ids);
    const byId = new Map(events.map(event => [event.id, event]));
    if (byId.size !== ids.length) throw new Error("Browser monitor event not found");
    return ids.map(id => byId.get(id)!);
  }
  partitions(id: string, limit = 100, afterTargetId?: string): MonitorPartition[] {
    this.get(id); this.limit(limit); if (afterTargetId !== undefined) z.string().min(1).max(320).parse(afterTargetId);
    const sql = afterTargetId === undefined ? "SELECT * FROM browser_monitor_partitions WHERE monitor_id=? ORDER BY target_id LIMIT ?" : "SELECT * FROM browser_monitor_partitions WHERE monitor_id=? AND target_id>? ORDER BY target_id LIMIT ?";
    const rows = (afterTargetId === undefined ? this.db.prepare(sql).all(id, limit) : this.db.prepare(sql).all(id, afterTargetId, limit)) as unknown as PartitionRow[];
    return rows.map(row => ({ monitorId: row.monitor_id, targetId: row.target_id, baseline: Boolean(row.baseline), cursor: row.cursor, continuation: row.continuation, complete: Boolean(row.complete), detail: row.detail, lastCheckedAt: row.last_checked_at }));
  }
  pendingEvents(id: string, limit = 100): MonitorEvent[] { this.get(id); this.limit(limit); return this.eventRows("SELECT * FROM browser_monitor_events WHERE monitor_id = ? AND processed = 0 ORDER BY observed_at, id LIMIT ?", id, limit); }
  private limit(limit: number): void { z.number().int().min(1).max(200).parse(limit); }
  private eventRows(sql: string, ...parameters: Array<string | number>): MonitorEvent[] { return (this.db.prepare(sql).all(...parameters) as unknown as EventRow[]).map(row => ({ ...JSON.parse(row.item) as MonitorItem, id: row.id, monitorId: row.monitor_id, observedAt: row.observed_at, processed: Boolean(row.processed), reviewRequired: Boolean(row.review_required) })); }
  markProcessed(eventId: string): void { const result = this.db.prepare("UPDATE browser_monitor_events SET processed = 1 WHERE id = ?").run(eventId); if (!result.changes) throw new Error("Browser monitor event not found"); }
  recover(ownerNodeId: string, now = Date.now()): void {
    z.string().uuid().parse(ownerNodeId); this.transaction(() => {
      const interrupted = this.db.prepare("SELECT DISTINCT monitor_id FROM browser_monitor_runs r JOIN browser_monitor_monitors m ON m.id = r.monitor_id WHERE r.status = 'running' AND m.owner_node_id = ?").all(ownerNodeId) as unknown as { monitor_id: string }[];
      this.db.prepare("UPDATE browser_monitor_runs SET status = 'failed', finished_at = ?, detail = 'Node restarted during check' WHERE status = 'running' AND monitor_id IN (SELECT id FROM browser_monitor_monitors WHERE owner_node_id = ?)").run(now, ownerNodeId);
      for (const { monitor_id: id } of interrupted) this.db.prepare("UPDATE browser_monitor_monitors SET generation = generation + 1, health = CASE WHEN enabled = 1 THEN 'ready' ELSE health END, detail = CASE WHEN enabled = 1 THEN 'Check recovered after restart' ELSE detail END, next_due_at = CASE WHEN enabled = 1 THEN ? ELSE next_due_at END, updated_at = ? WHERE id = ?").run(now, now, id);
      this.db.prepare("UPDATE browser_monitor_monitors SET next_due_at = ?, health = 'ready', detail = 'Check recovered after restart', updated_at = ? WHERE owner_node_id = ? AND enabled = 1 AND next_due_at <= ?").run(now, now, ownerNodeId, now);
    });
  }
  delete(id: string, generation: number): void {
    this.transaction(() => { const monitor = this.current(id, generation); if (monitor.enabled) throw new Error("Pause browser monitor before deleting"); if (this.active(id)) throw new Error("Browser monitor is already checking"); this.db.prepare("DELETE FROM browser_monitor_events WHERE monitor_id = ?").run(id); this.db.prepare("DELETE FROM browser_monitor_runs WHERE monitor_id = ?").run(id); this.db.prepare("DELETE FROM browser_monitor_monitors WHERE id = ?").run(id); });
  }
}

let singleton: BrowserMonitorStore | undefined;
export function browserMonitorStore(): BrowserMonitorStore {
  if (!singleton) { const directory = resolveDataDirectory(); mkdirSync(directory, { recursive: true, mode: 0o700 }); const db = new DatabaseSync(path.join(directory, "node.db")); db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;"); singleton = new BrowserMonitorStore(db); }
  return singleton;
}
