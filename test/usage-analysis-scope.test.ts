import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { seedUsageAnalysis } from "./usage-analysis-fixture.js";

test("repeated-work analysis bounds large projects and applies its own dates and limit consistently", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-analysis-scope-"));
  let server;
  try {
    const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
    seedUsageAnalysis(node);
    server = await startDevNode(environment, node);
    const session = await signIn(environment, node), projectId = node.projects[0].id;
    const large = await api<any>(node, session, "POST", "/usage/analysis", { projectId });
    assert.equal(large.status, 200, "a large project must analyze a bounded recent selection, not return 413");
    assert.equal(large.body.coverage.conversations, 100);
    assert.equal(large.body.coverage.totalConversations, 105);
    assert.equal(large.body.coverage.truncated, true);
    assert.equal(large.body.suggestions[0].associatedCostUsd, 1100);
    assert.equal(large.body.suggestions[0].evidence[0].conversationId, "analysis-104", "most recent conversations come first");

    const scope = { projectId, from: "2025-01-01", to: "2025-01-01", timeZone: "UTC", limit: 25 };
    const preview = await api<any>(node, session, "GET", `/usage/analysis/preview?${new URLSearchParams({ ...scope, limit: "25" })}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.conversations, 25);
    assert.equal(preview.body.totalConversations, 105);
    assert.equal(preview.body.truncated, true);
    const selected = await api<any>(node, session, "POST", "/usage/analysis", scope);
    assert.equal(selected.status, 200);
    assert.equal(selected.body.coverage.conversations, preview.body.conversations);
    assert.equal(selected.body.suggestions[0].associatedCostUsd, 25, "costs exclude older events on the selected conversations");
    assert.ok(selected.body.suggestions[0].evidence.every((row: any) => row.costUsd === 1 && row.durationMs === 1000 && row.conversationId >= "analysis-080"));
    const improvements = selected.body.suggestions.filter((item: any) => item.kind === "improvement");
    assert.equal(improvements.length, 1, "old skill versions outside the period are excluded");
    assert.equal(improvements[0].associatedCostUsd, 25, "skill evidence excludes unselected conversations");
    assert.ok(improvements[0].evidence.every((row: any) => row.costUsd === 1 && row.durationMs === 1000 && row.conversationId >= "analysis-080"));

    const empty = await api<any>(node, session, "POST", "/usage/analysis", { ...scope, from: "2025-02-01", to: "2025-02-01" });
    assert.equal(empty.status, 200);
    assert.equal(empty.body.coverage.conversations, 0);
    assert.deepEqual(empty.body.suggestions, []);
    const west = await api<any>(node, session, "POST", "/usage/analysis", { ...scope, from: "2024-12-31", to: "2024-12-31", timeZone: "America/New_York" });
    assert.equal(west.body.coverage.conversations, 25, "selection uses viewer calendar dates");

    for (const invalid of [{ limit: 101 }, { limit: 0 }, { from: "2025-02-30" }, { from: "2025-02-01", to: "2025-01-01" }, { timeZone: "Mars/Olympus" }, { classification: "global-filter" }]) {
      assert.equal((await api(node, session, "POST", "/usage/analysis", { ...scope, ...invalid })).status, 400, JSON.stringify(invalid));
    }
    assert.equal((await api(node, session, "POST", "/usage/analysis", { ...scope, projectId: "private-project" })).status, 404);
    assert.equal((await fetch(`${node.url}/api/usage/analysis/preview?projectId=${projectId}`)).status, 401);
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
