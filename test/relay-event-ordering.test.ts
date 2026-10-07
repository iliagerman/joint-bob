// A relayed event whose project the receiver can only work out from an earlier event
// (a conversation's ownership needs its conversation record) must not block the rest.
// Before this, the receiver refused the whole batch, so a project shared with a
// cluster later never delivered its conversations to members that are not twins.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode } from "./dev-nodes.js";

async function eventually(check: () => Promise<void>, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try { await check(); return; } catch (error) { if (Date.now() > deadline) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function query<T>(node: SeededNode, sql: string, ...values: string[]): T[] {
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  try { return db.prepare(sql).all(...values) as unknown as T[]; } finally { db.close(); }
}

test("a conversation whose ownership was recorded before its record still reaches a cluster member", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relay-ordering-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const owner = await seedDevEnvironment(path.join(root, "owner"), 1), member = await seedDevEnvironment(path.join(root, "member"), 1);
    await rm(path.join(member.home, ".pi", "sessions"), { recursive: true, force: true });
    await rm(path.join(member.home, ".claude", "projects"), { recursive: true, force: true });
    const a = owner.nodes[0], c = member.nodes[0];
    const project = a.projects.find((candidate) => candidate.name === "Internal Assistant")!;
    const sessionId = randomUUID();
    // History as older nodes wrote it: the ownership event precedes the conversation record.
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { claimConversationOwnership } from "./src/conversation-ownership.ts";
      import { ensureConversationRecord } from "./src/conversation-records.ts";
      await claimConversationOwnership("pi", ${JSON.stringify(sessionId)}, ${JSON.stringify(a.nodeId)});
      await ensureConversationRecord(${JSON.stringify(project.id)}, "pi", ${JSON.stringify(sessionId)}, ${JSON.stringify(a.nodeId)});
    `], { cwd: process.cwd(), env: { ...process.env, HOME: owner.home, JOINT_BOB_DATA_DIR: a.dataDir }, stdio: "pipe" });
    const order = query<{ entity_type: string }>(a, "SELECT entity_type FROM replication_outbox WHERE entity_key LIKE ? ORDER BY rowid", `%${sessionId}%`).map((row) => row.entity_type);
    assert.deepEqual(order, ["conversation.ownership", "conversation.record"], "the fixture reproduces ownership before record");

    children.push(await startDevNode(owner, a), await startDevNode(member, c));
    const [sa, sc] = await Promise.all([signIn(owner, a), signIn(member, c)]);
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(a, sa, "POST", "/clusters", { name: "Ordering" });
    assert.equal(created.status, 201);
    const clusterId = created.body.snapshot.body.clusterId;
    const invitation = await api<{ link: string }>(a, sa, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal((await api(c, sc, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);
    assert.equal((await api(a, sa, "PUT", `/clusters/${clusterId}/sharing`, { projectIds: [project.id], workspaceIds: [], confirmOwnedData: true })).status, 200);

    await eventually(async () => {
      const record = query<{ project_id: string }>(c, "SELECT project_id FROM conversation_records WHERE session_id=?", sessionId);
      assert.deepEqual(record.map((row) => row.project_id), [project.id], "the member receives the conversation record");
      const ownership = query<{ owner_node_id: string }>(c, "SELECT owner_node_id FROM conversation_ownership WHERE session_id=?", sessionId);
      assert.deepEqual(ownership.map((row) => row.owner_node_id), [a.nodeId], "the member applies the ownership once it knows the conversation's project");
    });
    // The rest of the shared project's history can still be in flight; none of it may stay stuck.
    await eventually(async () => {
      const stuck = query<{ n: number }>(a, "SELECT count(*) n FROM cluster_v2_hub_queue WHERE cluster_id=? AND delivered_at IS NULL", clusterId)[0].n;
      assert.equal(stuck, 0, "no batch stays undelivered");
    });
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
