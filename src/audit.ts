import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface AuditEventInput {
  eventType: string;
  actorType: "user" | "node" | "system";
  actorId?: string | null;
  entityType: string;
  entityId?: string | null;
  details?: Record<string, string | number | boolean | null>;
}

export interface AuditEventRecord extends AuditEventInput {
  id: string;
  createdAt: string;
}

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
const databasePath = path.join(dataDir, "node.db");
let database: DatabaseSync | undefined;

export function ensureAuditSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      actor_type TEXT NOT NULL,
      actor_id TEXT,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_events_created_at ON audit_events(created_at DESC);
  `);
}

export function appendAuditEvent(db: DatabaseSync, input: AuditEventInput): AuditEventRecord {
  const details = input.details ?? {};
  if (Object.keys(details).some((key) => /password|secret|token|credential|transcript|content/i.test(key))) {
    throw new Error("Audit event details contain a forbidden key");
  }
  const event: AuditEventRecord = {
    id: randomUUID(),
    eventType: input.eventType,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    details,
    createdAt: new Date().toISOString(),
  };
  db.prepare(`
    INSERT INTO audit_events (id, event_type, actor_type, actor_id, entity_type, entity_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(event.id, event.eventType, event.actorType, event.actorId ?? null, event.entityType, event.entityId ?? null, JSON.stringify(event.details), event.createdAt);
  return event;
}

function auditDatabase(): DatabaseSync {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL;");
  ensureAuditSchema(database);
  return database;
}

export async function listAuditEvents(limit: number): Promise<AuditEventRecord[]> {
  const boundedLimit = Math.max(1, Math.min(200, limit));
  const rows = auditDatabase().prepare(`
    SELECT id, event_type, actor_type, actor_id, entity_type, entity_id, details, created_at
    FROM audit_events ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(boundedLimit) as unknown as Array<{
    id: string; event_type: string; actor_type: AuditEventInput["actorType"]; actor_id: string | null;
    entity_type: string; entity_id: string | null; details: string; created_at: string;
  }>;
  return rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    details: JSON.parse(row.details) as AuditEventInput["details"],
    createdAt: row.created_at,
  }));
}
