import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/** Returns the source text of a function, from its header to its closing brace at column 0. */
function functionBody(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} not found`);
  const end = source.indexOf("\n}", start);
  assert.notEqual(end, -1, `${header} has no closing brace`);
  return source.slice(start, end);
}

test("fs.cp ticket cards surface merge state and gated archive in the overflow menu", async () => {
  const board = await readFile("public/board.js", "utf8");
  const menu = functionBody(board, "function taskMenuItems(task, handlers) {");

  assert.ok(menu.includes('!task.worktreeBranch && (task.worktreePath || task.mergeState !== "none")'), "menu branches on synchronized workspaces incl. replicas");
  assert.ok(menu.includes("board-task-merge-resume-button"), "conflicted tickets offer resume");
  assert.ok(menu.includes("board-task-merge-restart-button"), "conflicted tickets offer restart");
  assert.ok(menu.includes("board-task-discard-button"), "conflicted tickets offer discard");
  assert.ok(menu.includes("Merge back to project"), "clean done tickets offer the merge-back action");
  assert.ok(menu.includes("archiveBlockedByMerge"), "archive is gated while a workspace is unmerged");
  assert.ok(menu.includes("Merge the ticket workspace (or discard it) before archiving"), "the gate names the escape hatch");
});

test("fs.cp ticket cards carry a merge state chip", async () => {
  const board = await readFile("public/board.js", "utf8");
  const card = functionBody(board, "function taskCard(task, handlers) {");

  assert.ok(card.includes("board-task-merge-chip"), "the card renders a merge chip");
  assert.ok(card.includes("task-merge-merged"), "merged state class");
  assert.ok(card.includes("task-merge-conflicts"), "conflicts state class");
  assert.ok(card.includes("task-merge-pending"), "pending state class");
});

test("the app wires a conflict picker with per-file side choices", async () => {
  const app = await readFile("public/app.js", "utf8");
  assert.ok(app.includes("mergeConflictDialog"), "conflict dialog exists");
  assert.ok(app.includes("merge-resolve"), "picker calls the resolve route");
  assert.ok(app.includes("openFileAction(`.joint-bob-merge/staged/${conflict.path}`, task.id)"), "staged text files open with the ticket scope");
  const index = await readFile("public/index.html", "utf8");
  assert.ok(index.includes('id="mergeConflictDialog"'), "dialog markup exists");
});

test("the app wires merge resume, restart, and discard handlers to the board", async () => {
  const app = await readFile("public/app.js", "utf8");
  for (const [name, route] of [
    ["resumeTaskMerge", "merge-resume"],
    ["restartTaskMerge", "merge-restart"],
    ["discardTaskChanges", "discard"],
  ] as const) {
    assert.ok(app.includes(`async function ${name}`), `${name} handler exists`);
    assert.ok(app.includes(`/tasks/${"${encodeURIComponent(task.id)}"}/${route}`) || app.includes(`/${route}`), `${name} calls the ${route} route`);
  }
  assert.ok(app.includes("onMergeResume: resumeTaskMerge"), "board receives the resume handler");
  assert.ok(app.includes("onDiscard: discardTaskChanges"), "board receives the discard handler");
});
