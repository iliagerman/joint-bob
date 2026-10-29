// A conversation that switched harnesses is several transcripts ("segments"); the session
// list shows it once, under its newest segment. Before this, a twin that already held an
// earlier segment took it for a different conversation with the same ID, refused it, and
// marked the whole project's transcript sharing as failed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

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

function piTranscript(sessionId: string, cwd: string): string {
  const at = new Date().toISOString();
  return [
    { type: "session", version: 3, id: sessionId, timestamp: at, cwd },
    { type: "message", id: `${sessionId}-0`, parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text: "Synthetic turn" }], timestamp: Date.parse(at) } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
}

test("a twin already holding an earlier segment of a conversation accepts it instead of failing the project", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "twin-segments-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const a = await seedDevEnvironment(path.join(root, "a"), 1), b = await seedDevEnvironment(path.join(root, "b"), 1);
    const left = a.nodes[0], right = b.nodes[0];
    children.push(await startDevNode(a, left), await startDevNode(b, right));
    const [sa, sb] = await Promise.all([signIn(a, left), signIn(b, right)]);
    const invitation = await api<{ link: string; relationshipId: string }>(left, sa, "POST", "/twins/invitations", { confirmOwnedData: true });
    assert.equal((await api(right, sb, "POST", "/twins/accept", { link: invitation.body.link, confirmOwnedData: true })).status, 201);
    assert.equal((await api(left, sa, "POST", `/twins/${invitation.body.relationshipId}/sharing`, { ownerNodeId: left.nodeId, confirmOwnedData: true })).status, 200);

    const directory = path.join(root, "project");
    await mkdir(directory);
    const created = await api<{ project: { id: string } }>(left, sa, "POST", "/projects", { name: "Segments", type: "personal", path: directory, synced: false });
    assert.equal(created.status, 201);
    const projectId = created.body.project.id;

    // One conversation in two segments; the second one is the face the session list shows.
    const first = randomUUID(), second = randomUUID(), firstContent = piTranscript(first, directory);
    await mkdir(path.join(a.home, ".pi", "sessions"), { recursive: true });
    await writeFile(path.join(a.home, ".pi", "sessions", `${first}.jsonl`), firstContent);
    await writeFile(path.join(a.home, ".pi", "sessions", `${second}.jsonl`), piTranscript(second, directory));
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { ensureConversationRecord } from "./src/conversation-records.ts";
      await ensureConversationRecord(${JSON.stringify(projectId)}, "pi", ${JSON.stringify(first)}, ${JSON.stringify(left.nodeId)}, undefined, { conversationId: ${JSON.stringify(first)}, segmentIndex: 0 });
      await ensureConversationRecord(${JSON.stringify(projectId)}, "pi", ${JSON.stringify(second)}, ${JSON.stringify(left.nodeId)}, undefined, { conversationId: ${JSON.stringify(first)}, segmentIndex: 1 });
    `], { cwd: process.cwd(), env: { ...process.env, HOME: a.home, JOINT_BOB_DATA_DIR: left.dataDir }, stdio: "pipe" });
    // The twin holds the same earlier segment, copied by an older synchronization, with no receipt.
    await mkdir(path.join(b.home, ".pi", "sessions"), { recursive: true });
    await writeFile(path.join(b.home, ".pi", "sessions", `${first}.jsonl`), firstContent);

    await eventually(async () => {
      const receipts = query<{ session_id: string }>(right, "SELECT session_id FROM cluster_v2_transcript_receipts WHERE project_id=?", projectId).map((row) => row.session_id);
      const errors = query<{ error: string }>(right, "SELECT error FROM cluster_v2_transcript_errors WHERE project_id=?", projectId);
      assert.deepEqual(errors, [], "the project's transcript sharing does not fail");
      assert.ok(receipts.includes(first) && receipts.includes(second), `both segments are received (${JSON.stringify(receipts)})`);
    });

    // A second file synchronizer (or an interrupted restore) can replace a received
    // transcript after its receipt was saved. An unchanged remote inventory must
    // still repair the stale local bytes, not trust the receipt forever.
    const remoteFile = path.join(b.home, ".pi", "sessions", `${second}.jsonl`);
    const fullTranscript = await readFile(remoteFile, "utf8");
    await writeFile(remoteFile, fullTranscript.slice(0, fullTranscript.indexOf("\n") + 1));
    await eventually(async () => {
      assert.equal(await readFile(remoteFile, "utf8"), fullTranscript, "receiver repairs stale transcript despite matching receipt");
    }, 75_000);
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});

function piTranscriptAt(sessionId: string, cwd: string, at: string, text: string): string {
  return [
    { type: "session", version: 3, id: sessionId, timestamp: at, cwd },
    { type: "message", id: `${sessionId}-0`, parentId: null, timestamp: at, message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(at) } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
}

test("one transcript the twin cannot take does not hold back the rest of the project", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "twin-blocked-transcript-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const a = await seedDevEnvironment(path.join(root, "a"), 1), b = await seedDevEnvironment(path.join(root, "b"), 1);
    const left = a.nodes[0], right = b.nodes[0];
    children.push(await startDevNode(a, left), await startDevNode(b, right));
    const [sa, sb] = await Promise.all([signIn(a, left), signIn(b, right)]);
    const invitation = await api<{ link: string; relationshipId: string }>(left, sa, "POST", "/twins/invitations", { confirmOwnedData: true });
    assert.equal((await api(right, sb, "POST", "/twins/accept", { link: invitation.body.link, confirmOwnedData: true })).status, 201);

    const directory = path.join(root, "project");
    await mkdir(directory);
    const created = await api<{ project: { id: string } }>(left, sa, "POST", "/projects", { name: "Blocked", type: "personal", path: directory, synced: false });
    assert.equal(created.status, 201);
    const projectId = created.body.project.id;

    // The newest conversation is listed first, so it is the one tried first.
    const blocked = randomUUID(), waiting = randomUUID();
    await mkdir(path.join(a.home, ".pi", "sessions"), { recursive: true });
    await writeFile(path.join(a.home, ".pi", "sessions", `${blocked}.jsonl`), piTranscriptAt(blocked, directory, "2026-10-07T09:00:00.000Z", "Newest turn"));
    await writeFile(path.join(a.home, ".pi", "sessions", `${waiting}.jsonl`), piTranscriptAt(waiting, directory, "2026-10-07T08:00:00.000Z", "Older turn"));
    // The twin holds its own different bytes for the newest one, which it must never overwrite unreviewed.
    await mkdir(path.join(b.home, ".pi", "sessions"), { recursive: true });
    await writeFile(path.join(b.home, ".pi", "sessions", `${blocked}.jsonl`), piTranscriptAt(blocked, directory, "2026-10-07T09:00:00.000Z", "Local edit"));
    assert.equal((await api(left, sa, "POST", `/twins/${invitation.body.relationshipId}/sharing`, { ownerNodeId: left.nodeId, confirmOwnedData: true })).status, 200);

    await eventually(async () => {
      const receipts = query<{ session_id: string }>(right, "SELECT session_id FROM cluster_v2_transcript_receipts WHERE project_id=?", projectId).map((row) => row.session_id);
      assert.ok(receipts.includes(waiting), `the other conversation is received (${JSON.stringify(receipts)})`);
      const errors = query<{ error: string }>(right, "SELECT error FROM cluster_v2_transcript_errors WHERE project_id=?", projectId);
      assert.deepEqual(errors.map((row) => row.error), ["Divergent transcript requires review"], "the blocked conversation is still reported");
    });
    assert.match(await readFile(path.join(b.home, ".pi", "sessions", `${blocked}.jsonl`), "utf8"), /Local edit/, "the divergent local copy is left alone");

    // The twin names the conversation and settles it on request: the owner's history is
    // installed and the twin's own version is saved to a file.
    const sharing = `/twins/${invitation.body.relationshipId}/sharing`;
    // Seeded demo conversations differ between the two nodes as well, so only this project's are compared.
    const conflicts = async (): Promise<Array<{ engine: string; sessionId: string }>> => ((await api<{ conflicts?: Array<{ projectId: string; engine: string; sessionId: string }> }>(right, sb, "GET", sharing)).body.conflicts ?? [])
      .filter((conflict) => conflict.projectId === projectId).map(({ engine, sessionId }) => ({ engine, sessionId }));
    assert.deepEqual(await conflicts(), [{ engine: "pi", sessionId: blocked }]);
    const settle = { projectId, engine: "pi", sessionId: blocked };
    const forkEndpoint = `/twins/${invitation.body.relationshipId}/transcript-conflicts/fork`;
    const forked = await api<{ session: { id: string; path: string; title: string } }>(right, sb, "POST", forkEndpoint, settle);
    assert.equal(forked.status, 201, JSON.stringify(forked.body));
    assert.notEqual(forked.body.session.id, blocked);
    assert.match(forked.body.session.title, /^\[Local fork\]/);
    assert.match(await readFile(forked.body.session.path, "utf8"), /Local edit/);
    assert.match(await readFile(path.join(b.home, ".pi", "sessions", `${blocked}.jsonl`), "utf8"), /Local edit/, "fork leaves the original bytes untouched");
    assert.deepEqual(await conflicts(), [{ engine: "pi", sessionId: blocked }], "fork does not silently settle the conflict");
    assert.equal((await api(right, sb, "POST", forkEndpoint, { ...settle, sessionId: waiting })).status, 409, "an ordinary remote conversation cannot use the conflict-only fork");
    assert.equal((await api(right, sb, "POST", `/twins/${invitation.body.relationshipId}/transcript-conflicts/accept`, settle)).status, 400, "replacing local history needs explicit confirmation");
    // A failed transfer must release its source fence, even when the history conflict
    // exists only on the destination. The user's explicit choice then transfers the owner copy.
    // These synthetic files predate any recorded conversation. Register them on
    // both nodes, as real chat creation/replication does before an ownership move.
    for (const [environment, node] of [[a, left], [b, right]] as const) execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { ensureConversationRecord } from "./src/conversation-records.ts";
      await ensureConversationRecord(${JSON.stringify(projectId)}, "pi", ${JSON.stringify(blocked)}, ${JSON.stringify(left.nodeId)});
    `], { cwd: process.cwd(), env: { ...process.env, HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir }, stdio: "pipe" });
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { takeConversationOwnership } from "./src/conversation-ownership.ts";
      await takeConversationOwnership("pi", ${JSON.stringify(blocked)}, ${JSON.stringify(left.nodeId)});
    `], { cwd: process.cwd(), env: { ...process.env, HOME: a.home, JOINT_BOB_DATA_DIR: left.dataDir }, stdio: "pipe" });
    await eventually(async () => {
      assert.equal(query<{ owner_node_id: string }>(right, "SELECT owner_node_id FROM conversation_ownership WHERE session_id=?", blocked)[0]?.owner_node_id, left.nodeId);
    });
    const transfer = { peerId: right.nodeId, sessionId: blocked, sessionPath: path.join(b.home, ".pi", "sessions", `${blocked}.jsonl`) };
    const endpoint = `/projects/${projectId}/sessions/take-ownership`;
    await eventually(async () => {
      const listing = await api<{ sessions: Array<{ id: string }> }>(right, sb, "GET", `/projects/${projectId}/sessions`);
      assert.ok(listing.body.sessions.some(session => session.id === blocked), "the destination lists the registered conversation before takeover");
    });
    const failed = await api<{ error: string }>(right, sb, "POST", endpoint, transfer);
    assert.notEqual(failed.status, 200);
    assert.match(failed.body.error, /Divergent transcript/);
    for (const node of [left, right]) {
      assert.deepEqual(query(node, "SELECT owner_node_id,status,transfer_to_node_id FROM conversation_ownership WHERE session_id=?", blocked).map(row => ({ ...row as object })), [{ owner_node_id: left.nodeId, status: "owned", transfer_to_node_id: null }], "failed transfer restores the original owner on both nodes");
    }
    assert.match(await readFile(transfer.sessionPath, "utf8"), /Local edit/, "failed transfer preserves destination history");
    const wrongOwner = await api(right, sb, "POST", endpoint, { ...transfer, historyOwnerNodeId: randomUUID() });
    assert.notEqual(wrongOwner.status, 200, "approval for a different owner cannot replace history");
    const settled = await api<{ saved: string; ownership: { ownerNodeId: string } }>(right, sb, "POST", endpoint, { ...transfer, historyOwnerNodeId: left.nodeId });
    assert.equal(settled.status, 200, JSON.stringify(settled.body));
    assert.equal(settled.body.ownership.ownerNodeId, right.nodeId, "the selected owner history moves with execution");
    assert.match(await readFile(path.join(b.home, ".pi", "sessions", `${blocked}.jsonl`), "utf8"), /Newest turn/, "the owner's history is installed");
    assert.match(await readFile(settled.body.saved, "utf8"), /Local edit/, "the twin's own version is saved first");
    await eventually(async () => {
      assert.deepEqual(query(right, "SELECT error FROM cluster_v2_transcript_errors WHERE project_id=?", projectId), [], "the project no longer reports the conversation");
      assert.deepEqual(await conflicts(), []);
    });
    // Cancellation is an exact-state operation. A delayed cancel must not undo a
    // later successful transfer, even when the old fence is still in flight.
    const fencedOwner = await signedNodeRequest(a, left, right, "POST", "/api/cluster/v2/runtime/sessions/queue-transfer", { projectId, engine: "pi", sessionId: blocked });
    assert.equal(fencedOwner.status, 200);
    const record = (await fencedOwner.json() as { events: Array<{ entityType: string; payload: Record<string, unknown> }> }).events.find(event => event.entityType === "conversation.ownership")!.payload;
    const cancel = { projectId, record: { engine: record.engine, sessionId: record.sessionId, ownerNodeId: record.ownerNodeId, epoch: record.epoch, status: record.status, transferToNodeId: record.transferToNodeId } };
    const cancelled = await signedNodeRequest(a, left, right, "POST", "/api/cluster/v2/runtime/sessions/queue-transfer/cancel", cancel);
    assert.equal(cancelled.status, 200);
    assert.equal((await cancelled.json() as { current: { status: string } }).current.status, "owned");
    const retried = await api(left, sa, "POST", `/projects/${projectId}/sessions/take-ownership`, { peerId: left.nodeId, sessionId: blocked, sessionPath: path.join(a.home, ".pi", "sessions", `${blocked}.jsonl`) });
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    const late = await signedNodeRequest(a, left, right, "POST", "/api/cluster/v2/runtime/sessions/queue-transfer/cancel", cancel);
    assert.equal(late.status, 200);
    assert.equal((await late.json() as { accepted: boolean }).accepted, false, "stale cancellation does not undo completed takeover");
    assert.equal(query<{ owner_node_id: string }>(right, "SELECT owner_node_id FROM conversation_ownership WHERE session_id=?", blocked)[0]?.owner_node_id, left.nodeId);
    const raceFence = await signedNodeRequest(b, right, left, "POST", "/api/cluster/v2/runtime/sessions/queue-transfer", { projectId, engine: "pi", sessionId: blocked });
    assert.equal(raceFence.status, 200);
    const snapshot = await raceFence.json() as { events: Array<{ entityType: string; payload: Record<string, unknown> }> };
    const { originNodeId: _origin, ...raceRecord } = snapshot.events.find(event => event.entityType === "conversation.ownership")!.payload;
    const outcomes = await Promise.all(["cancel", "complete"].map(async action => {
      const response = await signedNodeRequest(b, right, left, "POST", `/api/cluster/v2/runtime/sessions/queue-transfer/${action}`, { projectId, record: raceRecord });
      assert.equal(response.status, 200);
      return response.json() as Promise<{ accepted: boolean; current: { status: string; ownerNodeId: string } }>;
    }));
    assert.equal(outcomes.filter(outcome => outcome.accepted).length, 1, "source chooses exactly one of racing completion and cancellation");
    assert.deepEqual(outcomes[0].current, outcomes[1].current, "both outcomes report the same authoritative owner, never split brain");
    assert.equal(outcomes[0].current.status, "owned");
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
