// Two real twin nodes hand a ticket back and forth through the signed runtime
// protocol: fencing of delayed prepares, idempotent prepare, abort, restart
// recovery of a pending outgoing handoff, and settlement receipts.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

interface Fixture { root: string; environment: DevEnvironment; a: SeededNode; b: SeededNode; projectId: string; children: Map<SeededNode, ChildProcess> }

function runScript(environment: DevEnvironment, node: SeededNode, code: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, "--", ...args], {
      cwd: process.cwd(), env: { ...process.env, HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => status === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `child exited ${status}`)));
  });
}

/** Records a task on a stopped node exactly as a locally originated replication event,
    so the node replicates it to its twin once it runs. */
async function seedLocalTask(fixture: Fixture, node: SeededNode, task: Record<string, unknown>): Promise<void> {
  const event = { id: randomUUID(), originNodeId: node.nodeId, entityType: "task", entityKey: `${fixture.projectId}:${task.id}`, operation: "upsert", payload: { projectId: fixture.projectId, task, originNodeId: node.nodeId }, createdAt: task.updatedAt };
  const received = await runScript(fixture.environment, node, `
    const { receiveReplicationBatch } = await import('./src/replication.ts');
    console.log(JSON.stringify(await receiveReplicationBatch({ events: [JSON.parse(process.argv[1])] })));
  `, [JSON.stringify(event)]);
  assert.deepEqual(JSON.parse(received), [event.id]);
}

async function createFixture(prefix: string, tasks: Array<Record<string, unknown>>): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const environment = await seedDevEnvironment(root, 2);
  const [a, b] = environment.nodes;
  const fixture: Fixture = { root, environment, a, b, projectId: a.projects[0].id, children: new Map() };
  for (const task of tasks) await seedLocalTask(fixture, a, { ...task, currentNodeId: a.nodeId, originNodeId: a.nodeId });
  for (const node of [a, b]) fixture.children.set(node, await startDevNode(environment, node));
  await pairTwinNodes(environment);
  return fixture;
}

async function closeFixture(fixture: Fixture | undefined): Promise<void> {
  if (!fixture) return;
  await Promise.all([...fixture.children.values()].map(stopDevNode));
  await rm(fixture.root, { recursive: true, force: true });
}

