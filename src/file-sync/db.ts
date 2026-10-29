import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { EMPTY_DIGEST } from "./digest.js";
import { parentKey } from "./paths.js";
import type { EntryType, IndexEntry, ShareKind, Vector } from "./types.js";
import { bump, raiseClock } from "./vectors.js";

/* file-sync.db: the worker's regenerable index state (FILE-SYNC design §4). Only the worker opens it,
   with one connection. Losing it starts a new index generation, never a delete (invariant 1), so a
   schema from a newer release is dropped and rebuilt rather than migrated down. The node clock in
   meta is the one value kept across such a rebuild: counters must never go back. */

export const SCHEMA_VERSION = 4;

/** Index entry plus what only this node needs: the on-disk spelling and the stat fingerprint. */
export interface LocalEntry extends IndexEntry {
  /** On-disk relative path when it differs from the NFC key (Linux only); null otherwise. */
  fsName: string | null;
  ino: number;
  ctimeMs: number;
  /** mtime seen on disk. mtimeMs is the version's mtime, which a touch leaves alone (a touch is not a change). */
  fsMtimeMs: number;
  deletedAt: number | null;
}

export interface ShareRow {
  share: string;
  projectId: string;
  kind: ShareKind;
  root: string;
  indexId: string;
  maxSeq: number;
  rootDev: number | null;
  rootIno: number | null;
  /** When the last complete full scan of this generation finished; null until the first one does. */
  fullScanAt: number | null;
  watchState: string;
  scanError: string | null;
  digest: string;
  liveFiles: number;
  liveBytes: number;
  builtinSince: number | null;
  /** The highest seq of a pruned tombstone: a peer whose cursor is below it may have missed a delete. */
  prunedBelow: number;
  rulesHash: string | null;
  /** A replaced-looking root waiting for confirmation (§5.2.1). */
  pendingDev: number | null;
  pendingIno: number | null;
}

export interface ErrorRow { path: string; kind: "error" | "notice" | "blocked"; reason: string; at: number }
export interface CursorRow {
  peer: string;
  /** The peer's index generation our remote rows and `seq` belong to; null before the first page. */
  indexId: string | null;
  seq: number;
  /** What the peer last announced (shares answer, notice, status, index page); its index id may be newer than `indexId`. */
  peerIndexId: string | null;
  peerMaxSeq: number;
  peerDigest: string | null;
  peerRulesHash: string | null;
  peerBuiltinSince: number | null;
  /** A pull of `indexId` reached its end at least once: the remote rows are a whole index, not a first part. */
  listed: boolean;
  /** The peer's prunedBelow when we last stored a page: a higher one above our cursor means tombstones we never saw were pruned. */
  peerPrunedBelow: number;
  updatedAt: number;
}

export type CursorFields = Partial<Omit<CursorRow, "peer" | "updatedAt">>;

/** What decide() asked for, or `move`: a fetch whose bytes are a pending delete's local file in the same share. */
export type NeedAction = "fetch" | "delete" | "mkdir" | "symlink" | "meta" | "move";
/** One path this node must bring to `target` (builtin phase only, §5.4). */
export interface NeedRow {
  path: string;
  action: NeedAction;
  /** move: the path of the same share whose local file is renamed here (its own row is the delete). */
  fromPath: string | null;
  /** The local live file or link loses to the target and is kept as a conflict copy. */
  conflict: boolean;
  priority: number;
  attempts: number;
  /** Not offered again before this (backoff, or a blocked row's retry time); 0 = now. */
  nextAt: number;
  lastError: string | null;
  /** A permanent failure: shown as an error, not counted as pending. */
  blocked: boolean;
  blockedAt: number | null;
  /** The full target version; its seq means nothing here and reads 0. */
  target: IndexEntry;
}
export type NeedFields = Partial<Pick<NeedRow, "action" | "fromPath" | "conflict" | "priority" | "attempts" | "nextAt" | "lastError" | "blocked" | "blockedAt">>;
/** An errors row, or a blocked need row (both are what Settings lists as problems). */
export interface ProblemRow extends ErrorRow { blocked: boolean }

export interface DiffRow { path: string; since: number; kind: string }
export interface ShadowCleanRow { peer: string; cleanSince: number | null; differences: number; checkedAt: number }

