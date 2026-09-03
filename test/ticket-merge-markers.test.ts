import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateStagedConflicts, type MergeConflictEntry } from "../src/ticket-merge-ops.js";

async function stage(workspace: string, relative: string, body: string): Promise<string> {
  const target = path.join(workspace, ".joint-bob-merge", "staged", relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, body);
  return target;
}

function textConflict(overrides: Partial<MergeConflictEntry> = {}): MergeConflictEntry {
  return {
    path: "file.txt",
    kind: "text",
    unresolvedSha256: "unresolved-hash",
    markerLines: ["<<<<<<< JB-MERGE abc123 ", "||||||| JB-MERGE abc123 ", "======= JB-MERGE abc123 ", ">>>>>>> JB-MERGE abc123 "],
    preExistingMarkerLines: [],
    ...overrides,
  };
}

test("text conflicts resolve only when every generated marker is gone and no new marker syntax appears", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-marker-"));
  try {
    // Clean resolution.
    await stage(root, "file.txt", "resolved content\n");
    const clean = await validateStagedConflicts(root, [textConflict()]);
    assert.equal(clean.remaining.length, 0);

    // Untouched marker file stays unresolved.
    await writeFile(path.join(root, ".joint-bob-merge", "staged", "file.txt"), "<<<<<<< JB-MERGE abc123 \nworkspace\n======= JB-MERGE abc123 \nproject\n>>>>>>> JB-MERGE abc123 \n");
    const untouched = await validateStagedConflicts(root, [textConflict()]);
    assert.equal(untouched.remaining.length, 1);

    // Removing the markers but introducing NEW marker syntax (wider, untagged) is rejected.
    await writeFile(path.join(root, ".joint-bob-merge", "staged", "file.txt"), "<<<<<<<<\nresolved\n>>>>>>>>\n");
    const wider = await validateStagedConflicts(root, [textConflict()]);
    assert.equal(wider.remaining.length, 1, "wider untagged markers must count as new marker syntax");

    // A tweaked tag must not pass as resolution.
    await writeFile(path.join(root, ".joint-bob-merge", "staged", "file.txt"), "<<<<<<< JB-MERG abc123 \nresolved\n>>>>>>> JB-MERGE abc123 \n");
    const tweaked = await validateStagedConflicts(root, [textConflict()]);
    assert.equal(tweaked.remaining.length, 1, "tweaked tag line is new marker syntax");

    // Pre-existing legitimate marker-looking lines are allowed to remain.
    const legit = textConflict({ preExistingMarkerLines: ["<<<<<<< HEAD"] });
    await writeFile(path.join(root, ".joint-bob-merge", "staged", "file.txt"), "resolved\n<<<<<<< HEAD\nlegit content\n");
    const allowed = await validateStagedConflicts(root, [legit]);
    assert.equal(allowed.remaining.length, 0);

    // Pre-existing lines are counted as a multiset: duplicates are new syntax.
    const duplicated = textConflict({ preExistingMarkerLines: ["<<<<<<< HEAD"] });
    await writeFile(path.join(root, ".joint-bob-merge", "staged", "file.txt"), "resolved\n<<<<<<< HEAD\n<<<<<<< HEAD\n");
    const dupes = await validateStagedConflicts(root, [duplicated]);
    assert.equal(dupes.remaining.length, 1, "duplicate pre-existing marker lines must be rejected");

    // Any remaining JB-MERGE tag rejects even without matching a recorded line.
    await writeFile(path.join(root, ".joint-bob-merge", "staged", "file.txt"), "resolved\n|||||||| JB-MERGE abc123 \n");
    const strayTag = await validateStagedConflicts(root, [textConflict()]);
    assert.equal(strayTag.remaining.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("equal-content mode conflicts resolve only when the staged mode matches the selected side", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-mode-choice-"));
  try {
    const { chmod } = await import("node:fs/promises");
    const { createHash } = await import("node:crypto");
    const bytes = "#!/bin/sh\n";
    const digest = createHash("sha256").update(bytes).digest("hex");
    const entry: MergeConflictEntry = {
      path: "tool.sh",
      kind: "choice",
      reason: "mode-conflict",
      choices: { workspace: digest, project: digest, workspaceMode: 0o755, projectMode: 0o644 },
    };
    await stage(root, "tool.sh", "#!/bin/sh\n");
    await chmod(path.join(root, ".joint-bob-merge", "staged", "tool.sh"), 0o755);
    const workspaceMode = await validateStagedConflicts(root, [entry]);
    assert.equal(workspaceMode.remaining.length, 0, "staged with the workspace mode resolves");

    await chmod(path.join(root, ".joint-bob-merge", "staged", "tool.sh"), 0o644);
    const projectMode = await validateStagedConflicts(root, [entry]);
    assert.equal(projectMode.remaining.length, 0, "staged with the project mode also resolves (either recorded side)");

    await chmod(path.join(root, ".joint-bob-merge", "staged", "tool.sh"), 0o600);
    const neither = await validateStagedConflicts(root, [entry]);
    assert.equal(neither.remaining.length, 1, "a mode matching neither side stays unresolved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("choice conflicts resolve only when staged bytes equal a recorded side", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-choice-"));
  try {
    const { createHash } = await import("node:crypto");
    const hash = (body: string): string => createHash("sha256").update(body).digest("hex");
    const entry: MergeConflictEntry = { path: "bin.dat", kind: "choice", choices: { workspace: hash("workspace\n"), project: hash("project\n") } };
    await stage(root, "bin.dat", "workspace\n");
    const good = await validateStagedConflicts(root, [entry]);
    assert.equal(good.remaining.length, 0);
    await writeFile(path.join(root, ".joint-bob-merge", "staged", "bin.dat"), "neither side\n");
    const bad = await validateStagedConflicts(root, [entry]);
    assert.equal(bad.remaining.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
