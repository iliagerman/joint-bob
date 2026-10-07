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
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
