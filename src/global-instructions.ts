import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { globalInstructionsPath } from "./agent-instructions.js";
import { agentResourcePaths } from "./agent-resources.js";
import { enqueueReplicationEvent, ensureReplicationSchema, type ReplicationEvent } from "./replication.js";
import { settingsDatabase } from "./settings-store.js";

/** Large enough for any real AGENTS.md, small enough to travel in one replication event. */
export const INSTRUCTIONS_LIMIT = 256 * 1024;
/** The version of a file that does not exist yet; saving against it creates the file. */
export const ABSENT_VERSION = "absent";

export class InstructionsConflict extends Error {}

export function instructionsVersion(content: string | undefined): string {
  return content === undefined ? ABSENT_VERSION : createHash("sha256").update(content).digest("hex");
}

export function readOptionalText(file: string): string | undefined {
  try { return readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** Replaces a file in one step, so an agent starting meanwhile reads the old text or the new one. */
export function writeTextAtomically(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try { writeFileSync(temporary, content, { flag: "wx" }); renameSync(temporary, file); }
  finally { rmSync(temporary, { force: true }); }
}

export function ensureGlobalInstructionsSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS global_instructions (
    name TEXT PRIMARY KEY CHECK(name = 'AGENTS.md'),
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    origin_node_id TEXT NOT NULL
  )`);
}

type Stamp = { updatedAt: string; originNodeId: string };

function stored(db: DatabaseSync): Stamp | undefined {
  const row = db.prepare("SELECT updated_at, origin_node_id FROM global_instructions WHERE name = 'AGENTS.md'").get() as { updated_at: string; origin_node_id: string } | undefined;
  return row && { updatedAt: row.updated_at, originNodeId: row.origin_node_id };
}

function newer(candidate: Stamp, held: Stamp | undefined): boolean {
  return !held || candidate.updatedAt > held.updatedAt || candidate.updatedAt === held.updatedAt && candidate.originNodeId > held.originNodeId;
}

function record(db: DatabaseSync, content: string, stamp: Stamp): void {
  db.prepare(`INSERT INTO global_instructions (name, content, updated_at, origin_node_id) VALUES ('AGENTS.md', ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at, origin_node_id = excluded.origin_node_id`)
    .run(content, stamp.updatedAt, stamp.originNodeId);
}

export function readGlobalInstructions(): { path: string; content: string; version: string } {
  const content = readOptionalText(globalInstructionsPath(agentResourcePaths()));
  return { path: "AGENTS.md", content: content ?? "", version: instructionsVersion(content) };
}

/**
 * Saves the AGENTS.md every project's agents read and sends it to this person's other machines,
 * where the newest edit wins. `version` is what the editor opened, so an edit made meanwhile,
 * here or on another machine, is never overwritten unseen.
 */
export function saveGlobalInstructions(content: string, version: string, originNodeId: string): { path: string; version: string } {
  if (Buffer.byteLength(content) > INSTRUCTIONS_LIMIT) throw new RangeError("AGENTS.md is too large");
  const file = globalInstructionsPath(agentResourcePaths());
  const db = settingsDatabase();
  ensureGlobalInstructionsSchema(db);
  ensureReplicationSchema(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (instructionsVersion(readOptionalText(file)) !== version) throw new InstructionsConflict("AGENTS.md changed since it was opened");
    const held = stored(db);
    const now = new Date();
    // A clock behind the last edit must still produce the newest stamp.
    const updatedAt = held && held.updatedAt >= now.toISOString() ? new Date(Date.parse(held.updatedAt) + 1).toISOString() : now.toISOString();
    const stamp = { updatedAt, originNodeId };
    writeTextAtomically(file, content);
    record(db, content, stamp);
    enqueueReplicationEvent(db, { originNodeId, entityType: "instructions.global", entityKey: "AGENTS.md", operation: "upsert", payload: { content, ...stamp } });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { path: "AGENTS.md", version: instructionsVersion(content) };
}

function eventPayload(event: ReplicationEvent): { content: string } & Stamp {
  const value = event.payload as Record<string, unknown> | null;
  if (!value || typeof value.content !== "string" || Buffer.byteLength(value.content) > INSTRUCTIONS_LIMIT
    || typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt))
    || value.originNodeId !== event.originNodeId || event.entityKey !== "AGENTS.md" || event.operation !== "upsert") {
    throw new Error("Malformed global instructions replication payload");
  }
  return { content: value.content, updatedAt: value.updatedAt, originNodeId: event.originNodeId };
}

export function applyGlobalInstructionsEvent(db: DatabaseSync, event: ReplicationEvent): void {
  const incoming = eventPayload(event);
  ensureGlobalInstructionsSchema(db);
  if (!newer(incoming, stored(db))) return;
  writeTextAtomically(globalInstructionsPath(agentResourcePaths()), incoming.content);
  record(db, incoming.content, incoming);
}
