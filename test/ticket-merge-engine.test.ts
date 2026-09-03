import assert from "node:assert/strict";
import test from "node:test";
import { decide, type FileState } from "../src/ticket-merge.js";

function states(entries: Array<[string, string]>): Map<string, FileState> {
  return new Map(entries.map(([path, sha256]) => [path, { path, sha256, mode: 0o644 }]));
}

function decisionFor(decisions: ReturnType<typeof decide>, path: string) {
  const found = decisions.find((decision) => decision.path === path);
  if (!found) throw new Error(`no decision for ${path}`);
  return found;
}

const A = "aaaaaaaa";
const B = "bbbbbbbb";
const C = "cccccccc";

test("three-way decision matrix per file", () => {
  const baseline = states([
    ["untouched", A],                     // nobody changed
    ["agent-only", A],                    // workspace changed, project at baseline
    ["project-only", A],                  // project changed, workspace at baseline
    ["same-both-sides", A],               // both made the identical change
    ["text-both", A],                     // both changed, differently, text-mergeable
    ["binary-both", A],                   // both changed, not text-mergeable
    ["agent-deleted", A],                 // workspace deleted, project at baseline
    ["agent-deleted-project-edited", A],  // workspace deleted, project changed
    ["project-deleted", A],               // project deleted, workspace at baseline
    ["project-deleted-agent-edited", A],  // project deleted, workspace changed
  ]);
  const workspace = states([
    ["untouched", A],
    ["agent-only", B],
    ["project-only", A],
    ["same-both-sides", B],
    ["text-both", B],
    ["binary-both", B],
    ["same-both-sides", B],
    ["project-deleted", A],
    ["project-deleted-agent-edited", B],
    ["agent-created", A],
  ]);
  const project = states([
    ["untouched", A],
    ["agent-only", A],
    ["project-only", B],
    ["same-both-sides", B],
    ["text-both", C],
    ["binary-both", C],
    ["agent-deleted", A],
    ["agent-deleted-project-edited", B],
    ["project-deleted", A],
    ["project-created", A],
  ]);

  const textMergeable = new Set(["text-both"]);
  const decisions = decide(baseline, workspace, project, { textMergeable });

  assert.equal(decisionFor(decisions, "untouched").kind, "skip");
  assert.equal(decisionFor(decisions, "agent-only").kind, "apply");
  assert.equal(decisionFor(decisions, "project-only").kind, "keep-project");
  assert.equal(decisionFor(decisions, "same-both-sides").kind, "skip");
  assert.equal(decisionFor(decisions, "text-both").kind, "text");
  assert.equal(decisionFor(decisions, "binary-both").kind, "choice");
  assert.equal(decisionFor(decisions, "agent-deleted").kind, "delete");
  assert.equal(decisionFor(decisions, "agent-deleted-project-edited").kind, "choice");
  assert.equal(decisionFor(decisions, "project-deleted").kind, "skip");
  assert.equal(decisionFor(decisions, "project-deleted-agent-edited").kind, "choice");
  assert.equal(decisionFor(decisions, "agent-created").kind, "apply");
  assert.equal(decisionFor(decisions, "project-created").kind, "skip");
});

test("files created on both sides with different content are a choice, identical are skipped", () => {
  const baseline = states([]);
  const decisions = decide(baseline, states([["both", A]]), states([["both", B]]), { textMergeable: new Set() });
  assert.equal(decisionFor(decisions, "both").kind, "choice");

  const identical = decide(baseline, states([["both", A]]), states([["both", A]]), { textMergeable: new Set() });
  assert.equal(decisionFor(identical, "both").kind, "skip");
});

test("absent baseline degrades every divergent file to a choice", () => {
  const workspace = states([["changed", B], ["created", A]]);
  const project = states([["changed", A]]);
  const decisions = decide(new Map(), workspace, project, { textMergeable: new Set(["changed"]), legacy: true });
  assert.equal(decisionFor(decisions, "changed").kind, "choice");
  assert.equal(decisionFor(decisions, "created").kind, "choice");
  // Without the legacy flag (a fresh ticket whose baseline legitimately lacks new
  // files) workspace-only creations still apply automatically.
  const fresh = decide(new Map(), workspace, project, { textMergeable: new Set() });
  assert.equal(decisionFor(fresh, "created").kind, "apply");
});

test("mode divergence produces explicit choices in every branch", () => {
  const A = "aaaaaaaa";
  const withMode = (sha: string, mode: number): FileState => ({ path: "", sha256: sha, mode });
  // Both-created, equal bytes, divergent modes.
  const bothCreated = decide(new Map(), new Map([["f", withMode(A, 0o644)]]), new Map([["f", withMode(A, 0o755)]]), { textMergeable: new Set() });
  assert.equal(bothCreated.find((d) => d.path === "f")?.kind, "choice", "both-created mode divergence must be a choice");

  // Workspace deleted, project only chmod'd the file.
  const base = states([["g", A]]);
  const wsDeleted = decide(base, new Map(), new Map([["g", withMode(A, 0o755)]]), { textMergeable: new Set() });
  assert.equal(wsDeleted.find((d) => d.path === "g")?.kind, "choice", "workspace-delete vs project chmod must be a choice");

  // Project deleted, workspace only chmod'd the file.
  const projDeleted = decide(base, new Map([["g", withMode(A, 0o755)]]), new Map(), { textMergeable: new Set() });
  assert.equal(projDeleted.find((d) => d.path === "g")?.kind, "choice", "project-delete vs workspace chmod must be a choice");

  // Identical content AND modes on both created sides still skips.
  const sameMode = decide(new Map(), new Map([["h", withMode(A, 0o644)]]), new Map([["h", withMode(A, 0o644)]]), { textMergeable: new Set() });
  assert.equal(sameMode.find((d) => d.path === "h")?.kind, "skip");
});

test("symlinks are never merged, only reported unmergeable", () => {
  const baseline = states([["link", A]]);
  const workspace = new Map([["link", { path: "link", sha256: B, mode: 0o644, symlink: true }]]);
  const project = states([["link", A]]);
  const decisions = decide(baseline, workspace, project, { textMergeable: new Set() });
  assert.equal(decisionFor(decisions, "link").kind, "unmergeable");
});
