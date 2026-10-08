import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { resolveDataDirectory } from "./data-directory.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
class MergeJournalError extends Error {
}
const dataDir = resolveDataDirectory();
let journalPromise;
function mergeBackupRoot() {
  return path.join(dataDir, "merge-backups");
}
async function journalDatabase() {
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
      const journalColumns = db.prepare("PRAGMA table_info(merge_transactions)").all();
      if (!journalColumns.some((column) => column.name === "cleanup_progress")) db.exec("ALTER TABLE merge_transactions ADD COLUMN cleanup_progress INTEGER NOT NULL DEFAULT 0");
      return db;
    })();
  }
  return journalPromise;
}
async function fsyncDir(directory) {
  try {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
  }
}
async function sha256File(filePath) {
  try {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function assertOpContained(projectRoot, filePath) {
  const segments = filePath.split("/");
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === "..")) throw new MergeJournalError(`Invalid op path: ${filePath}`);
  let existing = await fs.realpath(projectRoot);
  let index = 0;
  while (index < segments.length) {
    const candidate = path.join(existing, segments[index]);
    let info = null;
    try {
      info = await fs.lstat(candidate);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
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
async function writeAll(handle, bytes) {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written);
    if (result.bytesWritten === 0) throw new MergeJournalError("File write made no progress");
    written += result.bytesWritten;
  }
}
async function writeDurable(target, bytes, mode, tempPath) {
  const handle = await fs.open(tempPath, "w", mode);
  try {
    await writeAll(handle, bytes);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tempPath, target);
  await fsyncDir(path.dirname(target));
}
function tempPathFor(projectRoot, txid, filePath) {
  return path.join(path.dirname(path.join(projectRoot, filePath)), `.${path.basename(filePath)}.jb-merge-${txid}.tmp`);
}
async function updateTransaction(txid, fields) {
  const db = await journalDatabase();
  const entries = Object.entries(fields);
  const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE merge_transactions SET ${assignments}, updated_at = ? WHERE txid = ?`).run(...entries.map(([, value]) => value), (/* @__PURE__ */ new Date()).toISOString(), txid);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function recordMergeTransaction(taskId, projectId, ops) {
  const db = await journalDatabase();
  const txid = randomUUID();
  const now = (/* @__PURE__ */ new Date()).toISOString();
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
async function loadTransaction(txid) {
  const db = await journalDatabase();
  const row = db.prepare("SELECT * FROM merge_transactions WHERE txid = ?").get(txid);
  if (!row) return null;
  return { txid: row.txid, taskId: row.task_id, projectId: row.project_id, state: row.state, progress: row.progress, ops: JSON.parse(row.ops) };
}
async function saveOps(txid, ops) {
  await updateTransaction(txid, { ops: JSON.stringify(ops) });
}
async function mkdirpTracked(target, tracked, beforeCreate) {
  const missing = [];
  let current = target;
  for (; ; ) {
    try {
      await fs.stat(current);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      missing.push(current);
      const parent = path.dirname(current);
      if (parent === current) throw new MergeJournalError(`Cannot create ${target}`);
      current = parent;
    }
  }
  for (const directory of missing.reverse()) {
    tracked.push(directory);
    if (beforeCreate) await beforeCreate(directory);
    await fs.mkdir(directory).catch(async (error) => {
      if (error.code !== "EEXIST") throw error;
    });
    await fsyncDir(path.dirname(directory));
  }
}
async function backupFile(op, source, txid, taskId, persist) {
  if (op.oldSha256 === null || op.oldMode === null) return;
  const bytes = await fs.readFile(source);
  const { createHash } = await import("node:crypto");
  const readHash = createHash("sha256").update(bytes).digest("hex");
  if (readHash !== op.oldSha256) throw new MergeJournalError(`Project changed under the merge at ${op.path}; refusing to continue`);
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
async function applyMergeTransaction(projectRoot, txid, stagedSource) {
  const transaction = await loadTransaction(txid);
  if (!transaction) throw new MergeJournalError("Merge transaction not found");
  if (transaction.state === "committed") {
    await cleanupMergeTransaction(txid);
    return;
  }
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
      if (op.oldSha256 !== null) {
        const nowHash = await sha256File(target);
        const nowMode = await fs.stat(target).then((info) => info.mode & 4095, () => null);
        if (nowHash !== op.oldSha256 || nowMode === null || nowMode !== op.oldMode) throw new MergeJournalError(`Project changed under the merge at ${op.path}; refusing to apply`);
      } else if (await sha256File(target) !== null) {
        throw new MergeJournalError(`Third-party content appeared at ${op.path}; refusing to apply`);
      }
      const bytes = await stagedSource(op);
      await writeDurable(target, bytes, op.newMode, tempPathFor(projectRoot, txid, op.path));
    } else {
      try {
        const info = await fs.stat(target);
        if (info.isFile()) {
          if (op.oldSha256 !== null && op.oldMode === null) op.oldMode = info.mode & 4095;
          if (op.oldSha256 !== null) {
            await backupFile(op, target, txid, transaction.taskId, async () => saveOps(txid, ops));
            await saveOps(txid, ops);
          }
        }
        await fs.unlink(target);
        await fsyncDir(path.dirname(target));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    await updateTransaction(txid, { progress: index + 1 });
  }
  await updateTransaction(txid, { state: "committed" });
  await cleanupMergeTransaction(txid);
}
async function rollbackMergeTransaction(projectRoot, txid) {
  const transaction = await loadTransaction(txid);
  if (!transaction) throw new MergeJournalError("Merge transaction not found");
  if (transaction.state === "rolled_back") {
    await cleanupMergeTransaction(txid);
    return;
  }
  if (transaction.state === "committed") throw new MergeJournalError("Committed transactions cannot roll back");
  const ops = transaction.ops;
  for (let index = ops.length - 1; index >= 0; index -= 1) {
    const op = ops[index];
    const target = path.join(projectRoot, op.path);
    await assertOpContained(projectRoot, op.path);
    await fs.rm(tempPathFor(projectRoot, txid, op.path), { force: true }).catch(() => void 0);
    const currentHash = await sha256File(target);
    const verifyBackup = async () => {
      const bytes = await fs.readFile(op.backupPath);
      const backupHash = await (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
      if (backupHash !== op.oldSha256) throw new MergeJournalError(`Backup content mismatch for ${op.path}; refusing rollback`);
      return bytes;
    };
    if (op.op === "write" && op.oldSha256 === null) {
      if (currentHash !== null) {
        if (currentHash !== op.newSha256) throw new MergeJournalError(`Third-party content appeared at ${op.path}; refusing rollback`);
        await fs.unlink(target);
        await fsyncParent(target);
      }
    } else if (op.oldSha256 !== null) {
      const currentMode = await fs.stat(target).then((info) => info.mode & 4095, () => null);
      if (currentHash === op.oldSha256 && currentMode === op.oldMode) {
      } else {
        if (op.op === "write" && currentHash !== op.newSha256 && currentHash !== op.oldSha256) throw new MergeJournalError(`Third-party content at ${op.path}; refusing rollback`);
        if (op.op === "delete" && currentHash !== null && currentHash !== op.oldSha256) throw new MergeJournalError(`Third-party content appeared at ${op.path}; refusing rollback`);
        if (!op.backupPath) throw new MergeJournalError(`Missing backup for ${op.path}; cannot roll back`);
        const bytes = await verifyBackup();
        await writeDurable(target, bytes, op.oldMode, `${target}.jb-rollback-${txid}.tmp`);
      }
    }
    for (const created of [...op.createdParents].reverse()) {
      try {
        await fs.rmdir(created);
        await fsyncDir(path.dirname(created));
      } catch {
      }
    }
    for (const created of [...op.createdBackupDirs].reverse()) {
      try {
        await fs.rmdir(created);
        await fsyncDir(path.dirname(created));
      } catch {
      }
    }
  }
  await updateTransaction(txid, { state: "rolled_back" });
  await cleanupMergeTransaction(txid);
}
async function fsyncParent(target) {
  await fsyncDir(path.dirname(target));
}
async function cleanupMergeTransaction(txid) {
  const db = await journalDatabase();
  const row = db.prepare("SELECT state, cleanup_progress, ops FROM merge_transactions WHERE txid = ?").get(txid);
  if (!row || row.state !== "committed" && row.state !== "rolled_back") return;
  const ops = JSON.parse(row.ops);
  for (let index = row.cleanup_progress; index < ops.length; index += 1) {
    const op = ops[index];
    if (op.backupPath) {
      try {
        await fs.rm(op.backupPath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw new MergeJournalError(`Cleanup failed for ${op.path}: ${error.message}`);
        }
      }
    }
    await updateTransaction(txid, { cleanup_progress: index + 1 });
  }
  const owner = db.prepare("SELECT task_id FROM merge_transactions WHERE txid = ?").get(txid);
  if (owner) {
    const backupDir = path.join(mergeBackupRoot(), owner.task_id, txid);
    await fs.rm(backupDir, { recursive: true, force: true }).catch((error) => {
      if (error.code !== "ENOENT") throw new MergeJournalError(`Backup directory cleanup failed for ${txid}: ${error.message}`);
    });
  }
}
async function recoverMergeTransactions(projectRootFor) {
  const db = await journalDatabase();
  const recovered = [];
  const openRows = db.prepare("SELECT txid, project_id FROM merge_transactions WHERE state IN ('planned', 'applying', 'rolled_back')").all();
  for (const row of openRows) {
    const projectRoot = await projectRootFor(row.project_id);
    if (!projectRoot) continue;
    await rollbackMergeTransaction(projectRoot, row.txid);
    recovered.push({ txid: row.txid, taskId: "", projectId: row.project_id, outcome: "rolled-back" });
    const transaction = await loadTransaction(row.txid);
    if (transaction) recovered[recovered.length - 1].taskId = transaction.taskId;
  }
  const committedRows = db.prepare("SELECT txid FROM merge_transactions WHERE state = 'committed'").all();
  for (const row of committedRows) {
    const transaction = await loadTransaction(row.txid);
    await cleanupMergeTransaction(row.txid);
    if (transaction) recovered.push({ txid: row.txid, taskId: transaction.taskId, projectId: transaction.projectId, outcome: "committed" });
  }
  return recovered;
}
async function openMergeTransactionCount() {
  const db = await journalDatabase();
  const row = db.prepare("SELECT COUNT(*) AS count FROM merge_transactions WHERE state IN ('planned', 'applying')").get();
  return row.count;
}
export {
  MergeJournalError,
  applyMergeTransaction,
  assertOpContained,
  cleanupMergeTransaction,
  mergeBackupRoot,
  openMergeTransactionCount,
  recordMergeTransaction,
  recoverMergeTransactions,
  rollbackMergeTransaction
};
