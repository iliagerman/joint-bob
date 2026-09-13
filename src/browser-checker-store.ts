import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { browserCheckerSchema, type BrowserChecker } from "./browser-monitor-checkers.js";
import { resolveDataDirectory } from "./data-directory.js";

const scopedIdSchema = z.string().trim().min(1).max(200);
const checkerIdSchema = z.string().trim().min(1).max(100);
const versionSchema = z.number().int().positive().safe();
const timestampSchema = z.number().int().nonnegative().safe();
type CheckerRow = { project_id: string; id: string; version: number; definition: string; digest: string; created_by: string; created_at: number };

export interface BrowserCheckerVersion {
  projectId: string;
  definition: BrowserChecker;
  digest: string;
  createdBy: string;
  createdAt: number;
}

function digest(serialized: string): string {
  return createHash("sha256").update(serialized).digest("hex");
}

function decode(row: CheckerRow): BrowserCheckerVersion {
  const projectId = scopedIdSchema.parse(row.project_id);
  const createdBy = scopedIdSchema.parse(row.created_by);
  const createdAt = timestampSchema.parse(row.created_at);
  const definition = browserCheckerSchema.parse(JSON.parse(row.definition));
  checkerIdSchema.parse(row.id); versionSchema.parse(row.version);
  if (definition.id !== row.id || definition.version !== row.version || row.digest !== digest(JSON.stringify(definition)))
    throw new Error("Browser checker integrity check failed");
  return { projectId, definition, digest: row.digest, createdBy, createdAt };
}

export class BrowserCheckerStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS browser_monitor_checkers (
      project_id TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
      definition TEXT NOT NULL, digest TEXT NOT NULL, created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY(project_id, id, version));
      CREATE INDEX IF NOT EXISTS browser_monitor_checkers_latest
      ON browser_monitor_checkers(project_id, created_at DESC, id, version DESC);`);
  }

  install(projectId: string, definition: unknown, createdBy: string, now = Date.now()): BrowserCheckerVersion {
    const validProjectId = scopedIdSchema.parse(projectId);
    const validCreatedBy = scopedIdSchema.parse(createdBy);
    const validNow = timestampSchema.parse(now);
    const parsed = browserCheckerSchema.parse(definition);
    const existing = this.db.prepare("SELECT 1 FROM browser_monitor_checkers WHERE project_id = ? AND id = ? AND version = ?").get(validProjectId, parsed.id, parsed.version);
    if (existing) throw new Error("Checker version already exists");
    const serialized = JSON.stringify(parsed);
    this.db.prepare("INSERT INTO browser_monitor_checkers VALUES (?, ?, ?, ?, ?, ?, ?)").run(validProjectId, parsed.id, parsed.version, serialized, digest(serialized), validCreatedBy, validNow);
    return this.get(validProjectId, parsed.id, parsed.version);
  }

  get(projectId: string, id: string, version: number): BrowserCheckerVersion {
    const validProjectId = scopedIdSchema.parse(projectId);
    const validId = checkerIdSchema.parse(id);
    const validVersion = versionSchema.parse(version);
    const row = this.db.prepare("SELECT * FROM browser_monitor_checkers WHERE project_id = ? AND id = ? AND version = ?").get(validProjectId, validId, validVersion) as CheckerRow | undefined;
    if (!row) throw new Error("Browser checker version not found");
    return decode(row);
  }

  list(projectId: string): BrowserCheckerVersion[] {
    const validProjectId = scopedIdSchema.parse(projectId);
    const rows = this.db.prepare("SELECT * FROM browser_monitor_checkers WHERE project_id = ? ORDER BY created_at DESC, id ASC, version DESC LIMIT 200").all(validProjectId) as unknown as CheckerRow[];
    return rows.map(decode);
  }

  close(): void { this.db.close(); }
}

let singleton: BrowserCheckerStore | undefined;
export function browserCheckerStore(): BrowserCheckerStore {
  if (!singleton) {
    const directory = resolveDataDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(path.join(directory, "node.db"));
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    singleton = new BrowserCheckerStore(db);
  }
  return singleton;
}
