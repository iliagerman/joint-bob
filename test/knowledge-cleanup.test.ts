import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanProjectKnowledge, millisecondsUntilNextRun, type CleanupDeps, type CleanupVerdict } from "../src/server/knowledge-cleanup.js";
import { addRule, knowledgeDirectory, listProposals, readSubject } from "../src/project-knowledge.js";
import type { ProjectRecord } from "../src/types.js";

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), "knowledge-cleanup-"));
  const project = { id: "p1", path: root } as ProjectRecord;
  const rule = addRule(root, { subject: "deploys", text: "Deploy from main only.", evidence: "x" });
  return { root, project, rule };
}

function deps(verdicts: (ruleId: string) => CleanupVerdict[], decision: { apply: boolean; confidence: number } | null, extra: Partial<CleanupDeps> = {}): CleanupDeps {
  return {
    hasDecisionModel: () => true,
    review: async (_project, subject) => subject.rules.flatMap((rule) => verdicts(rule.id)),
    decide: async () => decision,
    ...extra,
  };
}

const logOf = (root: string) => readFileSync(path.join(knowledgeDirectory(root), "CLEANUP-LOG.md"), "utf8");

test("a removal the decision model is more than 95% sure of is applied and logged", async () => {
  const { root, project, rule } = setup();
  try {
    const result = await cleanProjectKnowledge(project, deps((ruleId) => [{ ruleId, verdict: "remove", reason: "contradicts the code" }], { apply: true, confidence: 0.97 }));
    assert.deepEqual(result, { applied: 1, flagged: 0, skipped: false });
    assert.equal(readSubject(root, "deploys"), null);
    assert.match(logOf(root), new RegExp(`Removed ${rule.id} from deploys \\(0\\.97\\): contradicts the code`));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("exactly 95%, or no answer, flags the rule instead of removing it", async () => {
  for (const decision of [{ apply: true, confidence: 0.95 }, null]) {
    const { root, project, rule } = setup();
    try {
      const result = await cleanProjectKnowledge(project, deps((ruleId) => [{ ruleId, verdict: "remove", reason: "looks stale" }], decision));
      assert.deepEqual(result, { applied: 0, flagged: 1, skipped: false });
      assert.equal(readSubject(root, "deploys")?.rules.length, 1);
      const [proposal] = listProposals(root);
      assert.deepEqual([proposal.action, proposal.ruleId, proposal.source, proposal.subject], ["remove", rule.id, "cleanup", "deploys"]);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("a project without a decision model is skipped and the skip is logged", async () => {
  const { root, project } = setup();
  try {
    let asked = false;
    const result = await cleanProjectKnowledge(project, deps(() => [], null, { hasDecisionModel: () => false, review: async () => { asked = true; return []; } }));
    assert.deepEqual(result, { applied: 0, flagged: 0, skipped: true });
    assert.equal(asked, false);
    assert.equal(readSubject(root, "deploys")?.rules.length, 1);
    assert.match(logOf(root), /Skipped: no decision model secret for this project/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a rule edited meanwhile is flagged, never removed", async () => {
  const { root, project, rule } = setup();
  try {
    const edited = deps((ruleId) => [{ ruleId, verdict: "remove", reason: "stale" }], null, {
      decide: async () => {
        addRule(root, { subject: "deploys", text: "Another rule.", evidence: "" });
        const subject = readSubject(root, "deploys")!;
        // Someone rewrote the rule text on another machine between the review and the apply step.
        const file = path.join(knowledgeDirectory(root), "deploys.md");
        const { writeFileSync } = await import("node:fs");
        writeFileSync(file, readFileSync(file, "utf8").replace("Deploy from main only.", "Deploy from release branches only."));
        assert.equal(subject.rules.length, 2);
        return { apply: true, confidence: 0.99 };
      },
    });
    const result = await cleanProjectKnowledge(project, edited);
    assert.deepEqual(result, { applied: 0, flagged: 1, skipped: false });
    assert.ok(readSubject(root, "deploys")?.rules.some((candidate) => candidate.id === rule.id && candidate.text === "Deploy from release branches only."));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a pending cleanup proposal for the same rule is not duplicated", async () => {
  const { root, project } = setup();
  try {
    const flaggedDeps = deps((ruleId) => [{ ruleId, verdict: "remove", reason: "stale" }], { apply: false, confidence: 0.6 });
    await cleanProjectKnowledge(project, flaggedDeps);
    await cleanProjectKnowledge(project, flaggedDeps);
    assert.equal(listProposals(root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a project without a knowledge folder is left alone", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "knowledge-cleanup-"));
  try {
    const result = await cleanProjectKnowledge({ id: "p2", path: root } as ProjectRecord, deps(() => [], null));
    assert.deepEqual(result, { applied: 0, flagged: 0, skipped: false });
    assert.equal(existsSync(knowledgeDirectory(root)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the next run is the coming local 03:00", () => {
  assert.equal(millisecondsUntilNextRun(new Date(2026, 10, 4, 2, 59, 0)), 60_000);
  assert.equal(millisecondsUntilNextRun(new Date(2026, 10, 4, 3, 0, 0)), 24 * 3_600_000);
  assert.equal(millisecondsUntilNextRun(new Date(2026, 10, 4, 15, 0, 0)), 12 * 3_600_000);
});

test("two rules that merge into each other are not both removed", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "knowledge-cleanup-"));
  try {
    const first = addRule(root, { subject: "db", text: "Use the tunnel on 5433.", evidence: "" });
    const second = addRule(root, { subject: "db", text: "Connect through the SSH tunnel, port 5433.", evidence: "" });
    const result = await cleanProjectKnowledge({ id: "p3", path: root } as ProjectRecord, deps(() => [], { apply: true, confidence: 0.99 }, {
      review: async () => [
        { ruleId: first.id, verdict: "merge", mergeWith: second.id, reason: "same rule" },
        { ruleId: second.id, verdict: "merge", mergeWith: first.id, reason: "same rule" },
      ],
    }));
    assert.deepEqual(result, { applied: 1, flagged: 1, skipped: false });
    assert.deepEqual(readSubject(root, "db")?.rules.map((rule) => rule.id), [second.id]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a merge into a rule that does not exist is flagged, never applied", async () => {
  const { root, project, rule } = setup();
  try {
    const result = await cleanProjectKnowledge(project, deps((ruleId) => [{ ruleId, verdict: "merge", mergeWith: "r-gone", reason: "covered elsewhere" }], { apply: true, confidence: 0.99 }));
    assert.deepEqual(result, { applied: 0, flagged: 1, skipped: false });
    assert.equal(readSubject(root, "deploys")?.rules[0].id, rule.id);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