export const MIGRATIONS: ReadonlyArray<string> = [
  // 1: the full §4 schema, plus fs_mtime_ms (touch detection), rules_hash and the pending root identity.
  `
  CREATE TABLE IF NOT EXISTS shares(
    share TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, root TEXT NOT NULL, index_id TEXT NOT NULL,
    max_seq INTEGER NOT NULL DEFAULT 0, root_dev INTEGER, root_ino INTEGER, full_scan_at INTEGER,
    watch_state TEXT NOT NULL DEFAULT 'off', scan_error TEXT, digest TEXT NOT NULL,
    live_files INTEGER NOT NULL DEFAULT 0, live_bytes INTEGER NOT NULL DEFAULT 0, builtin_since INTEGER,
    pruned_below INTEGER NOT NULL DEFAULT 0, rules_hash TEXT, pending_dev INTEGER, pending_ino INTEGER);
  CREATE TABLE IF NOT EXISTS entries(
    share TEXT NOT NULL, path TEXT NOT NULL, fs_name TEXT, parent TEXT NOT NULL, type INTEGER NOT NULL, size INTEGER NOT NULL,
    mtime_ms REAL NOT NULL, mode INTEGER NOT NULL, sha256 TEXT, target TEXT, deleted INTEGER NOT NULL, version TEXT NOT NULL,
    modified_by TEXT NOT NULL, seq INTEGER NOT NULL, ino INTEGER NOT NULL DEFAULT 0, ctime_ms REAL NOT NULL DEFAULT 0,
    fs_mtime_ms REAL NOT NULL DEFAULT 0, deleted_at INTEGER, PRIMARY KEY(share, path)) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS entries_seq ON entries(share, seq);
  CREATE INDEX IF NOT EXISTS entries_parent ON entries(share, parent);
  CREATE INDEX IF NOT EXISTS entries_sha ON entries(sha256) WHERE deleted = 0 AND sha256 IS NOT NULL;
  CREATE TABLE IF NOT EXISTS remote(
    share TEXT NOT NULL, peer TEXT NOT NULL, path TEXT NOT NULL, type INTEGER NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL,
    mode INTEGER NOT NULL, sha256 TEXT, target TEXT, deleted INTEGER NOT NULL, version TEXT NOT NULL, modified_by TEXT NOT NULL,
    seq INTEGER NOT NULL, PRIMARY KEY(share, peer, path)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS cursors(
    share TEXT NOT NULL, peer TEXT NOT NULL, index_id TEXT, seq INTEGER NOT NULL DEFAULT 0, peer_max_seq INTEGER NOT NULL DEFAULT 0,
    peer_digest TEXT, peer_rules_hash TEXT, peer_builtin_since INTEGER, updated_at INTEGER NOT NULL, PRIMARY KEY(share, peer));
  CREATE TABLE IF NOT EXISTS acks(
    share TEXT NOT NULL, peer TEXT NOT NULL, index_id TEXT NOT NULL, seq INTEGER NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY(share, peer));
  CREATE TABLE IF NOT EXISTS need(
    share TEXT NOT NULL, path TEXT NOT NULL, action TEXT NOT NULL, from_path TEXT, conflict INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 2, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    blocked INTEGER NOT NULL DEFAULT 0, t_type INTEGER NOT NULL, t_size INTEGER NOT NULL, t_mtime_ms REAL NOT NULL, t_mode INTEGER NOT NULL,
    t_sha256 TEXT, t_target TEXT, t_deleted INTEGER NOT NULL, t_version TEXT NOT NULL, t_modified_by TEXT NOT NULL,
    PRIMARY KEY(share, path));
  CREATE INDEX IF NOT EXISTS need_order ON need(blocked, priority, action = 'delete', t_size);
  CREATE INDEX IF NOT EXISTS need_sha ON need(t_sha256);
  CREATE TABLE IF NOT EXISTS held(share TEXT NOT NULL, path TEXT NOT NULL, held_at INTEGER NOT NULL, PRIMARY KEY(share, path)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS expected(share TEXT NOT NULL, prefix TEXT NOT NULL, until INTEGER NOT NULL, PRIMARY KEY(share, prefix));
  CREATE TABLE IF NOT EXISTS diffs(share TEXT NOT NULL, peer TEXT NOT NULL, path TEXT NOT NULL, since INTEGER NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(share, peer, path)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS shadow_clean(share TEXT NOT NULL, peer TEXT NOT NULL, clean_since INTEGER, differences INTEGER NOT NULL DEFAULT 0, checked_at INTEGER NOT NULL, PRIMARY KEY(share, peer));
  CREATE TABLE IF NOT EXISTS errors(share TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(share, path));
  CREATE TABLE IF NOT EXISTS nonces(sender TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(sender, nonce));
  `,
  // 2: the peer's announced index id (caught up only within one generation), whether a whole listing arrived,
  // the prunedBelow it was stored under, and the earliest settling difference without reading every one.
  `
  ALTER TABLE cursors ADD COLUMN peer_index_id TEXT;
  ALTER TABLE cursors ADD COLUMN listed INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE cursors ADD COLUMN peer_pruned_below INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS diffs_since ON diffs(share, since);
  `,
  // 3: deletions are no longer held for confirmation, nor announced to skip that.
  `
  DROP TABLE IF EXISTS held;
  DROP TABLE IF EXISTS expected;
  `,
  // 4: when a need row was blocked, moves by their source, and which trash files hold which content (local reuse, §5.5.2).
  `
  ALTER TABLE need ADD COLUMN blocked_at INTEGER;
  CREATE INDEX IF NOT EXISTS need_from ON need(share, from_path) WHERE from_path IS NOT NULL;
  CREATE TABLE IF NOT EXISTS trash_index(file TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL, at INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS trash_index_sha ON trash_index(sha256);
  `,
];

/**
 * A diffs row that is no difference: one side holds a live row the local rules ignore. Under equal rules only an
 * index not yet rescanned under them holds one, and its digest still counts the row, so the live consistency
 * check waits while any exists. Counts, pages, settle timers and the clean streak never see it.
 */
export const HIDDEN_DIFF = "ignored";

const INDEX_TABLES = ["shares", "entries", "remote", "cursors", "acks", "need", "diffs", "shadow_clean", "errors", "nonces", "trash_index"];
const SHARE_TABLES = ["entries", "remote", "cursors", "acks", "need", "diffs", "shadow_clean", "errors"];

type Row = Record<string, unknown>;

const ENTRY_COLUMNS = "path, fs_name, type, size, mtime_ms, mode, sha256, target, deleted, version, modified_by, seq, ino, ctime_ms, fs_mtime_ms, deleted_at";

function toEntry(row: Row): LocalEntry {
  return {
    path: row.path as string, fsName: (row.fs_name as string | null) ?? null, type: row.type as EntryType, size: row.size as number,
    mtimeMs: row.mtime_ms as number, mode: row.mode as number, sha256: (row.sha256 as string | null) ?? null, target: (row.target as string | null) ?? null,
    deleted: row.deleted === 1, version: JSON.parse(row.version as string) as Vector, modifiedBy: row.modified_by as string, seq: row.seq as number,
    ino: row.ino as number, ctimeMs: row.ctime_ms as number, fsMtimeMs: row.fs_mtime_ms as number, deletedAt: (row.deleted_at as number | null) ?? null,
  };
}

const SHARE_FIELDS: Record<keyof ShareRow, string> = {
  share: "share", projectId: "project_id", kind: "kind", root: "root", indexId: "index_id", maxSeq: "max_seq", rootDev: "root_dev",
  rootIno: "root_ino", fullScanAt: "full_scan_at", watchState: "watch_state", scanError: "scan_error", digest: "digest",
  liveFiles: "live_files", liveBytes: "live_bytes", builtinSince: "builtin_since", prunedBelow: "pruned_below", rulesHash: "rules_hash",
  pendingDev: "pending_dev", pendingIno: "pending_ino",
};

const REMOTE_COLUMNS = "path, type, size, mtime_ms, mode, sha256, target, deleted, version, modified_by, seq";

