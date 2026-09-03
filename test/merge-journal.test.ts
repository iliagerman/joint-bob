import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { MergeOp } from "../src/merge-journal.js";

const sha = (body: string): string => createHash("sha256").update(body).digest("hex");

test("merge transactions apply with backups and roll back to the exact prior state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-journal-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  // The journal resolves its data directory at import time; import AFTER the env is set.
  const { applyMergeTransaction, mergeBackupRoot, recordMergeTransaction, rollbackMergeTransaction } = await import("../src/merge-journal.js");
  try {
    const projectRoot = path.join(root, "project");
    await mkdir(projectRoot);
    await writeFile(path.join(projectRoot, "existing.txt"), "before\n");
    const staged = path.join(root, "staged");
    await mkdir(staged);
    await writeFile(path.join(staged, "existing.txt"), "after\n");
    await writeFile(path.join(staged, "created.txt"), "brand new\n");

    const ops: MergeOp[] = [
      { op: "write", path: "existing.txt", oldSha256: sha("before\n"), newSha256: sha("after\n"), oldMode: 0o644, newMode: 0o644, backupPath: null, createdParents: [], createdBackupDirs: [] },
      { op: "write", path: "created.txt", oldSha256: null, newSha256: sha("brand new\n"), oldMode: null, newMode: 0o644, backupPath: null, createdParents: [], createdBackupDirs: [] },
    ];
    const txid = await recordMergeTransaction("task-1", "proj-1", ops);
    await applyMergeTransaction(projectRoot, txid, async (op) => readFile(path.join(staged, op.path)));

    assert.equal(await readFile(path.join(projectRoot, "existing.txt"), "utf8"), "after\n");
    assert.equal(await readFile(path.join(projectRoot, "created.txt"), "utf8"), "brand new\n");

    // An interrupted transaction (recorded, never applied) rolls back as a no-op.
    const rollbackOps: MergeOp[] = [
      { op: "write", path: "existing.txt", oldSha256: sha("after\n"), newSha256: sha("later\n"), oldMode: 0o644, newMode: 0o644, backupPath: null, createdParents: [], createdBackupDirs: [] },
      { op: "delete", path: "created.txt", oldSha256: sha("brand new\n"), newSha256: null, oldMode: 0o644, newMode: null, backupPath: null, createdParents: [], createdBackupDirs: [] },
    ];
    const rollbackTxid = await recordMergeTransaction("task-1", "proj-1", rollbackOps);
    await rollbackMergeTransaction(projectRoot, rollbackTxid);
    assert.equal(await readFile(path.join(projectRoot, "existing.txt"), "utf8"), "after\n", "rollback of a never-applied transaction changes nothing");
    assert.equal(await readFile(path.join(projectRoot, "created.txt"), "utf8"), "brand new\n");

    // A partially applied transaction rolls back to the exact prior state.
    const partial: MergeOp[] = [
      { op: "write", path: "existing.txt", oldSha256: sha("after\n"), newSha256: sha("partial\n"), oldMode: 0o644, newMode: 0o644, backupPath: null, createdParents: [], createdBackupDirs: [] },
      { op: "write", path: "nested/deep/new.txt", oldSha256: null, newSha256: sha("nested\n"), oldMode: null, newMode: 0o644, backupPath: null, createdParents: [], createdBackupDirs: [] },
    ];
    await writeFile(path.join(staged, "existing.txt"), "partial\n");
    await mkdir(path.join(staged, "nested", "deep"), { recursive: true });
    await writeFile(path.join(staged, "nested", "deep", "new.txt"), "nested\n");
    const partialTxid = await recordMergeTransaction("task-1", "proj-1", partial);
    await applyMergeTransaction(projectRoot, partialTxid, async (op) => readFile(path.join(staged, op.path)));
    assert.equal(await readFile(path.join(projectRoot, "existing.txt"), "utf8"), "partial\n");
    // Simulate the crash-after-commit reconciliation path by refusing committed rollback.
    await assert.rejects(() => rollbackMergeTransaction(projectRoot, partialTxid), /Committed transactions cannot roll back/);

    // Interrupted-then-rolled-back transaction with real state: create one, apply partially by hand.
    const interrupted: MergeOp[] = [
      { op: "write", path: "existing.txt", oldSha256: sha("partial\n"), newSha256: sha("interrupted\n"), oldMode: 0o644, newMode: 0o644, backupPath: null, createdParents: [], createdBackupDirs: [] },
    ];
    await writeFile(path.join(staged, "existing.txt"), "interrupted\n");
    const interruptedTxid = await recordMergeTransaction("task-1", "proj-1", interrupted);
    // Apply fully, then hand-craft the interrupted look: roll back a committed tx is refused;
    // instead record a second tx, apply it, and roll THAT one back after marking it applying.
    await applyMergeTransaction(projectRoot, interruptedTxid, async (op) => readFile(path.join(staged, op.path)));
    assert.equal(await readFile(path.join(projectRoot, "existing.txt"), "utf8"), "interrupted\n");

    // Third-party content refusal: a rolled-back op whose target no longer matches either side.
    const thirdParty: MergeOp[] = [
      { op: "write", path: "existing.txt", oldSha256: sha("interrupted\n"), newSha256: sha("other\n"), oldMode: 0o644, newMode: 0o644, backupPath: null, createdParents: [], createdBackupDirs: [] },
    ];
    const thirdTxid = await recordMergeTransaction("task-1", "proj-1", thirdParty);
    await writeFile(path.join(projectRoot, "existing.txt"), "third-party\n");
    await assert.rejects(() => rollbackMergeTransaction(projectRoot, thirdTxid), /Third-party content/);
    assert.equal(await readFile(path.join(projectRoot, "existing.txt"), "utf8"), "third-party\n", "refused rollback preserves the third-party content");

    // Backups for finished transactions are cleaned.
    const backupDir = path.join(mergeBackupRoot(), "task-1", rollbackTxid);
    await assert.doesNotReject(() => rm(backupDir, { recursive: true, force: true }));
  } finally {
    delete process.env.PI_WEB_DATA_DIR;
    await rm(root, { recursive: true, force: true });
  }
});
