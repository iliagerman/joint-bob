import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Durable apply journal for ticket merges (TICKET-MERGE-PLAN.md §8). Lives in the
 * node-wide database through a dedicated connection with synchronous=FULL — the
 * everyday connections run WAL + default NORMAL, which is not per-commit durable.
 * Backups live outside the workspace (the agent can reach anything inside it), under
 * the node data directory. Recovery replays nothing forward: an interrupted
 * transaction rolls back from backups; a committed one only finishes cleanup.
 */

export interface MergeOpBase {
  path: string;
  /** Null triple: oldSha256/oldMode/backupPath are all null (file absent before) or all set. */
  oldSha256: string | null;
  oldMode: number | null;
  /** Populated during apply once a backup is written. */
  backupPath: string | null;
  createdParents: string[];
  createdBackupDirs: string[];
}

export type MergeOp =
  | (MergeOpBase & { op: "write"; newSha256: string; newMode: number })
  | (MergeOpBase & { op: "delete"; newSha256: null; newMode: null });

export interface MergeTransaction {
  txid: string;
  taskId: string;
  projectId: string;
  state: "planned" | "applying" | "committed" | "rolled_back";
  progress: number;
  ops: MergeOp[];
}

export class MergeJournalError extends Error {}

const dataDir = process.env.JOINT_BOB_DATA_DIR ?? process.env.PI_WEB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob");
let journalPromise: Promise<DatabaseSync> | undefined;

export function mergeBackupRoot(): string {
  return path.join(dataDir, "merge-backups");
}