function toRemote(row: Row): IndexEntry {
  return {
    path: row.path as string, type: row.type as EntryType, size: row.size as number, mtimeMs: row.mtime_ms as number, mode: row.mode as number,
    sha256: (row.sha256 as string | null) ?? null, target: (row.target as string | null) ?? null, deleted: row.deleted === 1,
    version: JSON.parse(row.version as string) as Vector, modifiedBy: row.modified_by as string, seq: row.seq as number,
  };
}

function toCursor(row: Row): CursorRow {
  return {
    peer: row.peer as string, indexId: (row.index_id as string | null) ?? null, seq: row.seq as number, peerIndexId: (row.peer_index_id as string | null) ?? null,
    peerMaxSeq: row.peer_max_seq as number, peerDigest: (row.peer_digest as string | null) ?? null, peerRulesHash: (row.peer_rules_hash as string | null) ?? null,
    peerBuiltinSince: (row.peer_builtin_since as number | null) ?? null, listed: row.listed === 1, peerPrunedBelow: row.peer_pruned_below as number,
    updatedAt: row.updated_at as number,
  };
}

const CURSOR_FIELDS: Record<keyof CursorFields, string> = {
  indexId: "index_id", seq: "seq", peerIndexId: "peer_index_id", peerMaxSeq: "peer_max_seq", peerDigest: "peer_digest",
  peerRulesHash: "peer_rules_hash", peerBuiltinSince: "peer_builtin_since", listed: "listed", peerPrunedBelow: "peer_pruned_below",
};

const NEED_COLUMNS = "path, action, from_path, conflict, priority, attempts, next_at, last_error, blocked, blocked_at, t_type, t_size, t_mtime_ms, t_mode, t_sha256, t_target, t_deleted, t_version, t_modified_by";

function toNeed(row: Row): NeedRow {
  const path = row.path as string;
  return {
    path, action: row.action as NeedAction, fromPath: (row.from_path as string | null) ?? null, conflict: row.conflict === 1, priority: row.priority as number,
    attempts: row.attempts as number, nextAt: row.next_at as number, lastError: (row.last_error as string | null) ?? null, blocked: row.blocked === 1,
    blockedAt: (row.blocked_at as number | null) ?? null,
    target: {
      path, type: row.t_type as EntryType, size: row.t_size as number, mtimeMs: row.t_mtime_ms as number, mode: row.t_mode as number,
      sha256: (row.t_sha256 as string | null) ?? null, target: (row.t_target as string | null) ?? null, deleted: row.t_deleted === 1,
      version: JSON.parse(row.t_version as string) as Vector, modifiedBy: row.t_modified_by as string, seq: 0,
    },
  };
}

const NEED_FIELDS: Record<keyof NeedFields, string> = {
  action: "action", fromPath: "from_path", conflict: "conflict", priority: "priority", attempts: "attempts", nextAt: "next_at",
  lastError: "last_error", blocked: "blocked", blockedAt: "blocked_at",
};

type SharedNeedRow = NeedRow & { share: string };
const toSharedNeed = (row: Row): SharedNeedRow => ({ ...toNeed(row), share: row.share as string });

function toShare(row: Row): ShareRow {
  const share = {} as Record<string, unknown>;
  for (const [field, column] of Object.entries(SHARE_FIELDS)) share[field] = row[column] ?? null;
  return share as unknown as ShareRow;
}

/** Descendants of `prefix` on the (share, path) key: "/" is 0x2F and "0" the next code point. */
function below(prefix: string): [string, string] { return [`${prefix}/`, `${prefix}0`]; }

/**
 * The statements scans run per directory or per path. file-sync.db has no ANALYZE statistics, and
 * without them SQLite reads every row of the share through the primary key for a non-covering
 * `parent = ?` lookup or an `OR`, which made each listing O(share) and a full scan quadratic. Each one
 * here seeks; a test pins their query plans.
 */
export const HOT_QUERIES = {
  entry: `SELECT ${ENTRY_COLUMNS} FROM entries WHERE share = ? AND path = ?`,
  children: `SELECT ${ENTRY_COLUMNS} FROM entries INDEXED BY entries_parent WHERE share = ? AND parent = ?`,
  descendants: `SELECT ${ENTRY_COLUMNS} FROM entries WHERE share = ? AND path >= ? AND path < ?`,
  entriesSince: `SELECT ${ENTRY_COLUMNS} FROM entries INDEXED BY entries_seq WHERE share = ? AND seq > ? ORDER BY seq LIMIT ?`,
  liveBelow: "SELECT 1 FROM entries WHERE share = ? AND path >= ? AND path < ? AND deleted = 0 LIMIT 1",
  /** Live names of one folder without decoding rows (apply's darwin case check, once per folder and batch). */
  childPaths: "SELECT path FROM entries INDEXED BY entries_parent WHERE share = ? AND parent = ? AND deleted = 0",
  /** Run for every path need decides (rename pairing): never a walk of the share's need rows. */
  movesFrom: "SELECT path FROM need INDEXED BY need_from WHERE share = ? AND from_path = ? AND from_path IS NOT NULL",
  unpairedFetch: "SELECT path FROM need INDEXED BY need_sha WHERE t_sha256 = ? AND share = ? AND action = 'fetch' AND from_path IS NULL AND blocked = 0 AND t_deleted = 0 AND path <> ?",
  /** A prefix and everything below it: one key range (the prefix's string siblings in it are dropped by the caller). */
  needsUnder: `SELECT ${NEED_COLUMNS} FROM need WHERE share = ? AND path >= ? AND path < ?`,
} as const;

export class FileSyncDb {
  readonly file: string;
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();
  private clockValue = 0;
  private clockDirty = false;

