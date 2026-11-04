import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addRule, knowledgeDirectory, listProposals, readNotes, writeNote, writeProposal, type KnowledgeProposal } from "../src/project-knowledge.js";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

type Knowledge = { subjects: Array<{ slug: string; rules: Array<{ id: string; text: string }> }>; proposals: KnowledgeProposal[] };

test("knowledge routes list, accept and dismiss proposals", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-knowledge-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const project = projectNamed(node, "Infra Scripts");
  const server = await startDevNode(environment, node);
  const auth = await signIn(environment, node);
  const base = `/projects/${project.id}/knowledge`;
  const proposal = (id: string, fields: Partial<KnowledgeProposal>): KnowledgeProposal => ({ id, action: "add", subject: "database-access", text: `Rule ${id}`, evidence: "two conversations", created: new Date().toISOString(), source: "conv-1", ...fields });
  try {
    const empty = await api<Knowledge>(node, auth, "GET", base);
    assert.deepEqual([empty.status, empty.body], [200, { subjects: [], proposals: [] }], "a project without the folder has nothing");

    writeProposal(project.path, proposal("p1", {}));
    writeProposal(project.path, proposal("p2", { text: "Dismiss me" }));
    writeNote(project.path, { conversationId: "conv-1", updatedAt: new Date().toISOString(), problems: [], dismissed: [] });
    assert.deepEqual((await api<Knowledge>(node, auth, "GET", base)).body.proposals.map((item) => item.id).sort(), ["p1", "p2"]);

    const accepted = await api<Knowledge>(node, auth, "POST", `${base}/proposals/p1/accept`, { text: "Edited rule" });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.deepEqual(accepted.body.subjects.map((subject) => [subject.slug, subject.rules.map((rule) => rule.text)]), [["database-access", ["Edited rule"]]]);
    assert.match(readFileSync(path.join(knowledgeDirectory(project.path), "database-access.md"), "utf8"), /Edited rule/);
    assert.deepEqual(listProposals(project.path).map((item) => item.id), ["p2"]);

    const dismissed = await api<Knowledge>(node, auth, "POST", `${base}/proposals/p2/dismiss`, {});
    assert.equal(dismissed.status, 200);
    assert.deepEqual(dismissed.body.proposals, []);
    assert.deepEqual(readNotes(project.path)[0].dismissed, ["dismiss me"], "the source note remembers the dismissal");

    const rule = addRule(project.path, { subject: "deploys", text: "Old rule", evidence: "" });
    writeProposal(project.path, proposal("p3", { action: "remove", subject: "deploys", ruleId: rule.id, text: "Old rule", source: "cleanup" }));
    const removed = await api<Knowledge>(node, auth, "POST", `${base}/proposals/p3/accept`, {});
    assert.equal(removed.status, 200);
    assert.equal(existsSync(path.join(knowledgeDirectory(project.path), "deploys.md")), false, "accepting a removal deletes the rule");

    // A cleanup proposal for a rule that changed since it was flagged, or whose merge target is gone, is refused.
    const stale = addRule(project.path, { subject: "tests", text: "Run unit tests first.", evidence: "" });
    writeProposal(project.path, proposal("p4", { action: "remove", subject: "tests", ruleId: stale.id, text: "Run unit tests first.", source: "cleanup" }));
    const file = path.join(knowledgeDirectory(project.path), "tests.md");
    writeFileSync(file, readFileSync(file, "utf8").replace("Run unit tests first.", "Run unit and type tests first."));
    assert.equal((await api(node, auth, "POST", `${base}/proposals/p4/accept`, {})).status, 409, "an edited rule is not removed by an old proposal");
    assert.match(readFileSync(file, "utf8"), /Run unit and type tests first\./);
    writeProposal(project.path, proposal("p5", { action: "merge", subject: "tests", ruleId: stale.id, mergeWith: "r-gone", text: "Run unit and type tests first.", source: "cleanup" }));
    assert.equal((await api(node, auth, "POST", `${base}/proposals/p5/accept`, {})).status, 409, "a merge whose target is gone is refused");

    assert.equal((await api(node, auth, "POST", `${base}/proposals/nope/accept`, {})).status, 404);
    assert.equal((await api(node, auth, "POST", `${base}/proposals/a%20b/accept`, {})).status, 400);
    writeProposal(project.path, proposal("p9", {}));
    assert.equal((await api(node, auth, "POST", `${base}/proposals/p9/accept`, { subject: "Bad Slug" })).status, 400);
    assert.equal((await api(node, auth, "GET", "/projects/not-a-project/knowledge")).status, 404);
  } finally {
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
