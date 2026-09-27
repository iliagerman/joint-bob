import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import WebSocket from "ws";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

interface TaskView { id: string; title: string; currentNodeId: string; executionState: string; leaseOwnerNodeId: string | null; leaseExpiresAt: string | null }

/** Creates a ticket the way its owner does (creating one through the API needs Syncthing). */
function createTaskOn(environment: DevEnvironment, node: SeededNode, projectId: string, title: string, status = "backlog", phaseConfig: Record<string, unknown> = {}): { id: string } {
  const project = node.projects.find((candidate) => candidate.id === projectId)!;
  const script = `import { createTask } from "./src/tasks.ts"; process.stdout.write(JSON.stringify(await createTask(${JSON.stringify(project.id)}, ${JSON.stringify(project.path)}, ${JSON.stringify(title)}, "", ${JSON.stringify(status)}, "pi", false, false, ${JSON.stringify(phaseConfig)}))); process.exit(0);`;
  return JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env: { ...process.env, HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir }, encoding: "utf8" })) as { id: string };
}

function updateOwnerRow(node: SeededNode, sql: string, ...values: Array<string | null>): void {
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  try {
    db.exec("PRAGMA busy_timeout=5000");
    assert.equal(db.prepare(sql).run(...values).changes, 1);
  } finally { db.close(); }
}

async function waitForTask(node: SeededNode, auth: SignedIn, projectId: string, taskId: string, predicate: (task: TaskView) => boolean): Promise<TaskView> {
  let last: unknown;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const listed = await api<{ tasks: TaskView[] }>(node, auth, "GET", `/projects/${projectId}/tasks`);
    last = listed.body;
    const task = listed.body.tasks.find((item) => item.id === taskId);
    if (task && predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Node ${node.key} never reached the expected state for ${taskId}: ${JSON.stringify(last)}`);
}

async function waitForAbsentTask(node: SeededNode, auth: SignedIn, projectId: string, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const listed = await api<{ tasks: TaskView[] }>(node, auth, "GET", `/projects/${projectId}/tasks`);
    if (!listed.body.tasks.some((task) => task.id === taskId)) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Node ${node.key} still lists ${taskId}`);
}

function closeCode(socket: WebSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    socket.once("close", (code) => resolve(code));
    socket.once("error", reject);
  });
}

function socketMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once("message", (raw) => resolve(JSON.parse(raw.toString())));
    socket.once("error", reject);
  });
}