async function journalDatabase(): Promise<DatabaseSync> {
  if (!journalPromise) {
    journalPromise = (async () => {
      await fs.mkdir(dataDir, { recursive: true });
      const db = new DatabaseSync(path.join(dataDir, "node.db"));
      db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
      db.exec(`CREATE TABLE IF NOT EXISTS merge_transactions (
        txid TEXT PRIMARY KEY, task_id TEXT NOT NULL, project_id TEXT NOT NULL,
        state TEXT NOT NULL, progress INTEGER NOT NULL DEFAULT 0, cleanup_progress INTEGER NOT NULL DEFAULT 0, ops TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      const journalColumns = db.prepare("PRAGMA table_info(merge_transactions)").all() as Array<{ name: string }>;
      if (!journalColumns.some((column) => column.name === "cleanup_progress")) db.exec("ALTER TABLE merge_transactions ADD COLUMN cleanup_progress INTEGER NOT NULL DEFAULT 0");
      return db;
    })();
  }
  return journalPromise;
}

async function fsyncDir(directory: string): Promise<void> {
  // Directory fsync is POSIX-only; the deployment targets are macOS and Linux.
  try {
    const handle = await fs.open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {
    // Best effort on filesystems that refuse directory handles.
  }
}

async function sha256File(filePath: string): Promise<string | null> {
  try {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** C6 containment: plain segments, nearest existing ancestor inside the root,
 * revalidated immediately before use. */
export async function assertOpContained(projectRoot: string, filePath: string): Promise<void> {
  const segments = filePath.split("/");
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === "..")) throw new MergeJournalError(`Invalid op path: ${filePath}`);
  let existing = await fs.realpath(projectRoot);
  let index = 0;
  while (index < segments.length) {
    const candidate = path.join(existing, segments[index]);
    let info: import("node:fs").Stats | null = null;
    try { info = await fs.lstat(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      break;
    }
    if (info.isSymbolicLink()) throw new MergeJournalError(`Op path crosses a symlink: ${filePath}`);
    existing = await fs.realpath(candidate);
    index += 1;
  }
  const rootReal = await fs.realpath(projectRoot);
  const relative = path.relative(rootReal, existing);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new MergeJournalError(`Op escapes the project root: ${filePath}`);
}

async function writeAll(handle: import("node:fs/promises").FileHandle, bytes: Buffer): Promise<void> {
  // A single write() may be partial; loop until every byte is on the handle.
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written);
    if (result.bytesWritten === 0) throw new MergeJournalError("File write made no progress");
    written += result.bytesWritten;
  }
}

async function writeDurable(target: string, bytes: Buffer, mode: number, tempPath: string): Promise<void> {
  const handle = await fs.open(tempPath, "w", mode);
  try {
    await writeAll(handle, bytes);
    // fs.open's mode goes through the process umask (0664 can land as 0644); the
    // exact mode is set on the handle before the bytes are durable.
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tempPath, target);
  await fsyncDir(path.dirname(target));
}

/** Deterministic temp path next to the target (plan E3); recovery removes orphans. */
function tempPathFor(projectRoot: string, txid: string, filePath: string): string {
  return path.join(path.dirname(path.join(projectRoot, filePath)), `.${path.basename(filePath)}.jb-merge-${txid}.tmp`);
}

async function updateTransaction(txid: string, fields: Record<string, unknown>): Promise<void> {
  const db = await journalDatabase();
  const entries = Object.entries(fields);
  const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE merge_transactions SET ${assignments}, updated_at = ? WHERE txid = ?`).run(...entries.map(([, value]) => value as never), new Date().toISOString(), txid);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function recordMergeTransaction(taskId: string, projectId: string, ops: MergeOp[]): Promise<string> {
  const db = await journalDatabase();
  const txid = randomUUID();
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("INSERT INTO merge_transactions (txid, task_id, project_id, state, progress, ops, created_at, updated_at) VALUES (?, ?, ?, 'planned', 0, ?, ?, ?)").run(txid, taskId, projectId, JSON.stringify(ops), now, now);
    db.exec("COMMIT");
    return txid;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function loadTransaction(txid: string): Promise<MergeTransaction | null> {
  const db = await journalDatabase();
  const row = db.prepare("SELECT * FROM merge_transactions WHERE txid = ?").get(txid) as Record<string, unknown> | undefined;
  if (!row) return null;
  return { txid: row.txid as string, taskId: row.task_id as string, projectId: row.project_id as string, state: row.state as MergeTransaction["state"], progress: row.progress as number, ops: JSON.parse(row.ops as string) as MergeOp[] };
}

async function saveOps(txid: string, ops: MergeOp[]): Promise<void> {
  await updateTransaction(txid, { ops: JSON.stringify(ops) });
}

async function mkdirpTracked(target: string, tracked: string[], beforeCreate?: (directory: string) => Promise<void>): Promise<void> {
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try { await fs.stat(current); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(current);
      const parent = path.dirname(current);
      if (parent === current) throw new MergeJournalError(`Cannot create ${target}`);
      current = parent;
    }
  }
  for (const directory of missing.reverse()) {
    // Durability order: the directory enters the tracked list, the journal
    // persists it, and only then does it exist on disk.
    tracked.push(directory);
    if (beforeCreate) await beforeCreate(directory);
    await fs.mkdir(directory).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    await fsyncDir(path.dirname(directory));
  }
}

async function backupFile(op: MergeOp, source: string, txid: string, taskId: string, persist?: () => Promise<void>): Promise<void> {
  if (op.oldSha256 === null || op.oldMode === null) return;
  // One read, hashed and backed up: an edit between a hash-read and a byte-read
  // (ABA) cannot validate one version while storing another.
  const bytes = await fs.readFile(source);
  const { createHash } = await import("node:crypto");
  const readHash = createHash("sha256").update(bytes).digest("hex");
  if (readHash !== op.oldSha256) throw new MergeJournalError(`Project changed under the merge at ${op.path}; refusing to continue`);
  // Hex-encoded op path: `a/b` and `a__b` must never share a backup file.
  op.backupPath = path.join(mergeBackupRoot(), taskId, txid, `${Buffer.from(op.path, "utf8").toString("hex")}.backup`);
  await mkdirpTracked(path.dirname(op.backupPath), op.createdBackupDirs, persist);
  const handle = await fs.open(`${op.backupPath}.tmp`, "w", op.oldMode);
  try {
    await writeAll(handle, bytes);
    await handle.chmod(op.oldMode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(`${op.backupPath}.tmp`, op.backupPath);
  await fsyncDir(path.dirname(op.backupPath));
}

/** Applies every op to the project root with the backup/temp/rename/fsync protocol.
 * `stagedSource` supplies the new bytes (the workspace staging area). Progress and
 * op mutations (backupPath, created dirs) are persisted durably as they happen. */
export async function applyMergeTransaction(projectRoot: string, txid: string, stagedSource: (op: MergeOp) => Promise<Buffer>): Promise<void> {
  const transaction = await loadTransaction(txid);
  if (!transaction) throw new MergeJournalError("Merge transaction not found");
  if (transaction.state === "committed") { await cleanupMergeTransaction(txid); return; }
  if (transaction.state === "rolled_back") return;
  if (transaction.state === "planned") await updateTransaction(txid, { state: "applying" });
  const ops = transaction.ops;
  for (let index = transaction.progress; index < ops.length; index += 1) {
    const op = ops[index];
    const target = path.join(projectRoot, op.path);
    await assertOpContained(projectRoot, op.path);
    if (op.op === "write") {
      await mkdirpTracked(path.dirname(target), op.createdParents, async () => saveOps(txid, ops));
      if (op.oldSha256 !== null) {
        await backupFile(op, target, txid, transaction.taskId, async () => saveOps(txid, ops));
        await saveOps(txid, ops);
      }
      const parentRel = path.dirname(op.path).split(path.sep).join("/");
      if (parentRel && parentRel !== ".") await assertOpContained(projectRoot, parentRel);
      // Revalidate the old state at mutation time: a backup taken earlier is
      // not a license to overwrite whatever sits at the target now.
      if (op.oldSha256 !== null) {
        const nowHash = await sha256File(target);
        const nowMode = await fs.stat(target).then((info) => info.mode & 0o7777, () => null);
        if (nowHash !== op.oldSha256 || nowMode === null || nowMode !== op.oldMode) throw new MergeJournalError(`Project changed under the merge at ${op.path}; refusing to apply`);
      } else if ((await sha256File(target)) !== null) {
        throw new MergeJournalError(`Third-party content appeared at ${op.path}; refusing to apply`);
      }
      const bytes = await stagedSource(op);
      await writeDurable(target, bytes, op.newMode, tempPathFor(projectRoot, txid, op.path));
    } else {
      try {
        const info = await fs.stat(target);
        if (info.isFile()) {
          // Deletes capture the full old-state triple so rollback can restore
          // content AND mode; without a backup a later failure loses the file.
          if (op.oldSha256 !== null && op.oldMode === null) op.oldMode = info.mode & 0o7777;
          if (op.oldSha256 !== null) {
            await backupFile(op, target, txid, transaction.taskId, async () => saveOps(txid, ops));
            await saveOps(txid, ops);
          }
        }
        await fs.unlink(target);
        await fsyncDir(path.dirname(target));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await updateTransaction(txid, { progress: index + 1 });
  }
  await updateTransaction(txid, { state: "committed" });
  await cleanupMergeTransaction(txid);
}

/** Reverse-order, idempotent rollback to the exact pre-merge state. */
export async function rollbackMergeTransaction(projectRoot: string, txid: string): Promise<void> {
  const transaction = await loadTransaction(txid);
  if (!transaction) throw new MergeJournalError("Merge transaction not found");
  if (transaction.state === "rolled_back") {
    // A crash between the state transition and cleanup must not strand artifacts.
    await cleanupMergeTransaction(txid);
    return;
  }
  if (transaction.state === "committed") throw new MergeJournalError("Committed transactions cannot roll back");
  const ops = transaction.ops;
  for (let index = ops.length - 1; index >= 0; index -= 1) {
    const op = ops[index];
    const target = path.join(projectRoot, op.path);
    // Containment first: a replaced ancestor symlink must not redirect any part
    // of the rollback, including orphan-temp removal.
    await assertOpContained(projectRoot, op.path);
    await fs.rm(tempPathFor(projectRoot, txid, op.path), { force: true }).catch(() => undefined);
    const currentHash = await sha256File(target);
    const verifyBackup = async (): Promise<Buffer> => {
      const bytes = await fs.readFile(op.backupPath!);
      const backupHash = await (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
      if (backupHash !== op.oldSha256) throw new MergeJournalError(`Backup content mismatch for ${op.path}; refusing rollback`);
      return bytes;
    };
    if (op.op === "write" && op.oldSha256 === null) {
      // Only remove what this transaction created; any other content at the path
      // belongs to someone else and must survive the rollback.
      if (currentHash !== null) {
        if (currentHash !== op.newSha256) throw new MergeJournalError(`Third-party content appeared at ${op.path}; refusing rollback`);
        await fs.unlink(target);
        await fsyncParent(target);
      }
    } else if (op.oldSha256 !== null) {
      // Mode-only writes have oldSha256 === newSha256, so content equality alone
      // would skip the restore; the mode must return to its old value too.
      const currentMode = await fs.stat(target).then((info) => info.mode & 0o7777, () => null);
      if (currentHash === op.oldSha256 && currentMode === op.oldMode) { /* already restored */ }
      else {
        if (op.op === "write" && currentHash !== op.newSha256 && currentHash !== op.oldSha256) throw new MergeJournalError(`Third-party content at ${op.path}; refusing rollback`);
        if (op.op === "delete" && currentHash !== null && currentHash !== op.oldSha256) throw new MergeJournalError(`Third-party content appeared at ${op.path}; refusing rollback`);
        if (!op.backupPath) throw new MergeJournalError(`Missing backup for ${op.path}; cannot roll back`);
        const bytes = await verifyBackup();
        await writeDurable(target, bytes, op.oldMode!, `${target}.jb-rollback-${txid}.tmp`);
      }
    }
    for (const created of [...op.createdParents].reverse()) {
      try { await fs.rmdir(created); await fsyncDir(path.dirname(created)); }
      catch { /* not empty or already gone */ }
    }
    for (const created of [...op.createdBackupDirs].reverse()) {
      try { await fs.rmdir(created); await fsyncDir(path.dirname(created)); }
      catch { /* not empty or already gone */ }
    }
  }
  await updateTransaction(txid, { state: "rolled_back" });
  await cleanupMergeTransaction(txid);
}

async function fsyncParent(target: string): Promise<void> {
  await fsyncDir(path.dirname(target));
}

/** Removes orphan temps and backup artifacts for a finished transaction.
 * Progress is journaled so a crash mid-cleanup resumes instead of stranding
 * artifacts. Idempotent. */
export async function cleanupMergeTransaction(txid: string): Promise<void> {
  const db = await journalDatabase();
  const row = db.prepare("SELECT state, cleanup_progress, ops FROM merge_transactions WHERE txid = ?").get(txid) as { state: string; cleanup_progress: number; ops: string } | undefined;
  if (!row || (row.state !== "committed" && row.state !== "rolled_back")) return;
  const ops = JSON.parse(row.ops) as MergeOp[];
  for (let index = row.cleanup_progress; index < ops.length; index += 1) {
    const op = ops[index];
    if (op.backupPath) {
      try { await fs.rm(op.backupPath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          // Stop without advancing: a stuck artifact must not be marked clean by
          // later successes; the next recovery retries from here.
          throw new MergeJournalError(`Cleanup failed for ${op.path}: ${(error as Error).message}`);
        }
      }
    }
    await updateTransaction(txid, { cleanup_progress: index + 1 });
  }
  const owner = db.prepare("SELECT task_id FROM merge_transactions WHERE txid = ?").get(txid) as { task_id: string } | undefined;
  if (owner) {
    const backupDir = path.join(mergeBackupRoot(), owner.task_id, txid);
    await fs.rm(backupDir, { recursive: true, force: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new MergeJournalError(`Backup directory cleanup failed for ${txid}: ${(error as Error).message}`);
    });
  }
}

export interface RecoveredMergeTransaction {
  txid: string;
  taskId: string;
  projectId: string;
  outcome: "rolled-back" | "committed";
}

/** Startup and pre-mutation recovery (plan §8): never reads workspace files. */
export async function recoverMergeTransactions(projectRootFor: (projectId: string) => Promise<string | null>): Promise<RecoveredMergeTransaction[]> {
  const db = await journalDatabase();
  const recovered: RecoveredMergeTransaction[] = [];
  const openRows = db.prepare("SELECT txid, project_id FROM merge_transactions WHERE state IN ('planned', 'applying', 'rolled_back')").all() as Array<{ txid: string; project_id: string }>;
  for (const row of openRows) {
    const projectRoot = await projectRootFor(row.project_id);
    if (!projectRoot) continue;
    await rollbackMergeTransaction(projectRoot, row.txid);
    recovered.push({ txid: row.txid, taskId: "", projectId: row.project_id, outcome: "rolled-back" });
    const transaction = await loadTransaction(row.txid);
    if (transaction) recovered[recovered.length - 1].taskId = transaction.taskId;
  }
  const committedRows = db.prepare("SELECT txid FROM merge_transactions WHERE state = 'committed'").all() as Array<{ txid: string }>;
  for (const row of committedRows) {
    const transaction = await loadTransaction(row.txid);
    await cleanupMergeTransaction(row.txid);
    if (transaction) recovered.push({ txid: row.txid, taskId: transaction.taskId, projectId: transaction.projectId, outcome: "committed" });
  }
  return recovered;
}

export async function openMergeTransactionCount(): Promise<number> {
  const db = await journalDatabase();
  const row = db.prepare("SELECT COUNT(*) AS count FROM merge_transactions WHERE state IN ('planned', 'applying')").get() as { count: number };
  return row.count;
}