  constructor(file: string, nodeId: string) {
    this.file = file;
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;");
    this.secure();
    this.db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT)");
    this.migrate(nodeId);
    this.clockValue = Number(this.meta("clock") ?? 0) || 0;
  }

  private secure(): void {
    for (const suffix of ["", "-wal", "-shm"]) {
      const target = `${this.file}${suffix}`;
      try { if (existsSync(target)) chmodSync(target, 0o600); } catch { /* best effort: install-service.sh also tightens it */ }
    }
  }

  private migrate(nodeId: string): void {
    const stored = Number(this.meta("schema_version") ?? 0);
    const owner = this.meta("node_id");
    // A newer release's schema, or a data directory moved to another node: the index is rebuilt.
    if (stored > SCHEMA_VERSION || (owner !== undefined && owner !== nodeId)) this.reset();
    let version = Number(this.meta("schema_version") ?? 0);
    while (version < MIGRATIONS.length) {
      const script = MIGRATIONS[version];
      this.writeTx(() => {
        this.db.exec(script);
        this.setMeta("schema_version", String(version + 1));
      });
      version += 1;
    }
    if (owner !== nodeId) this.writeTx(() => this.setMeta("node_id", nodeId));
  }

  private reset(): void {
    this.writeTx(() => {
      for (const table of INDEX_TABLES) this.db.exec(`DROP TABLE IF EXISTS ${table}`);
      this.db.exec("DELETE FROM meta WHERE key <> 'clock'");
    });
    this.statements.clear();
  }

  private statement(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.statements.set(sql, statement); }
    return statement;
  }

  get inTransaction(): boolean { return this.db.isTransaction; }

  /** The only way to write: synchronous, so it can never span an await (§5.1 write discipline). */
  writeTx<T>(run: () => T): T {
    if (this.db.isTransaction) throw new Error("writeTx cannot be nested");
    this.db.exec("BEGIN IMMEDIATE");
    const clockBefore = this.clockValue;
    try {
      const result = run();
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("writeTx callback must be synchronous");
      if (this.clockDirty) this.setMeta("clock", String(this.clockValue));
      this.db.exec("COMMIT");
      this.clockDirty = false;
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.clockValue = clockBefore;
      this.clockDirty = false;
      throw error;
    }
  }

  /**
   * Reads that must come from one snapshot (an index page and the maxSeq it is paired with). The worker's
   * single connection makes synchronous reads consistent already; the transaction states it and keeps it
   * true against any other connection (WAL readers see the snapshot their transaction started with).
   */
  readTx<T>(run: () => T): T {
    if (this.db.isTransaction) return run();
    this.db.exec("BEGIN DEFERRED");
    try {
      const result = run();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private requireTx(): void { if (!this.db.isTransaction) throw new Error("Index writes must run inside writeTx"); }

  meta(key: string): string | undefined {
    const row = this.statement("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return row ? row.value as string : undefined;
  }

  setMeta(key: string, value: string): void {
    this.requireTx();
    this.statement("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  get clock(): number { return this.clockValue; }

  /** A new local version over `base`; the clock is persisted when the surrounding writeTx commits. */
  nextVersion(base: Vector, self: string, now: number): Vector {
    this.requireTx();
    const next = bump(base, self, this.clockValue, now);
    this.clockValue = next.clock;
    this.clockDirty = true;
    return next.version;
  }

  /** Never issue a counter at or below one this node issued before (seen again in a peer's vector). */
  raiseClock(vector: Vector, self: string): void {
    this.requireTx();
    const raised = raiseClock(this.clockValue, vector, self);
    if (raised !== this.clockValue) { this.clockValue = raised; this.clockDirty = true; }
  }

  share(key: string): ShareRow | undefined {
    const row = this.statement("SELECT * FROM shares WHERE share = ?").get(key) as Row | undefined;
    return row ? toShare(row) : undefined;
  }

  shares(): ShareRow[] {
    return (this.statement("SELECT * FROM shares ORDER BY share").all() as Row[]).map(toShare);
  }

  insertShare(row: Pick<ShareRow, "share" | "projectId" | "kind" | "root" | "indexId">): ShareRow {
    this.requireTx();
    // A new share starts with nothing: rows a pull stored after the share was dropped would claim a peer's index it never got whole.
    for (const table of SHARE_TABLES) this.statement(`DELETE FROM ${table} WHERE share = ?`).run(row.share);
    this.statement("INSERT INTO shares(share, project_id, kind, root, index_id, digest) VALUES (?, ?, ?, ?, ?, ?)")
      .run(row.share, row.projectId, row.kind, row.root, row.indexId, EMPTY_DIGEST);
    return this.share(row.share)!;
  }

  updateShare(key: string, fields: Partial<Omit<ShareRow, "share">>): void {
    this.requireTx();
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const assignments = entries.map(([field]) => `${SHARE_FIELDS[field as keyof ShareRow]} = ?`).join(", ");
    this.statement(`UPDATE shares SET ${assignments} WHERE share = ?`).run(...entries.map(([, value]) => value as string | number | null), key);
  }

  /** Every row of a share in every table: the project is gone or its policy was deleted (§4). */
  deleteShare(key: string): void {
    this.requireTx();
    for (const table of SHARE_TABLES) this.statement(`DELETE FROM ${table} WHERE share = ?`).run(key);
    this.statement("DELETE FROM shares WHERE share = ?").run(key);
  }

  /**
   * A new generation: local rows go without tombstones; peers notice the new index id on their next pull.
   * `builtinSince` is 0 when the share is already in builtin mode (every row of the new generation is
   * builtin), null otherwise.
   */
  resetGeneration(key: string, indexId: string, identity: { dev: number; ino: number } | null, builtinSince: number | null = null): void {
    this.requireTx();
    for (const table of ["entries", "diffs", "shadow_clean", "errors", "need", "acks"]) this.statement(`DELETE FROM ${table} WHERE share = ?`).run(key);
    this.updateShare(key, {
      indexId, maxSeq: 0, digest: EMPTY_DIGEST, liveFiles: 0, liveBytes: 0, prunedBelow: 0, fullScanAt: null, scanError: null,
      rootDev: identity?.dev ?? null, rootIno: identity?.ino ?? null, pendingDev: null, pendingIno: null, builtinSince,
    });
  }

  entry(share: string, relative: string): LocalEntry | undefined {
    const row = this.statement(HOT_QUERIES.entry).get(share, relative) as Row | undefined;
    return row ? toEntry(row) : undefined;
  }

  children(share: string, parent: string): LocalEntry[] {
    return (this.statement(HOT_QUERIES.children).all(share, parent) as Row[]).map(toEntry);
  }

  /** Every row strictly below `prefix` ("" lists the whole share). */
  descendants(share: string, prefix: string): LocalEntry[] {
    if (prefix === "") return this.entries(share);
    const [low, high] = below(prefix);
    return (this.statement(HOT_QUERIES.descendants).all(share, low, high) as Row[]).map(toEntry);
  }

  /** Whether anything strictly below `prefix` is live, without reading the rows. */
  hasLiveBelow(share: string, prefix: string): boolean {
    const [low, high] = below(prefix);
    return this.statement(HOT_QUERIES.liveBelow).get(share, low, high) !== undefined;
  }

  entries(share: string): LocalEntry[] {
    return (this.statement(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE share = ? ORDER BY path`).all(share) as Row[]).map(toEntry);
  }

  /** Rows with seq above `since`, in seq order (the paging contract reads these). */
  entriesSince(share: string, since: number, limit: number): LocalEntry[] {
    return (this.statement(HOT_QUERIES.entriesSince).all(share, since, limit) as Row[]).map(toEntry);
  }

  putEntry(share: string, entry: LocalEntry): void {
    this.requireTx();
    this.statement(`INSERT INTO entries(share, parent, ${ENTRY_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(share, path) DO UPDATE SET fs_name = excluded.fs_name, parent = excluded.parent, type = excluded.type, size = excluded.size,
      mtime_ms = excluded.mtime_ms, mode = excluded.mode, sha256 = excluded.sha256, target = excluded.target, deleted = excluded.deleted,
      version = excluded.version, modified_by = excluded.modified_by, seq = excluded.seq, ino = excluded.ino, ctime_ms = excluded.ctime_ms,
      fs_mtime_ms = excluded.fs_mtime_ms, deleted_at = excluded.deleted_at`).run(
      share, parentKey(entry.path), entry.path, entry.fsName, entry.type, entry.size, entry.mtimeMs, entry.mode, entry.sha256, entry.target,
      entry.deleted ? 1 : 0, JSON.stringify(entry.version), entry.modifiedBy, entry.seq, entry.ino, entry.ctimeMs, entry.fsMtimeMs, entry.deletedAt,
    );
  }

  deleteEntry(share: string, relative: string): void {
    this.requireTx();
    this.statement("DELETE FROM entries WHERE share = ? AND path = ?").run(share, relative);
  }

  liveCount(share: string): number {
    return (this.statement("SELECT COUNT(*) AS n FROM entries WHERE share = ? AND deleted = 0").get(share) as Row).n as number;
  }

  /** Tombstones that may be pruned: acknowledged by every eligible peer and old enough (§5.2.8). */
  prunableTombstones(share: string, maxSeq: number, deletedBefore: number): Array<{ path: string; seq: number }> {
    return this.statement("SELECT path, seq FROM entries WHERE share = ? AND deleted = 1 AND seq <= ? AND deleted_at IS NOT NULL AND deleted_at <= ?")
      .all(share, maxSeq, deletedBefore) as Array<{ path: string; seq: number }>;
  }

  acks(share: string): Array<{ peer: string; indexId: string; seq: number }> {
    return (this.statement("SELECT peer, index_id, seq FROM acks WHERE share = ?").all(share) as Row[])
      .map((row) => ({ peer: row.peer as string, indexId: row.index_id as string, seq: row.seq as number }));
  }

  setAck(share: string, peer: string, indexId: string, seq: number, now: number): void {
    this.requireTx();
    this.statement("INSERT INTO acks(share, peer, index_id, seq, seen_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(share, peer) DO UPDATE SET index_id = excluded.index_id, seq = excluded.seq, seen_at = excluded.seen_at")
      .run(share, peer, indexId, seq, now);
  }

  cursors(share: string): CursorRow[] {
    return (this.statement("SELECT * FROM cursors WHERE share = ?").all(share) as Row[]).map(toCursor);
  }

  cursor(share: string, peer: string): CursorRow | undefined {
    const row = this.statement("SELECT * FROM cursors WHERE share = ? AND peer = ?").get(share, peer) as Row | undefined;
    return row ? toCursor(row) : undefined;
  }

  /** Creates the cursor row when needed and sets the given fields. */
  updateCursor(share: string, peer: string, fields: CursorFields, now: number): void {
    this.requireTx();
    this.statement("INSERT INTO cursors(share, peer, updated_at) VALUES (?, ?, ?) ON CONFLICT(share, peer) DO NOTHING").run(share, peer, now);
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    const assignments = [...entries.map(([field]) => `${CURSOR_FIELDS[field as keyof CursorFields]} = ?`), "updated_at = ?"].join(", ");
    const values = entries.map(([, value]) => typeof value === "boolean" ? (value ? 1 : 0) : value as string | number | null);
    this.statement(`UPDATE cursors SET ${assignments} WHERE share = ? AND peer = ?`).run(...values, now, share, peer);
  }

  deleteCursor(share: string, peer: string): void {
    this.requireTx();
    this.statement("DELETE FROM cursors WHERE share = ? AND peer = ?").run(share, peer);
  }

  remote(share: string, peer: string, relative: string): IndexEntry | undefined {
    const row = this.statement(`SELECT ${REMOTE_COLUMNS} FROM remote WHERE share = ? AND peer = ? AND path = ?`).get(share, peer, relative) as Row | undefined;
    return row ? toRemote(row) : undefined;
  }

  putRemote(share: string, peer: string, entry: IndexEntry): void {
    this.requireTx();
    this.statement(`INSERT INTO remote(share, peer, ${REMOTE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(share, peer, path) DO UPDATE SET type = excluded.type, size = excluded.size, mtime_ms = excluded.mtime_ms, mode = excluded.mode,
      sha256 = excluded.sha256, target = excluded.target, deleted = excluded.deleted, version = excluded.version, modified_by = excluded.modified_by,
      seq = excluded.seq`).run(
      share, peer, entry.path, entry.type, entry.size, entry.mtimeMs, entry.mode, entry.sha256, entry.target, entry.deleted ? 1 : 0,
      JSON.stringify(entry.version), entry.modifiedBy, entry.seq,
    );
  }

  /** A peer's rows in path order after `after`, for chunked walks. */
  remoteAfter(share: string, peer: string, after: string, limit: number): IndexEntry[] {
    return (this.statement(`SELECT ${REMOTE_COLUMNS} FROM remote WHERE share = ? AND peer = ? AND path > ? ORDER BY path LIMIT ?`).all(share, peer, after, limit) as Row[]).map(toRemote);
  }

  remoteCount(share: string, peer: string): number {
    return (this.statement("SELECT COUNT(*) AS n FROM remote WHERE share = ? AND peer = ?").get(share, peer) as Row).n as number;
  }

  /**
   * Our copy of one peer's index of a share goes: rows, our position in it, differences and the clean
   * record. What the peer announced about itself (index id, maxSeq, digest, rules hash) stays: it is
   * still true and the re-pull is judged against it.
   */
  resetPeer(share: string, peer: string): void {
    this.requireTx();
    for (const table of ["remote", "diffs", "shadow_clean"]) this.statement(`DELETE FROM ${table} WHERE share = ? AND peer = ?`).run(share, peer);
    this.statement("UPDATE cursors SET index_id = NULL, seq = 0, listed = 0 WHERE share = ? AND peer = ?").run(share, peer);
  }

  /** Local rows in path order after `after`, for chunked walks. */
  entriesAfter(share: string, after: string, limit: number): LocalEntry[] {
    return (this.statement(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE share = ? AND path > ? ORDER BY path LIMIT ?`).all(share, after, limit) as Row[]).map(toEntry);
  }

  diff(share: string, peer: string, relative: string): DiffRow | undefined {
    const row = this.statement("SELECT path, since, kind FROM diffs WHERE share = ? AND peer = ? AND path = ?").get(share, peer, relative) as Row | undefined;
    return row ? { path: row.path as string, since: row.since as number, kind: row.kind as string } : undefined;
  }

  putDiff(share: string, peer: string, relative: string, since: number, kind: string): void {
    this.requireTx();
    this.statement("INSERT INTO diffs(share, peer, path, since, kind) VALUES (?, ?, ?, ?, ?) ON CONFLICT(share, peer, path) DO UPDATE SET kind = excluded.kind").run(share, peer, relative, since, kind);
  }

  deleteDiff(share: string, peer: string, relative: string): void {
    this.requireTx();
    this.statement("DELETE FROM diffs WHERE share = ? AND peer = ? AND path = ?").run(share, peer, relative);
  }

  /** Differences that started at or before `settledAt` (all of them by default); hidden rows (HIDDEN_DIFF) are no difference. */
  diffCount(share: string, peer: string, settledAt = Number.MAX_SAFE_INTEGER): number {
    return (this.statement(`SELECT COUNT(*) AS n FROM diffs WHERE share = ? AND peer = ? AND since <= ? AND kind <> '${HIDDEN_DIFF}'`).get(share, peer, settledAt) as Row).n as number;
  }

  /** Every diffs row of the pair, hidden ones included: anything at all that keeps the two indexes from agreeing. */
  pendingCount(share: string, peer: string): number {
    return (this.statement("SELECT COUNT(*) AS n FROM diffs WHERE share = ? AND peer = ?").get(share, peer) as Row).n as number;
  }

  diffsPage(share: string, peer: string, settledAt: number, offset: number, limit: number): DiffRow[] {
    return (this.statement(`SELECT path, since, kind FROM diffs WHERE share = ? AND peer = ? AND since <= ? AND kind <> '${HIDDEN_DIFF}' ORDER BY path LIMIT ? OFFSET ?`).all(share, peer, settledAt, limit, offset) as Row[])
      .map((row) => ({ path: row.path as string, since: row.since as number, kind: row.kind as string }));
  }

  /** The earliest start of a difference that is still settling (after `settledAt`), over every peer of the share. */
  earliestSettling(share: string, settledAt: number): number | undefined {
    const row = this.statement(`SELECT MIN(since) AS since FROM diffs WHERE share = ? AND since > ? AND kind <> '${HIDDEN_DIFF}'`).get(share, settledAt) as Row;
    return row.since === null ? undefined : row.since as number;
  }

  shadowClean(share: string, peer: string): ShadowCleanRow | undefined {
    const row = this.statement("SELECT peer, clean_since, differences, checked_at FROM shadow_clean WHERE share = ? AND peer = ?").get(share, peer) as Row | undefined;
    return row ? { peer: row.peer as string, cleanSince: (row.clean_since as number | null) ?? null, differences: row.differences as number, checkedAt: row.checked_at as number } : undefined;
  }

  putShadowClean(share: string, peer: string, cleanSince: number | null, differences: number, checkedAt: number): void {
    this.requireTx();
    this.statement(`INSERT INTO shadow_clean(share, peer, clean_since, differences, checked_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(share, peer) DO UPDATE SET clean_since = excluded.clean_since, differences = excluded.differences, checked_at = excluded.checked_at`).run(share, peer, cleanSince, differences, checkedAt);
  }

  /** Peers whose differences are tracked for the share (they have a shadow_clean row). */
  comparedPeers(share: string): string[] {
    return (this.statement("SELECT peer FROM shadow_clean WHERE share = ? ORDER BY peer").all(share) as Row[]).map((row) => row.peer as string);
  }

  /** Differences stop being tracked for this peer (not comparable any more). */
  clearComparison(share: string, peer: string): void {
    this.requireTx();
    this.statement("DELETE FROM diffs WHERE share = ? AND peer = ?").run(share, peer);
    this.statement("DELETE FROM shadow_clean WHERE share = ? AND peer = ?").run(share, peer);
  }

  setError(share: string, relative: string, kind: ErrorRow["kind"], reason: string, at: number): void {
    this.requireTx();
    this.statement("INSERT INTO errors(share, path, kind, reason, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(share, path) DO UPDATE SET kind = excluded.kind, reason = excluded.reason, at = CASE WHEN errors.reason = excluded.reason THEN errors.at ELSE excluded.at END")
      .run(share, relative, kind, reason, at);
  }

  clearError(share: string, relative: string): void {
    this.requireTx();
    this.statement("DELETE FROM errors WHERE share = ? AND path = ?").run(share, relative);
  }

  hasError(share: string, relative: string): boolean {
    return this.statement("SELECT 1 FROM errors WHERE share = ? AND path = ?").get(share, relative) !== undefined;
  }

  errorPaths(share: string): string[] {
    return (this.statement("SELECT path FROM errors WHERE share = ?").all(share) as Row[]).map((row) => row.path as string);
  }

  errorCount(share: string, prefix = ""): number {
    if (!prefix) return (this.statement("SELECT COUNT(*) AS n FROM errors WHERE share = ?").get(share) as Row).n as number;
    const [low, high] = below(prefix);
    return (this.statement("SELECT COUNT(*) AS n FROM errors WHERE share = ? AND path >= ? AND path < ? AND (path = ? OR path >= ?)")
      .get(share, prefix, high, prefix, low) as Row).n as number;
  }

  errorsPage(share: string, offset: number, limit: number): { total: number; items: ErrorRow[] } {
    const items = (this.statement("SELECT path, kind, reason, at FROM errors WHERE share = ? ORDER BY path LIMIT ? OFFSET ?").all(share, limit, offset) as Row[])
      .map((row) => ({ path: row.path as string, kind: row.kind as ErrorRow["kind"], reason: row.reason as string, at: row.at as number }));
    return { total: this.errorCount(share), items };
  }

  needSummary(share: string): { files: number; bytes: number; blocked: number } {
    const row = this.statement("SELECT COALESCE(SUM(blocked = 0), 0) AS files, COALESCE(SUM(CASE WHEN blocked = 0 THEN t_size ELSE 0 END), 0) AS bytes, COALESCE(SUM(blocked = 1), 0) AS blocked FROM need WHERE share = ?").get(share) as Row;
    return { files: row.files as number, bytes: row.bytes as number, blocked: row.blocked as number };
  }

  // ---- need queue (§5.4) ----

  needRow(share: string, relative: string): NeedRow | undefined {
    const row = this.statement(`SELECT ${NEED_COLUMNS} FROM need WHERE share = ? AND path = ?`).get(share, relative) as Row | undefined;
    return row ? toNeed(row) : undefined;
  }

  putNeed(share: string, row: NeedRow): void {
    this.requireTx();
    const t = row.target;
    this.statement(`INSERT INTO need(share, ${NEED_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(share, path) DO UPDATE SET action = excluded.action, from_path = excluded.from_path, conflict = excluded.conflict, priority = excluded.priority,
      attempts = excluded.attempts, next_at = excluded.next_at, last_error = excluded.last_error, blocked = excluded.blocked, blocked_at = excluded.blocked_at,
      t_type = excluded.t_type, t_size = excluded.t_size, t_mtime_ms = excluded.t_mtime_ms, t_mode = excluded.t_mode, t_sha256 = excluded.t_sha256,
      t_target = excluded.t_target, t_deleted = excluded.t_deleted, t_version = excluded.t_version, t_modified_by = excluded.t_modified_by`).run(
      share, row.path, row.action, row.fromPath, row.conflict ? 1 : 0, row.priority, row.attempts, row.nextAt, row.lastError, row.blocked ? 1 : 0, row.blockedAt,
      t.type, t.size, t.mtimeMs, t.mode, t.sha256, t.target, t.deleted ? 1 : 0, JSON.stringify(t.version), t.modifiedBy,
    );
  }

  updateNeed(share: string, relative: string, fields: NeedFields): void {
    this.requireTx();
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    if (!entries.length) return;
    const assignments = entries.map(([field]) => `${NEED_FIELDS[field as keyof NeedFields]} = ?`).join(", ");
    const values = entries.map(([, value]) => typeof value === "boolean" ? (value ? 1 : 0) : value as string | number | null);
    this.statement(`UPDATE need SET ${assignments} WHERE share = ? AND path = ?`).run(...values, share, relative);
  }

  deleteNeed(share: string, relative: string): void {
    this.requireTx();
    this.statement("DELETE FROM need WHERE share = ? AND path = ?").run(share, relative);
  }

  /** Every need row of a share (it left the builtin phase). */
  deleteNeeds(share: string): number {
    this.requireTx();
    return Number(this.statement("DELETE FROM need WHERE share = ?").run(share).changes);
  }

  needCount(share: string): number {
    return (this.statement("SELECT COUNT(*) AS n FROM need WHERE share = ?").get(share) as Row).n as number;
  }

  /** Need rows in path order after `after`, for chunked walks. */
  needAfter(share: string, after: string, limit: number): NeedRow[] {
    return (this.statement(`SELECT ${NEED_COLUMNS} FROM need WHERE share = ? AND path > ? ORDER BY path LIMIT ?`).all(share, after, limit) as Row[]).map(toNeed);
  }

  /** Need rows at `prefix` and below ("" = the whole share). */
  needsUnder(share: string, prefix: string): NeedRow[] {
    if (prefix === "") return (this.statement(`SELECT ${NEED_COLUMNS} FROM need WHERE share = ?`).all(share) as Row[]).map(toNeed);
    // The OR form read the share's every need row (no statistics): [prefix, end of its subtree) is one seek.
    const [low, high] = below(prefix);
    return (this.statement(HOT_QUERIES.needsUnder).all(share, prefix, high) as Row[]).map(toNeed)
      .filter((row) => row.path === prefix || row.path >= low);
  }

  /** Unblocked rows of every share in transfer order: priority, creates and updates before deletes, smallest first (need_order). */
  needCandidates(offset: number, limit: number): SharedNeedRow[] {
    return (this.statement(`SELECT share, ${NEED_COLUMNS} FROM need WHERE blocked = 0 ORDER BY priority, action = 'delete', t_size, share, path LIMIT ? OFFSET ?`).all(limit, offset) as Row[]).map(toSharedNeed);
  }

  /** Unblocked deletes of one priority, every share; the caller orders them deepest first. */
  needDeletes(priority: number): SharedNeedRow[] {
    return (this.statement(`SELECT share, ${NEED_COLUMNS} FROM need WHERE blocked = 0 AND action = 'delete' AND priority = ?`).all(priority) as Row[]).map(toSharedNeed);
  }

  blockedNeeds(share: string): NeedRow[] {
    return (this.statement(`SELECT ${NEED_COLUMNS} FROM need WHERE share = ? AND blocked = 1 ORDER BY path`).all(share) as Row[]).map(toNeed);
  }

  /** Blocked rows whose retry time came (not enough disk space is tried again by time). */
  blockedDue(now: number): Array<{ share: string; path: string }> {
    return (this.statement("SELECT share, path FROM need WHERE blocked = 1 AND next_at > 0 AND next_at <= ?").all(now) as Row[]).map((row) => ({ share: row.share as string, path: row.path as string }));
  }

  /** Shares with an unblocked create of this content (a fetch or move): deleting a local copy of it first would cost a transfer. */
  sharesWanting(sha256: string): string[] {
    return (this.statement("SELECT DISTINCT share FROM need WHERE t_sha256 = ? AND t_deleted = 0 AND blocked = 0 AND action IN ('fetch', 'move') LIMIT 16").all(sha256) as Row[]).map((row) => row.share as string);
  }

  /** An unblocked fetch of this content in the share that no delete feeds yet (a rename's other half). */
  unpairedFetch(share: string, sha256: string, except: string): string | undefined {
    // Sorted here: ORDER BY path made SQLite walk the share's need rows in path order instead of seeking by content.
    let first: string | undefined;
    for (const row of this.statement(HOT_QUERIES.unpairedFetch).all(sha256, share, except) as Row[]) {
      if (first === undefined || (row.path as string) < first) first = row.path as string;
    }
    return first;
  }

  /** Paths whose move takes its file from `fromPath`. */
  movesFrom(share: string, fromPath: string): string[] {
    return (this.statement(HOT_QUERIES.movesFrom).all(share, fromPath) as Row[]).map((row) => row.path as string).sort();
  }

  /** Live paths of one folder, nothing decoded. */
  childPaths(share: string, parent: string): string[] {
    return (this.statement(HOT_QUERIES.childPaths).all(share, parent) as Row[]).map((row) => row.path as string);
  }

  /** Unblocked deletes of the share whose local live file holds this content and that no move uses yet. */
  pairableDeletes(share: string, sha256: string, except: string): string[] {
    return (this.statement(`SELECT n.path AS path FROM entries e JOIN need n ON n.share = e.share AND n.path = e.path
      WHERE e.share = ? AND e.sha256 = ? AND e.deleted = 0 AND e.type = 0 AND n.action = 'delete' AND n.blocked = 0 AND n.path <> ?
      AND NOT EXISTS (SELECT 1 FROM need m WHERE m.share = n.share AND m.from_path = n.path) ORDER BY n.path LIMIT 8`).all(share, sha256, except) as Row[]).map((row) => row.path as string);
  }

  /** The earliest retry time after `now`: rows in backoff and blocked rows waiting for disk space. */
  nextNeedRetry(now: number): number | undefined {
    const row = this.statement("SELECT MIN(next_at) AS at FROM need WHERE next_at > ?").get(now) as Row;
    return row.at === null ? undefined : row.at as number;
  }

  /** Live local files with this content, any share (local reuse, §5.5.2). */
  entriesWithContent(sha256: string, limit: number): Array<{ share: string; entry: LocalEntry }> {
    return (this.statement(`SELECT share, ${ENTRY_COLUMNS} FROM entries WHERE sha256 = ? AND deleted = 0 AND type = 0 LIMIT ?`).all(sha256, limit) as Row[])
      .map((row) => ({ share: row.share as string, entry: toEntry(row) }));
  }

  /** A trash file apply put there, by content: apply and local reuse look it up; a pruned file is found missing then. */
  putTrashItem(file: string, sha256: string, size: number, at: number): void {
    this.requireTx();
    this.statement("INSERT INTO trash_index(file, sha256, size, at) VALUES (?, ?, ?, ?) ON CONFLICT(file) DO UPDATE SET sha256 = excluded.sha256, size = excluded.size, at = excluded.at").run(file, sha256, size, at);
  }

  trashWithContent(sha256: string, limit: number): string[] {
    return (this.statement("SELECT file FROM trash_index WHERE sha256 = ? ORDER BY at DESC LIMIT ?").all(sha256, limit) as Row[]).map((row) => row.file as string);
  }

  deleteTrashItem(file: string): void {
    this.requireTx();
    this.statement("DELETE FROM trash_index WHERE file = ?").run(file);
  }

  /** Rows for trash files the retention removed by now. */
  pruneTrashIndex(before: number): void {
    this.requireTx();
    this.statement("DELETE FROM trash_index WHERE at < ?").run(before);
  }

  /** Errors and blocked need rows of a share in path order. */
  problemsPage(share: string, offset: number, limit: number): { total: number; items: ProblemRow[] } {
    const items = (this.statement(`SELECT path, kind, reason, at, 0 AS blocked FROM errors WHERE share = ?
      UNION ALL SELECT path, 'blocked' AS kind, COALESCE(last_error, 'Blocked') AS reason, COALESCE(blocked_at, 0) AS at, 1 AS blocked FROM need WHERE share = ? AND blocked = 1
      ORDER BY path, blocked LIMIT ? OFFSET ?`).all(share, share, limit, offset) as Row[])
      .map((row) => ({ path: row.path as string, kind: row.kind as ErrorRow["kind"], reason: row.reason as string, at: row.at as number, blocked: row.blocked === 1 }));
    return { total: this.errorCount(share) + this.needSummary(share).blocked, items };
  }

  private noncesPrunedAt = Number.NEGATIVE_INFINITY;

  /** Direct listener replay protection: false when the sender used this nonce before. Expired rows go at most once a minute. */
  consumeNonce(sender: string, nonce: string, now: number, ttlMs: number): boolean {
    return this.writeTx(() => {
      if (now - this.noncesPrunedAt >= 60_000) { this.statement("DELETE FROM nonces WHERE expires_at < ?").run(now); this.noncesPrunedAt = now; }
      // An expired row not pruned yet still refuses its nonce; its timestamp would fail the ±60 s check anyway.
      return Number(this.statement("INSERT INTO nonces(sender, nonce, expires_at) VALUES (?, ?, ?) ON CONFLICT(sender, nonce) DO NOTHING").run(sender, nonce, now + ttlMs).changes) === 1;
    });
  }

  close(): void {
    this.statements.clear();
    if (this.db.isOpen) this.db.close();
  }
}

export function fileSyncDbPath(dataDir: string): string { return path.join(dataDir, "file-sync.db"); }
