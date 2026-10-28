import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { tagSnapshotSchema } from "./automation-tags.js";

export const automationExecutionSchema = z.object({
  id: z.string().uuid(), sourceKind: z.enum(["scheduled", "webhook"]), sourceId: z.string().min(1), sourceName: z.string().min(1),
  workspaceId: z.string().min(1).nullable(), projectId: z.string().min(1), ownerNodeId: z.string().min(1), engine: z.string().nullable(),
  requestId: z.string().min(1), sessionId: z.string().nullable(), tags: z.array(tagSnapshotSchema).max(20), status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"]),
  error: z.string().nullable(), acceptedAt: z.string().datetime(), startedAt: z.string().datetime().nullable(), finishedAt: z.string().datetime().nullable(),
}).strict();
export type AutomationExecution = z.infer<typeof automationExecutionSchema>;

export function ensureAutomationExecutionSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS automation_executions (
    id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_id TEXT NOT NULL, source_name TEXT NOT NULL,
    workspace_id TEXT, project_id TEXT NOT NULL, owner_node_id TEXT NOT NULL, engine TEXT, request_id TEXT NOT NULL UNIQUE,
    session_id TEXT, tags TEXT NOT NULL, status TEXT NOT NULL, error TEXT, accepted_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
    CREATE INDEX IF NOT EXISTS automation_executions_workspace_date ON automation_executions(workspace_id, accepted_at DESC);
    CREATE INDEX IF NOT EXISTS automation_executions_project_date ON automation_executions(project_id, accepted_at DESC);
    CREATE INDEX IF NOT EXISTS automation_executions_source_date ON automation_executions(source_kind, source_id, accepted_at DESC);`);
}

export function createAutomationExecution(db: DatabaseSync, raw: AutomationExecution): void {
  ensureAutomationExecutionSchema(db);
  const execution = automationExecutionSchema.parse(raw);
  db.prepare(`INSERT INTO automation_executions(id,source_kind,source_id,source_name,workspace_id,project_id,owner_node_id,engine,request_id,session_id,tags,status,error,accepted_at,started_at,finished_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).run(execution.id, execution.sourceKind, execution.sourceId, execution.sourceName, execution.workspaceId, execution.projectId, execution.ownerNodeId, execution.engine, execution.requestId, execution.sessionId, JSON.stringify(execution.tags), execution.status, execution.error, execution.acceptedAt, execution.startedAt, execution.finishedAt);
  const stored = db.prepare("SELECT request_id requestId,source_id sourceId,source_name sourceName,tags FROM automation_executions WHERE id=?").get(execution.id) as { requestId: string; sourceId: string; sourceName: string; tags: string };
  if (stored.requestId !== execution.requestId || stored.sourceId !== execution.sourceId || stored.sourceName !== execution.sourceName || stored.tags !== JSON.stringify(execution.tags)) throw new Error("Conflicting automation execution identity");
}

export function transitionAutomationExecution(db: DatabaseSync, requestId: string, status: AutomationExecution["status"], error: string | null = null, sessionId: string | null = null): void {
  ensureAutomationExecutionSchema(db);
  const current = db.prepare("SELECT status,started_at startedAt FROM automation_executions WHERE request_id=?").get(requestId) as { status: AutomationExecution["status"]; startedAt: string | null } | undefined;
  if (!current) return;
  if (["succeeded", "failed", "cancelled", "interrupted"].includes(current.status)) return;
  const now = new Date().toISOString();
  const startedAt = status === "running" ? current.startedAt ?? now : current.startedAt;
  const finishedAt = ["succeeded", "failed", "cancelled", "interrupted"].includes(status) ? now : null;
  db.prepare("UPDATE automation_executions SET status=?,error=?,session_id=COALESCE(?,session_id),started_at=?,finished_at=? WHERE request_id=?").run(status, error?.slice(0, 2000) ?? null, sessionId, startedAt, finishedAt, requestId);
}

export function automationExecutions(db: DatabaseSync, workspaceId: string): AutomationExecution[] {
  ensureAutomationExecutionSchema(db);
  const rows = db.prepare(`SELECT id,source_kind sourceKind,source_id sourceId,source_name sourceName,workspace_id workspaceId,project_id projectId,owner_node_id ownerNodeId,engine,request_id requestId,session_id sessionId,tags,status,error,accepted_at acceptedAt,started_at startedAt,finished_at finishedAt
    FROM automation_executions WHERE workspace_id=? ORDER BY accepted_at DESC,id`).all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(row => automationExecutionSchema.parse({ ...row, tags: JSON.parse(String(row.tags)) }));
}
