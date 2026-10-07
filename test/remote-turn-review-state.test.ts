// A twin that is not running a conversation learns it is running from the owner's
// lease, but it judges "needs review" against its own copy of the transcript, which a
// periodic pull refreshes only every 30 seconds. When a turn ended on the owner, the
// twin dropped the lease and showed the conversation as reviewed until the next pull,
// while the owner already showed it as needing review.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { openPiRuntimeDatabase, publishPiRuntime } from "../src/pi-runtime.js";

interface Row { id: string; path: string; updatedAt: string; reviewState: string; running: boolean }

async function eventually<T>(check: () => Promise<T>, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try { return await check(); } catch (error) { if (Date.now() > deadline) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function receipts(node: SeededNode, projectId: string): string[] {
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  try {
    return (db.prepare("SELECT session_id FROM cluster_v2_transcript_receipts WHERE project_id=?").all(projectId) as Array<{ session_id: string }>).map((row) => row.session_id);
  } catch { return []; } finally { db.close(); }
}

function message(role: "user" | "assistant", at: number, text: string): string {
  return `${JSON.stringify({ type: "message", id: randomUUID(), parentId: null, timestamp: new Date(at).toISOString(),
    message: { role, content: [{ type: "text", text }], timestamp: at } })}\n`;
}

test("a twin shows a remote turn's end as needing review, never as reviewed, and without waiting for the periodic pull", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "remote-turn-review-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const a = await seedDevEnvironment(path.join(root, "a"), 1), b = await seedDevEnvironment(path.join(root, "b"), 1);
    const owner = a.nodes[0], twin = b.nodes[0];
    children.push(await startDevNode(a, owner), await startDevNode(b, twin));
    const [ownerAuth, twinAuth] = await Promise.all([signIn(a, owner), signIn(b, twin)]);
    const invitation = await api<{ link: string; relationshipId: string }>(owner, ownerAuth, "POST", "/twins/invitations", { confirmOwnedData: true });
    assert.equal((await api(twin, twinAuth, "POST", "/twins/accept", { link: invitation.body.link, confirmOwnedData: true })).status, 201);
    assert.equal((await api(owner, ownerAuth, "POST", `/twins/${invitation.body.relationshipId}/sharing`, { ownerNodeId: owner.nodeId, confirmOwnedData: true })).status, 200);

    const directory = path.join(root, "project");
    await mkdir(directory);
    const created = await api<{ project: { id: string } }>(owner, ownerAuth, "POST", "/projects", { name: "Remote turns", type: "personal", path: directory, synced: false });
    assert.equal(created.status, 201);
    const projectId = created.body.project.id;

    const sessionId = randomUUID(), started = Date.now() - 60_000;
    const transcript = path.join(a.home, ".pi", "sessions", `${sessionId}.jsonl`);
    await mkdir(path.dirname(transcript), { recursive: true });
    await writeFile(transcript, `${JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date(started).toISOString(), cwd: directory })}\n`
      + message("user", started, "First question") + message("assistant", started + 100, "First answer"));
    execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { ensureConversationRecord } from "./src/conversation-records.ts";
      await ensureConversationRecord(${JSON.stringify(projectId)}, "pi", ${JSON.stringify(sessionId)}, ${JSON.stringify(owner.nodeId)});
    `], { cwd: process.cwd(), env: { ...process.env, HOME: a.home, JOINT_BOB_DATA_DIR: owner.dataDir }, stdio: "pipe" });

    const row = async (node: SeededNode, auth: SignedIn): Promise<Row> => {
      const listed = await api<{ sessions: Row[] }>(node, auth, "GET", `/projects/${projectId}/sessions`);
      assert.equal(listed.status, 200);
      const found = listed.body.sessions.find((session) => session.id === sessionId);
      assert.ok(found, `${node.key} lists the conversation`);
      return found;
    };
    // The twin has just pulled the transcript, so the next periodic pull is 30 seconds away.
    await eventually(async () => assert.ok(receipts(twin, projectId).includes(sessionId), "the twin received the transcript"));
    const pulledAt = Date.now();
    const first = await eventually(() => row(owner, ownerAuth));
    const reviewed = await fetch(`${owner.url}/api/projects/${projectId}/sessions/reviewed`, {
      method: "PUT",
      headers: { Cookie: ownerAuth.cookie, "x-csrf-token": ownerAuth.csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionPath: first.path, updatedAt: first.updatedAt }),
    });
    assert.equal(reviewed.status, 204);
    await eventually(async () => assert.equal((await row(twin, twinAuth)).reviewState, "reviewed"));

    // One turn on the owner: the prompt, the running lease, the answer, the end of the run.
    const runtimeDb = openPiRuntimeDatabase(owner.dataDir);
    const run = { sessionId, transcriptPath: transcript, runId: randomUUID() };
    try {
      const prompt = Date.now();
      await appendFile(transcript, message("user", prompt, "Second question"));
      publishPiRuntime(runtimeDb, run, true);
      await eventually(async () => assert.equal((await row(twin, twinAuth)).running, true), 15_000);
      await appendFile(transcript, message("assistant", prompt + 2_000, "Second answer"));
      const answerAt = new Date(prompt + 2_000).toISOString();
      publishPiRuntime(runtimeDb, run, false);
      // The owner learns the answer from its transcript watcher, which can trail the run's end under load.
      await eventually(async () => {
        const current = await row(owner, ownerAuth);
        assert.equal(current.running, false);
        assert.equal(current.reviewState, "needs_review");
      }, 10_000);
      assert.ok(Date.now() - pulledAt < 20_000, "the turn ended well before the twin's next periodic pull");

      const seen: string[] = [];
      const settled = await eventually(async () => {
        const current = await row(twin, twinAuth);
        seen.push(current.running ? "running" : current.reviewState);
        assert.equal(current.reviewState, "needs_review", `twin states so far: ${seen.join(", ")}`);
        return current;
      }, 8_000);
      assert.equal(settled.updatedAt, answerAt, "the twin judges the owner's latest activity");
      assert.ok(!seen.includes("reviewed"), `the twin never shows the finished turn as reviewed: ${seen.join(", ")}`);
    } finally {
      publishPiRuntime(runtimeDb, run, false);
      runtimeDb.close();
    }
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
