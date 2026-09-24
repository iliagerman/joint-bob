import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

interface QuickNote { id: string; title: string; status: string; error: string | null; sessionId: string | null }

async function until(description: string, check: () => Promise<boolean> | boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!await check()) {
    if (Date.now() > deadline) throw new Error(`${description} did not settle`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

async function engineLogLines(log: string): Promise<string[]> {
  try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function note(node: SeededNode, session: SignedIn, id: string): Promise<QuickNote> {
  const response = await api<{ note: QuickNote }>(node, session, "GET", `/quick-notes/${id}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.note;
}

test("quick note launches run on the selected node and never fall back", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-quick-cluster-"));
  const children: ChildProcess[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const [a, b] = environment.nodes;
    const log = path.join(root, "engine.log");
    for (const node of [a, b]) children.push(await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: log }));
    const sessionA = await signIn(environment, a);
    const projectA = projectNamed(a, "Internal Assistant");

    // The note lives on node A but names node B as its execution node.
    const created = await api<{ note: QuickNote }>(a, sessionA, "POST", "/quick-notes", {
      projectId: projectA.id,
      title: "Run on the peer",
      content: "Only the selected node may run this",
      harnessId: "pi",
      nodeId: b.nodeId,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const launch = await api<{ note: QuickNote; sessionId: string; nodeId: string; sessionPath: string }>(a, sessionA, "POST", `/quick-notes/${created.body.note.id}/start`);
    assert.equal(launch.status, 200, JSON.stringify(launch.body));
    assert.equal(launch.body.nodeId, b.nodeId, "the launch must report the selected node");
    assert.equal(launch.body.sessionPath, `draft:pi:${launch.body.sessionId}`);
    await until("peer launch completed", async () => (await note(a, sessionA, created.body.note.id)).status === "completed");
    assert.deepEqual(await engineLogLines(log), [`pi:${b.nodeId}`], "the turn ran on the peer, not on the note's home node");

    // The peer conversation is visible from the home node through the shared project.
    const sessions = await api<{ sessions: Array<{ id: string; executionNodeId?: string }> }>(a, sessionA, "GET", `/projects/${projectA.id}/sessions`);
    assert.ok(sessions.body.sessions.some((candidate) => candidate.id === launch.body.sessionId), "the peer conversation joins the shared project history");

    // An unknown selected node fails the note instead of running it locally.
    const stranded = await api<{ note: QuickNote }>(a, sessionA, "POST", "/quick-notes", {
      projectId: projectA.id,
      title: "Nowhere to run",
      content: "Body",
      harnessId: "pi",
      nodeId: randomUUID(),
    });
    assert.equal(stranded.status, 201);
    const refused = await api<{ error: string }>(a, sessionA, "POST", `/quick-notes/${stranded.body.note.id}/start`);
    assert.equal(refused.status, 502, JSON.stringify(refused.body));
    assert.match(refused.body.error!, /selected node/i);
    const failed = await note(a, sessionA, stranded.body.note.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.error!, /selected node/i);
    assert.deepEqual(await engineLogLines(log), [`pi:${b.nodeId}`], "a missing node must not degrade into a local launch");
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