async function browser(node: SeededNode, session: SignedIn, method: string, endpoint: string, body?: unknown): Promise<Response> {
  return fetch(`${node.url}/api${endpoint}`, {
    method, headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function runtime(fixture: Fixture, sender: SeededNode, recipient: SeededNode, suffix: string, body: unknown): Promise<Response> {
  return signedNodeRequest(fixture.environment, sender, recipient, "POST", `/api/cluster/v2/runtime/${suffix}`, body);
}

async function waitForTask(node: SeededNode, session: SignedIn, projectId: string, taskId: string, predicate: (task: any) => boolean): Promise<any> {
  let last: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const body = await (await browser(node, session, "GET", `/projects/${projectId}/tasks`)).json() as { tasks: any[] };
    const task = body.tasks.find((item) => item.id === taskId);
    last = task;
    if (task && predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Task ${taskId} on ${node.key} never matched: ${JSON.stringify(last)}`);
}

function baseTask(id: string, title: string, createdAt: string): Record<string, unknown> {
  return { id, title, description: "No Git", status: "backlog", engine: "pi", planMode: false, reviewMode: false, phaseConfig: {}, sessionPath: null, worktreePath: null, worktreeBranch: null, mergedAt: null, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", handoffContext: null, createdAt, updatedAt: createdAt };
}

function insertPendingOutgoingHandoff(dataDir: string, projectId: string, task: Record<string, unknown>, source: string, destination: string, handoffId: string): void {
  const db = new DatabaseSync(path.join(dataDir, "node.db"));
  const now = new Date().toISOString();
  db.prepare("UPDATE tasks SET current_node_id = ?, lease_owner_node_id = NULL, lease_expires_at = NULL, execution_state = 'handoff_pending', active_handoff_id = ?, updated_at = ?, origin_node_id = ? WHERE project_id = ? AND id = ?").run(source, handoffId, now, source, projectId, String(task.id));
  db.prepare("INSERT INTO task_handoffs (handoff_id, project_id, protocol_project_id, task_id, source_node_id, destination_node_id, direction, status, task_json, handoff_context, worktree_path, worktree_branch, worktree_created, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'outgoing', 'pending', ?, NULL, NULL, NULL, 0, ?, ?)").run(handoffId, projectId, projectId, String(task.id), source, destination, JSON.stringify(task), now, now);
  db.close();
}

test("task handoff prepares then routes later updates to its new owner", { timeout: 180_000 }, async () => {
  const taskId = "replicated-task";
  const seeded = { ...baseTask(taskId, "Before", "2026-01-01T00:00:00.000Z"), attachments: [{ id: "22222222-2222-4222-8222-222222222222", kind: "file", name: "brief.md", mimeType: "text/markdown", path: ".joint-bob-attachments/brief.md" }] };
  let fixture: Fixture | undefined;
  try {
    fixture = await createFixture("jb-task-handoff-", [seeded]);
    const { a, b, projectId } = fixture;
    const task = { ...seeded, currentNodeId: a.nodeId, originNodeId: a.nodeId };
    const [aAuth, bAuth] = await Promise.all([signIn(fixture.environment, a), signIn(fixture.environment, b)]);
    await waitForTask(a, aAuth, projectId, taskId, () => true);
    const replicatedTask = await waitForTask(b, bAuth, projectId, taskId, () => true);
    assert.deepEqual(replicatedTask.attachments, task.attachments, "ticket attachment metadata replicates to the peer");

    // A project this node does not share with the peer is refused before eligibility is even evaluated.
    const unknown = await runtime(fixture, a, b, "tasks/eligibility", { projectId: "unknown", task });
    assert.equal(unknown.status, 403);
    assert.equal((await waitForTask(a, aAuth, projectId, taskId, () => true)).currentNodeId, a.nodeId);

    const abortedHandoffId = randomUUID();
    const prepareBody = { projectId, task, handoffId: abortedHandoffId, handoffContext: "", handoffVersion: task.createdAt, bundle: null };
    const firstPrepared = await runtime(fixture, a, b, "tasks/prepare", prepareBody);
    const secondPrepared = await runtime(fixture, a, b, "tasks/prepare", prepareBody);
    assert.equal(firstPrepared.status, 201, await firstPrepared.clone().text());
    assert.equal(secondPrepared.status, 201, await secondPrepared.clone().text());
    const firstPreparedTask = (await firstPrepared.json() as { task: any }).task;
    const secondPreparedTask = (await secondPrepared.json() as { task: any }).task;
    assert.equal(firstPreparedTask.id, secondPreparedTask.id);
    assert.equal(firstPreparedTask.executionState, secondPreparedTask.executionState);
    assert.equal((await runtime(fixture, a, b, "tasks/abort", { handoffId: abortedHandoffId })).status, 200);
    const restored = await waitForTask(b, bAuth, projectId, taskId, (item) => item.executionState === "idle");
    assert.equal(restored.currentNodeId, a.nodeId);

    const handed = await browser(a, aAuth, "POST", `/projects/${projectId}/tasks/${taskId}/handoff`, { peerId: b.nodeId });
    assert.equal(handed.status, 200, await handed.clone().text());
    const handedTask = (await handed.json() as { task: any }).task;
    assert.equal(handedTask.currentNodeId, b.nodeId);
    assert.deepEqual(handedTask.attachments, task.attachments, "ticket attachments survive handoff");
    assert.ok(handedTask.updatedAt > task.updatedAt);
    await waitForTask(a, aAuth, projectId, taskId, (item) => item.currentNodeId === b.nodeId && item.executionState === "idle");
    await waitForTask(b, bAuth, projectId, taskId, (item) => item.currentNodeId === b.nodeId && item.executionState === "idle");

    const patched = await browser(a, aAuth, "PATCH", `/projects/${projectId}/tasks/${taskId}`, { title: "After" });
    assert.equal(patched.status, 200, await patched.clone().text());
    assert.equal((await patched.json() as { task: any }).task.title, "After");
    await waitForTask(b, bAuth, projectId, taskId, (item) => item.title === "After");
    await waitForTask(a, aAuth, projectId, taskId, (item) => item.title === "After");

    const returnEligibility = await browser(a, aAuth, "GET", `/projects/${projectId}/tasks/${taskId}/eligibility`);
    assert.equal(returnEligibility.status, 200);
    const eligibleNodes = (await returnEligibility.json() as { nodes: Array<{ node: { id: string }; eligible: boolean }> }).nodes;
    assert.ok(eligibleNodes.some((entry) => entry.node.id === a.nodeId && entry.eligible));
    assert.equal(eligibleNodes.some((entry) => entry.node.id === b.nodeId), false);
    const returned = await browser(a, aAuth, "POST", `/projects/${projectId}/tasks/${taskId}/handoff`, { peerId: a.nodeId });
    assert.equal(returned.status, 200, await returned.clone().text());
    await waitForTask(a, aAuth, projectId, taskId, (item) => item.currentNodeId === a.nodeId && item.executionState === "idle");
    await waitForTask(b, bAuth, projectId, taskId, (item) => item.currentNodeId === a.nodeId && item.executionState === "idle");
  } finally { await closeFixture(fixture); }
});

test("pending outgoing handoff commits its prepared snapshot after source restart", { timeout: 180_000 }, async () => {
  const taskId = "restart-prepared-task";
  const seeded = baseTask(taskId, "Prepared snapshot", "2026-01-01T00:00:00.000Z");
  let fixture: Fixture | undefined;
  try {
    fixture = await createFixture("jb-task-handoff-restart-", [seeded]);
    const { a, b, projectId, environment } = fixture;
    const task = { ...seeded, currentNodeId: a.nodeId, originNodeId: a.nodeId };
    const [aAuth, bAuth] = await Promise.all([signIn(environment, a), signIn(environment, b)]);
    await Promise.all([waitForTask(a, aAuth, projectId, taskId, () => true), waitForTask(b, bAuth, projectId, taskId, () => true)]);
    const handoffId = randomUUID();
    const prepared = await runtime(fixture, a, b, "tasks/prepare", { projectId, task, handoffId, handoffContext: "", handoffVersion: task.createdAt, bundle: null });
    assert.equal(prepared.status, 201, await prepared.clone().text());

    await stopDevNode(fixture.children.get(a)!);
    insertPendingOutgoingHandoff(a.dataDir, projectId, task, a.nodeId, b.nodeId, handoffId);
    fixture.children.set(a, await startDevNode(environment, a));
    const restartedAuth = await signIn(environment, a);
    const [sourceTask, destinationTask] = await Promise.all([
      waitForTask(a, restartedAuth, projectId, taskId, (item) => item.currentNodeId === b.nodeId && item.executionState === "idle"),
      waitForTask(b, bAuth, projectId, taskId, (item) => item.currentNodeId === b.nodeId && item.executionState === "idle"),
    ]);
    assert.equal(destinationTask.title, "Prepared snapshot");
    assert.equal(sourceTask.title, "Prepared snapshot");
    const sourceDb = new DatabaseSync(path.join(a.dataDir, "node.db"));
    assert.equal((sourceDb.prepare("SELECT COUNT(*) AS count FROM task_handoffs WHERE handoff_id = ?").get(handoffId) as { count: number }).count, 1);
    sourceDb.close();
    const destinationDb = new DatabaseSync(path.join(b.dataDir, "node.db"));
    assert.equal((destinationDb.prepare("SELECT COUNT(*) AS count FROM task_handoffs WHERE handoff_id = ?").get(handoffId) as { count: number }).count, 1);
    destinationDb.close();

  } finally { await closeFixture(fixture); }
});

test("an abort that overtakes its prepare fences the late prepare", { timeout: 180_000 }, async () => {
  const taskId = "fenced-task";
  const seeded = baseTask(taskId, "Before", "2026-01-01T00:00:00.000Z");
  let fixture: Fixture | undefined;
  try {
    fixture = await createFixture("jb-task-handoff-fence-", [seeded]);
    const { a, b, projectId } = fixture;
    const task = { ...seeded, currentNodeId: a.nodeId, originNodeId: a.nodeId };
    const bAuth = await signIn(fixture.environment, b);
    await waitForTask(b, bAuth, projectId, taskId, () => true);
    const rejectedHandoffId = "11111111-1111-4111-8111-111111111111";
    const abort = await runtime(fixture, a, b, "tasks/abort", { handoffId: rejectedHandoffId });
    assert.equal(abort.status, 200, await abort.clone().text());
    const delayedPrepare = await runtime(fixture, a, b, "tasks/prepare", { projectId, task, handoffId: rejectedHandoffId, handoffContext: "", handoffVersion: task.createdAt, bundle: null });
    assert.equal(delayedPrepare.status, 409, await delayedPrepare.clone().text());
    const fencedTask = await waitForTask(b, bAuth, projectId, taskId, () => true);
    assert.equal(fencedTask.title, task.title);
    assert.equal(fencedTask.currentNodeId, a.nodeId);
    assert.equal(fencedTask.executionState, "idle");
    assert.equal(fencedTask.worktreePath, null);
    assert.equal(fencedTask.handoffContext, null);
  } finally { await closeFixture(fixture); }
});

test("a pending outgoing handoff the destination never prepared is aborted after source restart", { timeout: 180_000 }, async () => {
  const missingTask = baseTask("restart-missing-task", "Missing remote", "2026-01-01T00:00:00.000Z");
  let fixture: Fixture | undefined;
  try {
    fixture = await createFixture("jb-task-handoff-missing-", [missingTask]);
    const { a, b, projectId, environment } = fixture;
    const task = { ...missingTask, currentNodeId: a.nodeId, originNodeId: a.nodeId };
    const bAuth = await signIn(environment, b);
    await waitForTask(b, bAuth, projectId, String(task.id), () => true);
    await stopDevNode(fixture.children.get(a)!);
    const missingHandoffId = randomUUID();
    insertPendingOutgoingHandoff(a.dataDir, projectId, task, a.nodeId, b.nodeId, missingHandoffId);
    fixture.children.set(a, await startDevNode(environment, a));
    const aAuth = await signIn(environment, a);
    await waitForTask(a, aAuth, projectId, String(task.id), (item) => item.currentNodeId === a.nodeId && item.executionState === "idle");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const abortedDb = new DatabaseSync(path.join(a.dataDir, "node.db"));
    assert.equal((abortedDb.prepare("SELECT status FROM task_handoffs WHERE handoff_id = ?").get(missingHandoffId) as { status: string }).status, "aborted");
    abortedDb.close();
  } finally { await closeFixture(fixture); }
});

test("machine settlement preserves committed deleted handoff evidence until acknowledged", { timeout: 180_000 }, async () => {
  let fixture: Fixture | undefined;
  try {
    fixture = await createFixture("jb-task-settlement-", []);
    const { a, b, projectId, environment } = fixture;
    const bAuth = await signIn(environment, b);
    const handoffId = randomUUID();
    const task = { ...baseTask("settlement-task", "Settlement", "2026-06-01T00:00:00.000Z"), currentNodeId: a.nodeId, originNodeId: a.nodeId };
    const prepared = await runtime(fixture, a, b, "tasks/prepare", { projectId, task, handoffId, handoffContext: "", handoffVersion: task.createdAt, bundle: null });
    assert.equal(prepared.status, 201, await prepared.clone().text());
    const committed = await runtime(fixture, a, b, "tasks/commit", { handoffId });
    assert.equal(committed.status, 200, await committed.clone().text());
    const onward = await browser(b, bAuth, "POST", `/projects/${projectId}/tasks/${task.id}/handoff`, { peerId: a.nodeId });
    assert.equal(onward.status, 409);
    assert.equal((await onward.json() as { error: string }).error, "Wait for incoming task handoff settlement before handing off again");
    const destinationTask = await waitForTask(b, bAuth, projectId, task.id, (candidate) => candidate.currentNodeId === b.nodeId && candidate.executionState === "idle");
    assert.equal(destinationTask.currentNodeId, b.nodeId);
    assert.equal(destinationTask.executionState, "idle");
    assert.equal((await browser(b, bAuth, "DELETE", `/projects/${projectId}/tasks/${task.id}`)).status, 204);
    assert.equal((await browser(b, bAuth, "DELETE", `/projects/${projectId}`)).status, 409);
    const settled = await runtime(fixture, a, b, "tasks/settle", { handoffId });
    assert.equal(settled.status, 200, await settled.clone().text());
    assert.equal((await browser(b, bAuth, "DELETE", `/projects/${projectId}`)).status, 204);
    const deletedProjectDb = new DatabaseSync(path.join(b.dataDir, "node.db"));
    assert.equal(deletedProjectDb.prepare("SELECT 1 FROM projects WHERE id = ?").get(projectId), undefined);
    assert.equal(deletedProjectDb.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND id = ?").get(projectId, task.id), undefined);
    assert.equal(deletedProjectDb.prepare("SELECT 1 FROM task_tombstones WHERE project_id = ? AND task_id = ?").get(projectId, task.id), undefined);
    const settlementReceipt = deletedProjectDb.prepare("SELECT direction, status, acknowledged_at FROM task_handoffs WHERE handoff_id = ?").get(handoffId) as { direction: string; status: string; acknowledged_at: string | null };
    assert.equal(settlementReceipt.direction, "incoming");
    assert.equal(settlementReceipt.status, "committed");
    assert.ok(settlementReceipt.acknowledged_at);
    deletedProjectDb.close();
    const resettled = await runtime(fixture, a, b, "tasks/settle", { handoffId });
    assert.equal(resettled.status, 200, await resettled.clone().text());
  } finally { await closeFixture(fixture); }
});
