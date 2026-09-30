import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { checkedConversationFiles, pendingReviewDiff } from "../src/server/git-review-guide.js";

const git = promisify(execFile);

test("pending review includes only selected staged, unstaged and untracked files and detects later edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-guide-"));
  try {
    await git("git", ["init", "-q", root]);
    await writeFile(path.join(root, "selected.txt"), "before\n");
    await writeFile(path.join(root, "other.txt"), "unrelated\n");
    await git("git", ["-C", root, "add", "."]);
    await git("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"]);
    await writeFile(path.join(root, "selected.txt"), "staged\n");
    await git("git", ["-C", root, "add", "selected.txt"]);
    await writeFile(path.join(root, "selected.txt"), "unstaged\n");
    await writeFile(path.join(root, "other.txt"), "changed elsewhere\n");
    await writeFile(path.join(root, "untracked.txt"), "new file\n");
    const first = await pendingReviewDiff(root, ["selected.txt", "untracked.txt"]);
    assert.equal(first.changes.length, 3);
    assert.match(first.diff, /staged/);
    assert.match(first.diff, /unstaged/);
    assert.match(first.patches["untracked.txt"], /new file/);
    assert.doesNotMatch(first.diff, /changed elsewhere/);
    await writeFile(path.join(root, "selected.txt"), "edited again\n");
    const second = await pendingReviewDiff(root, ["selected.txt", "untracked.txt"]);
    assert.notEqual(second.fingerprint, first.fingerprint);
    assert.throws(() => checkedConversationFiles("project", root, "conversation", ["other.txt"]), /expired/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
