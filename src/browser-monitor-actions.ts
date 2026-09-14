import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { browserMonitorRuleCandidates, browserMonitorRuleRevision, type BrowserMonitorRuleRecord } from "./browser-monitor-rules.js";
import { resolveDataDirectory } from "./data-directory.js";
import { monitorItemSchema, type MonitorEvent, type MonitorRecord } from "./browser-monitor-types.js";
import { BrowserMonitorStore } from "./browser-monitors.js";

export type BrowserMonitorActionState = "collecting" | "generating" | "awaiting-approval" | "approved" | "rejected" | "cancelled";
export interface BrowserMonitorAction {
  id: string;
  monitorId: string;
  projectId: string;
  targetId: string;
  ruleId: string;
  ruleVersion: number;
  rulesRevision: string;
  generation: number;
  version: number;
  state: BrowserMonitorActionState;
  createdAt: number;
  updatedAt: number;
  dueAt: number;
  deadlineAt: number;
  claimToken: string | null;
  attempts: number;
  reviewRequired: boolean;
  eventIds: string[];
  draft: string | null;
  draftHash: string | null;
  sourceRevision: string | null;
  recipients: string[];
  detail: string;
}

type ActionRow = {
  id: string;
  monitor_id: string;
  project_id: string;
  target_id: string;
  rule_id: string;
  rule_version: number;
  rules_revision: string;
  generation: number;
  version: number;
  state: string;
  created_at: number;
  updated_at: number;
  due_at: number;
  deadline_at: number;
  claim_token: string | null;
  attempts: number;
  review_required: number;
  draft: string | null;
  draft_hash: string | null;
  source_revision: string | null;
  recipients: string;
  detail: string;
};

type EventRow = {
  id: string;
  monitor_id: string;
  item: string;
  observed_at: number;
  processed: number;
  review_required: number;
  action_id: string | null;
};
const uuid = z.string().uuid();
const project = z.string().min(1).max(200);
const timestamp = z.number().int().nonnegative().safe();
const positiveInteger = z.number().int().positive().safe();
const stateSchema = z.enum(["collecting", "generating", "awaiting-approval", "approved", "rejected", "cancelled"]);
const recipientsSchema = z.array(z.string().min(1).max(320)).min(1).max(200)
  .refine(recipients => new Set(recipients).size === recipients.length, "Recipients must be unique");
const draftInputSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  sourceRevision: z.string().min(1).max(1024),
  recipients: recipientsSchema,
}).strict();
const windowSchema = z.object({
  quietSeconds: z.number().int().min(1).max(300),
  maxWaitSeconds: z.number().int().min(1).max(600),
}).strict().refine(window => window.maxWaitSeconds >= window.quietSeconds, {
  message: "Maximum wait must not be shorter than quiet time",
  path: ["maxWaitSeconds"],
});
const ACTION_TABLES = `
      CREATE TABLE IF NOT EXISTS browser_monitor_actions (
        id TEXT PRIMARY KEY,
        monitor_id TEXT NOT NULL REFERENCES browser_monitor_monitors(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        rule_version INTEGER NOT NULL,
        rules_revision TEXT NOT NULL,
        generation INTEGER NOT NULL,
        version INTEGER NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        due_at INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL,
        claim_token TEXT,
        attempts INTEGER NOT NULL,
        review_required INTEGER NOT NULL,
        draft TEXT,
        draft_hash TEXT,
        source_revision TEXT,
        recipients TEXT NOT NULL,
        detail TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS browser_monitor_action_events (
        event_id TEXT PRIMARY KEY REFERENCES browser_monitor_events(id) ON DELETE CASCADE,
        action_id TEXT NOT NULL REFERENCES browser_monitor_actions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        UNIQUE(action_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS browser_monitor_action_members
        ON browser_monitor_action_events(action_id, ordinal);
      CREATE INDEX IF NOT EXISTS browser_monitor_actions_project
        ON browser_monitor_actions(project_id, created_at, id);
    `;