test("task mutations and task watch sockets route through the recorded owner", { timeout: 150_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-task-routing-"));
  const servers: ChildProcess[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const [a, b] = environment.nodes;
    for (const node of environment.nodes) servers.push(await startDevNode(environment, node));
    let outputA = "";
    servers[0].stdout?.on("data", (chunk) => { outputA += chunk; });
    servers[0].stderr?.on("data", (chunk) => { outputA += chunk; });
    await pairTwinNodes(environment);
    const [aAuth, bAuth] = await Promise.all([signIn(environment, a), signIn(environment, b)]);
    const project = a.projects[0];
    const request = (node: SeededNode, auth: SignedIn, method: string, endpoint: string, body?: unknown) => fetch(`${node.url}/api${endpoint}`, {
      method, headers: { Cookie: auth.cookie, "x-csrf-token": auth.csrfToken, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const routed = createTaskOn(environment, b, project.id, "Before");
    await waitForTask(a, aAuth, project.id, routed.id, (task) => task.currentNodeId === b.nodeId);
    const socketUrl = new URL(`/ws?projectId=${encodeURIComponent(project.id)}&sessionPath=watch&taskId=${routed.id}`, a.url);
    socketUrl.protocol = "ws:";
    const watch = new WebSocket(socketUrl, { origin: a.url, headers: { Cookie: aAuth.cookie } });
    assert.deepEqual(await socketMessage(watch), { type: "watchReady" });
    const watchClosed = closeCode(watch);
    watch.close();
    await watchClosed;
    const unauthenticated = new WebSocket(socketUrl, { origin: a.url });
    assert.equal(await closeCode(unauthenticated), 1008);

    const patched = await request(a, aAuth, "PATCH", `/projects/${project.id}/tasks/${routed.id}`, { title: "After" });
    assert.equal(patched.status, 200, await patched.text());
    await Promise.all([waitForTask(a, aAuth, project.id, routed.id, (task) => task.title === "After"), waitForTask(b, bAuth, project.id, routed.id, (task) => task.title === "After")]);
    assert.equal((await request(a, aAuth, "DELETE", `/projects/${project.id}/tasks/${routed.id}`)).status, 204);
    await Promise.all([waitForAbsentTask(a, aAuth, project.id, routed.id), waitForAbsentTask(b, bAuth, project.id, routed.id)]);

    // Only the owner knows its task is running; the non-owner's delete must ask it, not guess.
    const active = createTaskOn(environment, b, project.id, "Active");
    await waitForTask(a, aAuth, project.id, active.id, () => true);
    updateOwnerRow(b, "UPDATE tasks SET execution_state = 'running', lease_owner_node_id = ?, lease_expires_at = ? WHERE id = ?", b.nodeId, new Date(Date.now() + 60_000).toISOString(), active.id);
    const activeDeletion = await request(a, aAuth, "DELETE", `/projects/${project.id}/tasks/${active.id}`);
    assert.equal(activeDeletion.status, 409);
    assert.deepEqual(await activeDeletion.json(), { error: "Wait for task agent to finish before deleting" });
    await waitForTask(b, bAuth, project.id, active.id, (task) => task.executionState === "running");
    updateOwnerRow(b, "UPDATE tasks SET execution_state = 'idle', lease_owner_node_id = NULL, lease_expires_at = NULL, lease_token = NULL WHERE id = ?", active.id);
    assert.equal((await request(a, aAuth, "DELETE", `/projects/${project.id}/tasks/${active.id}`)).status, 204);
    await Promise.all([waitForAbsentTask(a, aAuth, project.id, active.id), waitForAbsentTask(b, bAuth, project.id, active.id)]);

    const invalidModel = createTaskOn(environment, a, project.id, "Invalid model setup", "backlog", { in_progress: { engine: "pi", provider: "task-test-missing-provider", modelId: "task-test-missing-model", effort: "default" } });
    const invalidModelStart = await request(a, aAuth, "PATCH", `/projects/${project.id}/tasks/${invalidModel.id}`, { status: "in_progress" });
    assert.equal(invalidModelStart.status, 200, await invalidModelStart.text());
    const failedSetup = await waitForTask(a, aAuth, project.id, invalidModel.id, (task) => task.executionState === "failed");
    assert.equal(failedSetup.leaseOwnerNodeId, null);
    assert.equal(failedSetup.leaseExpiresAt, null);
    const aDb = new DatabaseSync(path.join(a.dataDir, "node.db"));
    try {
      assert.equal((aDb.prepare("SELECT lease_token FROM tasks WHERE project_id = ? AND id = ?").get(project.id, invalidModel.id) as { lease_token: string | null }).lease_token, null);
    } finally { aDb.close(); }
    assert.match(outputA, /Task start failed Error: Model not found: task-test-missing-provider\/task-test-missing-model/);
    assert.doesNotMatch(outputA, /Pi task run failed/);
    assert.equal((await request(a, aAuth, "DELETE", `/projects/${project.id}/tasks/${invalidModel.id}`)).status, 204);
    await waitForAbsentTask(a, aAuth, project.id, invalidModel.id);

    const done = createTaskOn(environment, b, project.id, "No worktree", "done");
    updateOwnerRow(b, "UPDATE tasks SET worktree_path = NULL WHERE id = ?", done.id);
    await waitForTask(a, aAuth, project.id, done.id, () => true);
    const merge = await request(a, aAuth, "POST", `/projects/${project.id}/tasks/${done.id}/merge`);
    assert.equal(merge.status, 409);
    assert.match((await merge.json() as { error: string }).error, /no isolated worktree/i);

    const handoff = createTaskOn(environment, a, project.id, "Handoff");
    // Without Syncthing a ticket workspace never reports synchronized, so hand off a ticket that has none.
    updateOwnerRow(a, "UPDATE tasks SET worktree_path = NULL WHERE id = ?", handoff.id);
    await waitForTask(b, bAuth, project.id, handoff.id, (task) => task.currentNodeId === a.nodeId);
    const handedOff = await request(b, bAuth, "POST", `/projects/${project.id}/tasks/${handoff.id}/handoff`, { peerId: b.nodeId });
    assert.equal(handedOff.status, 200, await handedOff.text());
    await Promise.all([waitForTask(a, aAuth, project.id, handoff.id, (task) => task.currentNodeId === b.nodeId), waitForTask(b, bAuth, project.id, handoff.id, (task) => task.currentNodeId === b.nodeId)]);
  } finally {
    await Promise.all(servers.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
