import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  KnowledgeError, addRule, deleteProposal, knowledgeDirectory, listProposals, normalizedRuleText, pruneOld, readNotes, readSubject,
  readSubjects, rebuildIndex, removeRule, writeNote, writeProposal,
} from "../src/project-knowledge.js";

function projectRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "knowledge-"));
}

const DAY = 24 * 3_600_000;

test("addRule creates the subject file and the index", () => {
  const root = projectRoot();
  try {
    addRule(root, { subject: "database-access", description: "How agents reach the project's databases", text: "Use the tunnel on 5433.", evidence: "3 conversations" }, "2026-11-04");
    const subject = readSubject(root, "database-access");
    assert.equal(subject?.rules.length, 1);
    assert.equal(subject?.rules[0].text, "Use the tunnel on 5433.");
    assert.equal(subject?.rules[0].added, "2026-11-04");
    assert.match(readFileSync(path.join(knowledgeDirectory(root), "INDEX.md"), "utf8"), /- \[database-access\]\(database-access\.md\) — How agents reach the project's databases \(1 rule\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("removeRule drops the rule and the empty subject file", () => {
  const root = projectRoot();
  try {
    const rule = addRule(root, { subject: "deploys", text: "Deploy from main only.", evidence: "" });
    assert.equal(removeRule(root, "deploys", rule.id), true);
    assert.equal(readSubject(root, "deploys"), null);
    assert.doesNotMatch(readFileSync(path.join(knowledgeDirectory(root), "INDEX.md"), "utf8"), /deploys/);
    assert.equal(removeRule(root, "deploys", rule.id), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a hand-edited subject file still parses and the index heals", () => {
  const root = projectRoot();
  try {
    mkdirSync(knowledgeDirectory(root), { recursive: true });
    writeFileSync(path.join(knowledgeDirectory(root), "tests.md"), "# tests\n\nstray paragraph\n\n## r-x\n\nRun the unit tests first.\n");
    const subjects = readSubjects(root);
    assert.equal(subjects.length, 1);
    assert.equal(subjects[0].rules[0].text, "Run the unit tests first.");
    assert.equal(subjects[0].rules[0].evidence, "");
    rebuildIndex(root);
    assert.match(readFileSync(path.join(knowledgeDirectory(root), "INDEX.md"), "utf8"), /\(1 rule\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unsafe names are rejected and nothing is written outside the folder", () => {
  const root = projectRoot();
  try {
    assert.throws(() => addRule(root, { subject: "../x", text: "t", evidence: "" }), (error: unknown) => error instanceof KnowledgeError && error.status === 400);
    assert.throws(() => writeNote(root, { conversationId: "a/b", updatedAt: new Date().toISOString(), problems: [], dismissed: [] }), (error: unknown) => error instanceof KnowledgeError && error.status === 400);
    assert.throws(() => deleteProposal(root, ".."), (error: unknown) => error instanceof KnowledgeError && error.status === 400);
    assert.equal(existsSync(path.join(root, "x.md")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a project without the folder reads as empty", () => {
  const root = projectRoot();
  try {
    assert.deepEqual(readSubjects(root), []);
    assert.deepEqual(readNotes(root), []);
    assert.deepEqual(listProposals(root), []);
    assert.equal(existsSync(knowledgeDirectory(root)), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("pruneOld deletes old notes and proposals only", () => {
  const root = projectRoot();
  const now = new Date("2026-11-04T03:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  try {
    writeNote(root, { conversationId: "old", updatedAt: ago(31), problems: [], dismissed: [] });
    writeNote(root, { conversationId: "fresh", updatedAt: ago(29), problems: [], dismissed: [] });
    writeProposal(root, { id: "old", action: "add", subject: "a", text: "t", evidence: "", created: ago(31), source: "c" });
    writeProposal(root, { id: "fresh", action: "add", subject: "a", text: "t", evidence: "", created: ago(29), source: "c" });
    assert.deepEqual(pruneOld(root, now), { notes: 1, proposals: 1 });
    assert.deepEqual(readNotes(root).map((note) => note.conversationId), ["fresh"]);
    assert.deepEqual(listProposals(root).map((proposal) => proposal.id), ["fresh"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("notes and proposals round-trip, proposals newest first", () => {
  const root = projectRoot();
  try {
    const note = { conversationId: "c1", updatedAt: "2026-11-04T01:00:00.000Z", problems: [{ subject: "db", text: "timed out" }], dismissed: ["x"] };
    writeNote(root, note);
    assert.deepEqual(readNotes(root), [note]);
    writeProposal(root, { id: "a", action: "add", subject: "db", text: "one", evidence: "", created: "2026-11-01T00:00:00.000Z", source: "c1" });
    writeProposal(root, { id: "b", action: "remove", subject: "db", text: "two", evidence: "", ruleId: "r-1", created: "2026-11-02T00:00:00.000Z", source: "cleanup" });
    assert.deepEqual(listProposals(root).map((proposal) => proposal.id), ["b", "a"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("normalizedRuleText ignores case, spacing and trailing punctuation", () => {
  assert.equal(normalizedRuleText("  Use the  Tunnel. "), normalizedRuleText("use the tunnel"));
});

test("rule text under a hand-written heading is kept through a rewrite", () => {
  const root = projectRoot();
  try {
    mkdirSync(knowledgeDirectory(root), { recursive: true });
    writeFileSync(path.join(knowledgeDirectory(root), "db.md"), "# db\n\nDB stuff.\n\n## Tunnel rule\n\nUse the SSH tunnel on 5433.\n\n## r-abc\n\nOther rule.\n");
    addRule(root, { subject: "db", text: "A third rule.", evidence: "" });
    const texts = readSubject(root, "db")!.rules.map((rule) => rule.text);
    assert.ok(texts.some((text) => text.includes("Use the SSH tunnel on 5433.")), JSON.stringify(texts));
    assert.ok(texts.includes("Other rule.") && texts.includes("A third rule."));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("malformed note and proposal files are skipped, and missing optional fields are filled in", () => {
  const root = projectRoot();
  try {
    const dir = knowledgeDirectory(root);
    mkdirSync(path.join(dir, "proposals"), { recursive: true });
    mkdirSync(path.join(dir, "notes"), { recursive: true });
    writeFileSync(path.join(dir, "proposals", "nocreated.json"), JSON.stringify({ id: "nocreated", action: "add", subject: "a", text: "t" }));
    writeFileSync(path.join(dir, "proposals", "noevidence.json"), JSON.stringify({ id: "noevidence", action: "add", subject: "a", text: "t", created: "2026-11-01T00:00:00.000Z", source: "c" }));
    writeFileSync(path.join(dir, "notes", "bare.json"), JSON.stringify({ conversationId: "bare", updatedAt: "2026-11-01T00:00:00.000Z" }));
    writeFileSync(path.join(dir, "notes", "nodate.json"), JSON.stringify({ conversationId: "nodate" }));
    assert.deepEqual(listProposals(root).map((proposal) => [proposal.id, proposal.evidence]), [["noevidence", ""]]);
    assert.deepEqual(readNotes(root).map((note) => [note.conversationId, note.problems, note.dismissed]), [["bare", [], []]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
