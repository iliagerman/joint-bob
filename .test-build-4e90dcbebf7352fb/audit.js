import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
const dataDir = resolveDataDirectory();
const databasePath = path.join(dataDir, "node.db");
let database;
function ensureAuditSchema(db) {
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
function appendAuditEvent(db, input) {
  const details = input.details ?? {};
  if (Object.keys(details).some((key) => /password|secret|token|credential|transcript|content/i.test(key))) {
    throw new Error("Audit event details contain a forbidden key");
  }
  const event = {
    id: randomUUID(),
    eventType: input.eventType,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    details,
    createdAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  db.prepare(`
    INSERT INTO audit_events (id, event_type, actor_type, actor_id, entity_type, entity_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(event.id, event.eventType, event.actorType, event.actorId ?? null, event.entityType, event.entityId ?? null, JSON.stringify(event.details), event.createdAt);
  return event;
}
function auditDatabase() {
  if (database) return database;
  mkdirSync(dataDir, { recursive: true, mode: 448 });
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  ensureAuditSchema(database);
  return database;
}
async function listAuditEvents(limit) {
  const boundedLimit = Math.max(1, Math.min(200, limit));
  const rows = auditDatabase().prepare(`
    SELECT id, event_type, actor_type, actor_id, entity_type, entity_id, details, created_at
    FROM audit_events ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(boundedLimit);
  return rows.map((row) => ({
    id: row.id,
    eventType: row.event_type,
    actorType: row.actor_type,
    actorId: row.actor_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    details: JSON.parse(row.details),
    createdAt: row.created_at
  }));
}
export {
  appendAuditEvent,
  ensureAuditSchema,
  listAuditEvents
};