export class BrowserMonitorActions {
  private readonly monitors: BrowserMonitorStore;
  constructor(private readonly db: DatabaseSync) {
    this.monitors = new BrowserMonitorStore(db);
    db.exec(ACTION_TABLES);
    db.exec("BEGIN IMMEDIATE");
    try {
      const columns = db.prepare("PRAGMA table_info(browser_monitor_actions)").all() as unknown as Array<{ name: string }>;
      if (!columns.some(column => column.name === "rules_revision")) {
        db.exec(`ALTER TABLE browser_monitor_actions ADD COLUMN rules_revision TEXT NOT NULL DEFAULT '${"0".repeat(64)}'`);
        db.exec("UPDATE browser_monitor_actions SET state='cancelled',version=version+1,claim_token=NULL,detail='Rule authorization requires renewal after upgrade' WHERE state IN ('collecting','generating','awaiting-approval','approved')");
      }
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  close(): void {
    this.monitors.close();
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private record(row: ActionRow): BrowserMonitorAction {
    const memberRows = this.db.prepare(`
      SELECT ae.event_id
      FROM browser_monitor_action_events ae
      JOIN browser_monitor_events e ON e.id = ae.event_id
      WHERE ae.action_id = ?
      ORDER BY COALESCE(json_extract(e.item, '$.occurredAt'), e.observed_at), e.observed_at, e.id
    `).all(row.id) as unknown as { event_id: string }[];
    const eventIds = memberRows.map(member => uuid.parse(member.event_id));
    const state = stateSchema.parse(row.state);
    const claimToken = z.string().uuid().nullable().parse(row.claim_token);
    const draft = z.string().min(1).max(4000).nullable().parse(row.draft);
    const draftHash = z.string().regex(/^[a-f0-9]{64}$/).nullable().parse(row.draft_hash);
    const sourceRevision = z.string().min(1).max(1024).nullable().parse(row.source_revision);
    const recipients = z.array(z.string().min(1).max(320)).max(200)
      .refine(values => new Set(values).size === values.length, "Recipients must be unique")
      .parse(JSON.parse(row.recipients));
    if (state === "generating" && claimToken === null) throw new Error("Generating action requires a claim token");
    if (state === "awaiting-approval" || state === "approved") {
      if (draft === null || draftHash === null || sourceRevision === null || recipients.length === 0) {
        throw new Error("Approval action has incomplete draft metadata");
      }
      if (createHash("sha256").update(draft).digest("hex") !== draftHash) {
        throw new Error("Browser monitor draft hash does not match draft");
      }
    }
    return {
      id: uuid.parse(row.id), monitorId: uuid.parse(row.monitor_id),
      projectId: project.parse(row.project_id), targetId: z.string().min(1).max(320).parse(row.target_id),
      ruleId: uuid.parse(row.rule_id), ruleVersion: positiveInteger.parse(row.rule_version),
      rulesRevision: z.string().regex(/^[a-f0-9]{64}$/).parse(row.rules_revision),
      generation: positiveInteger.parse(row.generation), version: positiveInteger.parse(row.version), state,
      createdAt: timestamp.parse(row.created_at), updatedAt: timestamp.parse(row.updated_at),
      dueAt: timestamp.parse(row.due_at), deadlineAt: timestamp.parse(row.deadline_at), claimToken,
      attempts: z.number().int().nonnegative().safe().parse(row.attempts),
      reviewRequired: z.union([z.literal(0), z.literal(1)]).transform(Boolean).parse(row.review_required),
      eventIds, draft, draftHash, sourceRevision, recipients,
      detail: z.string().max(2000).parse(row.detail),
    };
  }
  private scoped(projectId: string, id: string): ActionRow {
    project.parse(projectId);
    uuid.parse(id);
    const row = this.db.prepare("SELECT * FROM browser_monitor_actions WHERE project_id=? AND id=?").get(projectId, id) as ActionRow | undefined;
    if (!row) throw new Error("Browser monitor action not found");
    return row;
  }

  getForProject(projectId: string, id: string): BrowserMonitorAction {
    return this.record(this.scoped(projectId, id));
  }
  list(projectId: string, limit = 50, before?: { createdAt: number; id: string }): BrowserMonitorAction[] {
    project.parse(projectId);
    z.number().int().min(1).max(200).parse(limit);
    if (before) {
      timestamp.parse(before.createdAt);
      uuid.parse(before.id);
    }
    const sql = before
      ? "SELECT * FROM browser_monitor_actions WHERE project_id=? AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?"
      : "SELECT * FROM browser_monitor_actions WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT ?";
    const rows = (before
      ? this.db.prepare(sql).all(projectId, before.createdAt, before.createdAt, before.id, limit)
      : this.db.prepare(sql).all(projectId, limit)) as unknown as ActionRow[];
    return rows.map(row => this.record(row));
  }
  private fresh(row: ActionRow): { monitor: MonitorRecord; rule: BrowserMonitorRuleRecord } {
    const monitor = this.monitors.getForProject(row.monitor_id, row.project_id);
    if (!monitor.enabled) throw new Error("Browser monitor is paused");
    if (monitor.generation !== row.generation) throw new Error("Browser monitor changed; refresh before continuing");
    const rule = this.monitors.getRule(row.monitor_id, row.rule_id);
    if (!rule.enabled) throw new Error("Browser monitor rule is paused");
    if (rule.version !== row.rule_version) throw new Error("Browser monitor rule changed; refresh before continuing");
    if (rule.input.action.type !== "reply") throw new Error("Browser monitor rule no longer replies");
    const revision = browserMonitorRuleRevision(this.monitors.listRules(row.monitor_id));
    if (revision !== row.rules_revision) throw new Error("Browser monitor rules changed; refresh before continuing");
    return { monitor, rule };
  }
  private eventRows(monitorId: string, eventIds: string[]): EventRow[] {
    const rows = eventIds.map(id => this.db.prepare(
      "SELECT e.*,ae.action_id FROM browser_monitor_events e LEFT JOIN browser_monitor_action_events ae ON ae.event_id=e.id WHERE e.id=? AND e.monitor_id=?",
    ).get(id, monitorId) as EventRow | undefined);
    if (rows.some(row => !row)) throw new Error("Browser monitor event not found");
    return rows as EventRow[];
  }
  enqueue(
    projectId: string,
    monitorId: string,
    ruleId: string,
    ruleVersion: number,
    eventIds: string[],
    window: { quietSeconds: number; maxWaitSeconds: number },
    now = Date.now(),
  ): BrowserMonitorAction {
    project.parse(projectId);
    uuid.parse(monitorId);
    uuid.parse(ruleId);
    positiveInteger.parse(ruleVersion);
    timestamp.parse(now);
    z.array(uuid).min(1).max(100)
      .refine(values => new Set(values).size === values.length, "Event IDs must be unique")
      .parse(eventIds);
    const validWindow = windowSchema.parse(window);
    return this.transaction(() => this.enqueueTransaction(
      projectId, monitorId, ruleId, ruleVersion, eventIds,
      validWindow.quietSeconds, validWindow.maxWaitSeconds, now,
    ));
  }
  private enqueueTransaction(
    projectId: string, monitorId: string, ruleId: string, ruleVersion: number,
    eventIds: string[], quiet: number, max: number, now: number,
  ): BrowserMonitorAction {
    const monitor = this.monitors.getForProject(monitorId, projectId);
    if (!monitor.enabled) throw new Error("Browser monitor is paused");
    const rule = this.monitors.getRule(monitorId, ruleId);
    if (!rule.enabled || rule.version !== ruleVersion || rule.input.action.type !== "reply") {
      throw new Error("Browser monitor rule changed or paused");
    }
    const rows = this.eventRows(monitorId, eventIds);
    const owners = [...new Set(rows.map(row => row.action_id).filter(Boolean))] as string[];
    if (owners.length === 1 && rows.every(row => row.action_id === owners[0])) {
      const owned = this.record(this.scoped(projectId, owners[0]));
      if (owned.generation !== monitor.generation) throw new Error("Browser monitor changed; refresh before continuing");
      const targetId = monitorItemSchema.parse(JSON.parse(rows[0].item)).targetId;
      if (owned.ruleId === ruleId && owned.ruleVersion === ruleVersion && owned.targetId === targetId) return owned;
    }
    if (owners.length || rows.some(row => row.processed)) throw new Error("Browser monitor event already assigned");
    const events = rows.map(row => ({
      ...monitorItemSchema.parse(JSON.parse(row.item)),
      id: row.id,
      monitorId,
      observedAt: row.observed_at,
      processed: false,
      reviewRequired: Boolean(row.review_required),
    }));
    const target = events[0].targetId;
    if (events.some(event => event.targetId !== target || event.direction !== "incoming" || event.kind !== "message.received")) {
      throw new Error("Browser monitor events cannot form a reply batch");
    }
    if (monitor.targetIds.length && !monitor.targetIds.includes(target)) throw new Error("Browser monitor target is outside scope");
    for (const event of events) {
      const eligible = browserMonitorRuleCandidates(event, this.monitors.listRules(monitorId));
      if (!eligible.some(candidate => candidate.id === ruleId)) throw new Error("Browser monitor rule is not eligible");
    }
    return this.appendOrCreate(projectId, monitor, rule, events, quiet, max, now);
  }
  private appendOrCreate(
    projectId: string, monitor: MonitorRecord, rule: BrowserMonitorRuleRecord,
    events: MonitorEvent[], quiet: number, max: number, now: number,
  ): BrowserMonitorAction {
    const rulesRevision = browserMonitorRuleRevision(this.monitors.listRules(monitor.id));
    let row = this.db.prepare("SELECT a.* FROM browser_monitor_actions a WHERE monitor_id=? AND target_id=? AND rule_id=? AND rule_version=? AND rules_revision=? AND generation=? AND state='collecting' AND due_at>? AND deadline_at>? AND (SELECT COUNT(*) FROM browser_monitor_action_events WHERE action_id=a.id)+?<=100 ORDER BY created_at,id LIMIT 1")
      .get(monitor.id, events[0].targetId, rule.id, rule.version, rulesRevision, monitor.generation, now, now, events.length) as ActionRow | undefined;
    const reviewRequired = Number(events.some(event => event.reviewRequired !== false));
    if (!row) {
      const id = randomUUID();
      const deadline = now + max * 1000;
      const due = Math.min(now + quiet * 1000, deadline);
      this.db.prepare("INSERT INTO browser_monitor_actions (id,monitor_id,project_id,target_id,rule_id,rule_version,rules_revision,generation,version,state,created_at,updated_at,due_at,deadline_at,claim_token,attempts,review_required,draft,draft_hash,source_revision,recipients,detail) VALUES (?,?,?,?,?,?,?,?,1,'collecting',?,?,?,?,NULL,0,?,NULL,NULL,NULL,'[]','')")
        .run(id, monitor.id, projectId, events[0].targetId, rule.id, rule.version, rulesRevision, monitor.generation, now, now, due, deadline, reviewRequired);
      row = this.scoped(projectId, id);
    } else {
      this.db.prepare("UPDATE browser_monitor_actions SET version=version+1,updated_at=?,due_at=MIN(?,deadline_at),review_required=MAX(review_required,?) WHERE id=?")
        .run(now, now + quiet * 1000, reviewRequired, row.id);
      row = this.scoped(projectId, row.id);
    }
    const countRow = this.db.prepare("SELECT COUNT(*) count FROM browser_monitor_action_events WHERE action_id=?").get(row.id) as { count: number };
    const ordered = row.version === 1
      ? [...events].sort((a, b) => (a.occurredAt ?? a.observedAt) - (b.occurredAt ?? b.observedAt)
        || a.observedAt - b.observedAt || a.id.localeCompare(b.id))
      : events;
    ordered.forEach((event, index) => {
      this.db.prepare("INSERT INTO browser_monitor_action_events VALUES (?,?,?)").run(event.id, row.id, countRow.count + index);
      const changed = this.db.prepare("UPDATE browser_monitor_events SET processed=1 WHERE id=? AND processed=0").run(event.id);
      if (changed.changes !== 1) throw new Error("Browser monitor event already processed");
    });
    return this.getForProject(projectId, row.id);
  }
  claim(projectId: string, id: string, version: number, now = Date.now()): BrowserMonitorAction {
    timestamp.parse(now);
    positiveInteger.parse(version);
    return this.transaction(() => {
      const row = this.scoped(projectId, id);
      if (row.version !== version) throw new Error("Browser monitor action changed; refresh before continuing");
      if (row.state !== "collecting" || row.due_at > now) throw new Error("Browser monitor action is not ready");
      this.fresh(row);
      if (row.attempts >= 3) throw new Error("Browser monitor draft retry budget exhausted");
      this.db.prepare("UPDATE browser_monitor_actions SET state='generating',version=version+1,claim_token=?,attempts=attempts+1,updated_at=? WHERE id=?").run(randomUUID(), now, id);
      return this.getForProject(projectId, id);
    });
  }
  saveDraft(projectId: string, id: string, token: string, input: { text: string; sourceRevision: string; recipients: string[] }, now = Date.now()): BrowserMonitorAction {
    uuid.parse(token);
    timestamp.parse(now);
    const valid = draftInputSchema.parse(input);
    return this.transaction(() => {
      const row = this.scoped(projectId, id);
      if (row.state !== "generating" || row.claim_token !== token) throw new Error("Browser monitor draft claim is stale");
      this.fresh(row);
      const hash = createHash("sha256").update(valid.text).digest("hex");
      this.db.prepare("UPDATE browser_monitor_actions SET state='awaiting-approval',version=version+1,claim_token=NULL,draft=?,draft_hash=?,source_revision=?,recipients=?,updated_at=? WHERE id=?").run(valid.text, hash, valid.sourceRevision, JSON.stringify(valid.recipients), now, id);
      return this.getForProject(projectId, id);
    });
  }
  editDraft(projectId: string, id: string, version: number, text: string, now = Date.now()): BrowserMonitorAction {
    const valid = z.string().trim().min(1).max(4000).parse(text);
    timestamp.parse(now);
    return this.transaction(() => {
      const row = this.mutable(projectId, id, version, ["awaiting-approval", "approved"]);
      this.fresh(row);
      const hash = createHash("sha256").update(valid).digest("hex");
      this.db.prepare("UPDATE browser_monitor_actions SET state='awaiting-approval',version=version+1,draft=?,draft_hash=?,updated_at=? WHERE id=?")
        .run(valid, hash, now, id);
      return this.getForProject(projectId, id);
    });
  }
  private mutable(projectId: string, id: string, version: number, states: string[]): ActionRow {
    positiveInteger.parse(version);
    const row = this.scoped(projectId, id);
    if (row.version !== version) throw new Error("Browser monitor action changed; refresh before continuing");
    if (!states.includes(row.state)) throw new Error("Browser monitor action state does not allow this operation");
    return row;
  }
  approve(projectId: string, id: string, version: number, now = Date.now()): BrowserMonitorAction {
    timestamp.parse(now);
    return this.transaction(() => {
      const row = this.mutable(projectId, id, version, ["awaiting-approval"]);
      this.fresh(row);
      const record = this.record(row);
      recipientsSchema.parse(record.recipients);
      if (!record.draft || !record.draftHash || !record.sourceRevision) throw new Error("Browser monitor draft is incomplete");
      this.db.prepare("UPDATE browser_monitor_actions SET state='approved',version=version+1,updated_at=? WHERE id=?").run(now, id);
      return this.getForProject(projectId, id);
    });
  }
  reject(projectId: string, id: string, version: number, now = Date.now()): BrowserMonitorAction {
    timestamp.parse(now);
    return this.transaction(() => {
      this.mutable(projectId, id, version, ["collecting", "generating", "awaiting-approval", "approved"]);
      this.db.prepare("UPDATE browser_monitor_actions SET state='rejected',version=version+1,claim_token=NULL,updated_at=?,detail='Rejected by user' WHERE id=?").run(now, id);
      return this.getForProject(projectId, id);
    });
  }
  cancelConversation(projectId: string, monitorId: string, targetId: string, detail: string, now = Date.now()): number {
    project.parse(projectId);
    uuid.parse(monitorId);
    z.string().min(1).max(320).parse(targetId);
    const valid = z.string().trim().min(1).max(2000).parse(detail);
    timestamp.parse(now);
    this.monitors.getForProject(monitorId, projectId);
    return Number(this.db.prepare("UPDATE browser_monitor_actions SET state='cancelled',version=version+1,claim_token=NULL,updated_at=?,detail=? WHERE project_id=? AND monitor_id=? AND target_id=? AND state IN ('collecting','generating','awaiting-approval','approved')")
      .run(now, valid, projectId, monitorId, targetId).changes);
  }
  recover(ownerNodeId: string, now = Date.now()): number {
    uuid.parse(ownerNodeId);
    timestamp.parse(now);
    return this.transaction(() => {
      let changed = 0;
      changed += Number(this.db.prepare("UPDATE browser_monitor_actions SET version=version+1,review_required=1,updated_at=?,detail='Interrupted draft requires review' WHERE state='collecting' AND due_at<=? AND monitor_id IN (SELECT id FROM browser_monitor_monitors WHERE owner_node_id=?)")
        .run(now, now, ownerNodeId).changes);
      changed += Number(this.db.prepare("UPDATE browser_monitor_actions SET state='collecting',version=version+1,claim_token=NULL,due_at=?,updated_at=?,review_required=1,detail='Interrupted draft requires review' WHERE state='generating' AND monitor_id IN (SELECT id FROM browser_monitor_monitors WHERE owner_node_id=?)")
        .run(now, now, ownerNodeId).changes);
      changed += Number(this.db.prepare("UPDATE browser_monitor_actions SET state='awaiting-approval',version=version+1,updated_at=?,review_required=1,detail='Approval requires review after restart' WHERE state='approved' AND monitor_id IN (SELECT id FROM browser_monitor_monitors WHERE owner_node_id=?)")
        .run(now, ownerNodeId).changes);
      return changed;
    });
  }
}

let singleton: BrowserMonitorActions | undefined;
export function browserMonitorActions(): BrowserMonitorActions {
  if (!singleton) {
    const directory = resolveDataDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path.join(directory, "node.db"));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    singleton = new BrowserMonitorActions(db);
  }
  return singleton;
}
