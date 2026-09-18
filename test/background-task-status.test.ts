import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { api, projectNamed, signIn, type SeededNode } from "./dev-nodes.js";
import { backgroundClusterFixture, backgroundFixture, closeBackgroundClusterFixture, closeBackgroundFixture, startSyntheticTask } from "./background-tasks-fixture.js";

/**
 * A supervised command that outlives its turn must hold its conversation in the
 * background state everywhere: on the node that started it, on the conversation's
 * newest segment after a harness switch, and on every paired node.
 */

interface SessionRow {
  id: string;
  harnessId: string;
  conversationId?: string;
  running?: boolean;
  backgroundRunning?: boolean;
  reviewState?: string;
}

type Signed = Awaited<ReturnType<typeof signIn>>;

async function listSessions(node: SeededNode, session: Signed, projectId: string): Promise<SessionRow[]> {
  const response = await api<{ sessions: SessionRow[] }>(node, session, "GET", `/projects/${projectId}/sessions`);
  assert.equal(response.status, 200);
  return response.body.sessions;
}

async function waitForBackground(node: SeededNode, session: Signed, projectId: string, sessionId: string, label: string): Promise<SessionRow> {
  const deadline = Date.now() + 20_000;
  let seen: SessionRow | undefined;
  while (Date.now() < deadline) {
    seen = (await listSessions(node, session, projectId)).find((row) => row.id === sessionId);
    if (seen?.backgroundRunning) return seen;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${label} never reported background work: ${JSON.stringify(seen)}`);
}

function linkSegments(node: SeededNode, projectId: string, conversationId: string, segments: Array<{ engine: string; sessionId: string }>): void {
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  try {
    const insert = db.prepare(`INSERT OR REPLACE INTO conversation_records
      (project_id, engine, session_id, created_at, updated_at, origin_node_id, task_id, conversation_id, segment_index)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`);
    segments.forEach((segment, index) => {
      const stamp = `2026-01-01T00:00:0${index}.000Z`;
      insert.run(projectId, segment.engine, segment.sessionId, stamp, stamp, node.nodeId, conversationId, index);
    });
  } finally {
    db.close();
  }
}

test("a harness switch keeps the conversation's background task visible on its newest segment", { timeout: 60_000 }, async () => {
  const f = await backgroundFixture();
  try {
    const session = await signIn(f.environment, f.node);
    const project = projectNamed(f.node, "Internal Assistant");
    const sessions = await listSessions(f.node, session, project.id);
    const first = sessions.find((row) => row.harnessId === "pi");
    const second = sessions.find((row) => row.harnessId === "claude");
    assert.ok(first && second, "the seeded project must have a pi and a claude conversation");
    // The task carries the logical conversation id, which stays the first segment's
    // session id after the switch, while the list faces the newest segment.
    linkSegments(f.node, project.id, first.id, [
      { engine: "pi", sessionId: first.id },
      { engine: "claude", sessionId: second.id },
    ]);
    await startSyntheticTask(f, project.id, first.id, "00000000-0000-4000-8000-0000000004a1", true);

    const merged = await waitForBackground(f.node, session, project.id, second.id, "the switched conversation");
    assert.equal(merged.conversationId, first.id);
    assert.equal(merged.running, true);
    assert.equal(merged.reviewState, "running");
  } finally {
    await closeBackgroundFixture(f);
  }
});

test("a background task on one node keeps its conversation running on the paired node", { timeout: 90_000 }, async () => {
  const f = await backgroundClusterFixture();
  try {
    const [nodeA, nodeB] = f.nodes;
    const sessionA = await signIn(f.environment, nodeA);
    const sessionB = await signIn(f.environment, nodeB);
    const projectA = projectNamed(nodeA, "Internal Assistant");
    const projectB = projectNamed(nodeB, "Internal Assistant");
    const target = (await listSessions(nodeA, sessionA, projectA.id)).find((row) => row.harnessId === "pi");
    assert.ok(target, "the seeded project must have a pi conversation");
    linkSegments(nodeA, projectA.id, target.id, [{ engine: "pi", sessionId: target.id }]);
    await startSyntheticTask({ node: nodeA, root: f.root }, projectA.id, target.id, "00000000-0000-4000-8000-0000000004b2", true);

    await waitForBackground(nodeA, sessionA, projectA.id, target.id, "the node running the task");
    const peer = await waitForBackground(nodeB, sessionB, projectB.id, target.id, "the paired node");
    assert.equal(peer.running, true);
    assert.equal(peer.reviewState, "running");
  } finally {
    await closeBackgroundClusterFixture(f);
  }
});
