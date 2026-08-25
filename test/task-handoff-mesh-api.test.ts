import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

interface NodeProcess { baseUrl: string; child: ChildProcess; homeDir: string; output: () => string; }
interface Session { headers: Record<string, string>; }
async function startNode(root: string, name: string): Promise<NodeProcess> { const homeDir = path.join(root, `${name}-home`); await mkdir(homeDir, { recursive: true }); let output = ""; const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: path.resolve("."), env: { ...process.env, PORT: "0", HOME: homeDir, PI_WEB_DATA_DIR: path.join(root, `${name}-data`), MASTER_BOB_ADMIN_USERNAME: "admin", MASTER_BOB_INITIAL_PASSWORD: "initial-password" }, stdio: ["ignore", "pipe", "pipe"] }); child.stdout.on("data", (chunk) => { output += chunk; }); child.stderr.on("data", (chunk) => { output += chunk; }); for (let attempt = 0; attempt < 1200; attempt += 1) { if (child.exitCode !== null) throw new Error(`${name} exited during startup (${child.exitCode})\n${output}`); const match = output.match(/listening on http:\/\/0\.0\.0\.0:(\d+)/); if (match && (await fetch(`http://127.0.0.1:${match[1]}/api/health`)).ok) return { baseUrl: `http://127.0.0.1:${match[1]}`, child, homeDir, output: () => output }; await new Promise((resolve) => setTimeout(resolve, 50)); } child.kill("SIGTERM"); throw new Error(`${name} did not become healthy\n${output}`); }
async function stopNode(node: NodeProcess): Promise<void> { if (node.child.exitCode !== null) return; let stopped = false; node.child.once("exit", () => { stopped = true; }); node.child.kill("SIGKILL"); for (let attempt = 0; attempt < 20; attempt += 1) { if (stopped) return; await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error("Node process did not stop"); }
async function login(node: NodeProcess): Promise<Session> { const response = await fetch(`${node.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) }); const body = await response.json() as { csrfToken: string }; const cookie = response.headers.get("set-cookie")?.split(";", 1)[0]; if (!cookie) throw new Error(node.output()); const headers = { Cookie: cookie, "X-CSRF-Token": body.csrfToken, "Content-Type": "application/json" }; await fetch(`${node.baseUrl}/api/auth/change-password`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) }); return { headers }; }
async function waitForTask(node: NodeProcess, auth: Session, projectId: string, taskId: string, predicate: (task: any) => boolean): Promise<any> { for (let attempt = 0; attempt < 60; attempt += 1) { const body = await (await fetch(`${node.baseUrl}/api/projects/${projectId}/tasks`, { headers: auth.headers })).json() as { tasks: any[] }; const task = body.tasks.find((item) => item.id === taskId); if (task && predicate(task)) return task; await new Promise((resolve) => setTimeout(resolve, 150)); } throw new Error(node.output()); }

test("task handoff prepares then routes later updates to its new owner", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-task-handoff-")); const nodes: NodeProcess[] = [];
  try {
    const [a, b] = await Promise.all([startNode(root, "a"), startNode(root, "b")]); nodes.push(a, b); const [aAuth, bAuth] = await Promise.all([login(a), login(b)]);
    for (const [node, auth, name] of [[a, aAuth, "A"], [b, bAuth, "B"]] as const) assert.equal((await fetch(`${node.baseUrl}/api/cluster/node`, { method: "PUT", headers: auth.headers, body: JSON.stringify({ name, url: node.baseUrl }) })).status, 200);
    const bToken = (await (await fetch(`${b.baseUrl}/api/cluster/invite`, { headers: bAuth.headers })).json() as { token: string }).token;
    assert.equal((await fetch(`${a.baseUrl}/api/cluster/peers`, { method: "POST", headers: aAuth.headers, body: JSON.stringify({ url: b.baseUrl, token: bToken }) })).status, 201, a.output());
    await Promise.all([mkdir(path.join(root, "project"), { recursive: true }), mkdir(path.join(b.homeDir, "project"), { recursive: true })]);
    const projectResponse = await fetch(`${a.baseUrl}/api/projects`, { method: "POST", headers: aAuth.headers, body: JSON.stringify({ name: "shared", path: path.join(root, "project") }) }); const project = (await projectResponse.json() as { project: { id: string } }).project;
    const aId = (await (await fetch(`${a.baseUrl}/api/cluster/node`, { headers: aAuth.headers })).json() as { node: { id: string } }).node.id;
    await fetch(`${b.baseUrl}/api/cluster/projects/import`, { method: "POST", headers: bAuth.headers, body: JSON.stringify({ peerId: aId }) });
    assert.equal((await fetch(`${b.baseUrl}/api/cluster/projects/map`, { method: "POST", headers: bAuth.headers, body: JSON.stringify({ peerId: aId, projectId: project.id, localPath: path.join(b.homeDir, "project") }) })).status, 201, b.output());
    const taskId = "replicated-task"; const task = { id: taskId, title: "Before", description: "No Git", status: "backlog", engine: "pi", planMode: false, reviewMode: false, phaseConfig: {}, sessionPath: null, worktreePath: null, worktreeBranch: null, mergedAt: null, currentNodeId: aId, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", handoffContext: null, originNodeId: aId, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const aToken = (await (await fetch(`${a.baseUrl}/api/cluster/invite`, { headers: aAuth.headers })).json() as { token: string }).token;
    assert.equal((await fetch(`${a.baseUrl}/api/cluster/events`, { method: "POST", headers: { Authorization: `Bearer ${aToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ events: [{ id: randomUUID(), originNodeId: aId, entityType: "task", entityKey: `${project.id}:${taskId}`, operation: "upsert", payload: { projectId: project.id, task, originNodeId: aId }, createdAt: task.updatedAt }] }) })).status, 200);
    await waitForTask(a, aAuth, project.id, taskId, () => true); await waitForTask(b, bAuth, project.id, taskId, () => true);
    const unknown = await fetch(`${b.baseUrl}/api/cluster/tasks/eligibility`, { method: "POST", headers: { Authorization: `Bearer ${bToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: "unknown", task }) });
    assert.equal(unknown.status, 200); assert.match(((await unknown.json() as { reasons: string[] }).reasons).join(" "), /not mapped/);
    assert.equal((await waitForTask(a, aAuth, project.id, taskId, () => true)).currentNodeId, aId);
    const bId = (await (await fetch(`${b.baseUrl}/api/cluster/node`, { headers: bAuth.headers })).json() as { node: { id: string } }).node.id;
    const rejectedHandoffId = "11111111-1111-4111-8111-111111111111";
    assert.equal((await fetch(`${b.baseUrl}/api/cluster/tasks/abort`, { method: "POST", headers: { Authorization: `Bearer ${bToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ handoffId: rejectedHandoffId }) })).status, 200);
    const delayedPrepare = await fetch(`${b.baseUrl}/api/cluster/tasks/prepare`, { method: "POST", headers: { Authorization: `Bearer ${bToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: project.id, task, handoffId: rejectedHandoffId, handoffContext: "", handoffVersion: task.createdAt, bundle: null }) });
    assert.equal(delayedPrepare.status, 409, b.output());
    const fencedTask = await waitForTask(b, bAuth, project.id, taskId, () => true);
    assert.equal(fencedTask.title, task.title);
    assert.equal(fencedTask.currentNodeId, aId);
    assert.equal(fencedTask.executionState, "idle");
    assert.equal(fencedTask.worktreePath, null);
    assert.equal(fencedTask.handoffContext, null);
    const abortedHandoffId = randomUUID();
    const prepareBody = { projectId: project.id, task, handoffId: abortedHandoffId, handoffContext: "", handoffVersion: task.createdAt, bundle: null };
    const firstPrepared = await fetch(`${b.baseUrl}/api/cluster/tasks/prepare`, { method: "POST", headers: { Authorization: `Bearer ${bToken}`, "Content-Type": "application/json" }, body: JSON.stringify(prepareBody) });
    const secondPrepared = await fetch(`${b.baseUrl}/api/cluster/tasks/prepare`, { method: "POST", headers: { Authorization: `Bearer ${bToken}`, "Content-Type": "application/json" }, body: JSON.stringify(prepareBody) });
    assert.equal(firstPrepared.status, 201, b.output()); assert.equal(secondPrepared.status, 201, b.output());
    const firstPreparedTask = (await firstPrepared.json() as { task: any }).task; const secondPreparedTask = (await secondPrepared.json() as { task: any }).task;
    assert.equal(firstPreparedTask.id, secondPreparedTask.id); assert.equal(firstPreparedTask.executionState, secondPreparedTask.executionState);
    assert.equal((await fetch(`${b.baseUrl}/api/cluster/tasks/abort`, { method: "POST", headers: { Authorization: `Bearer ${bToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ handoffId: abortedHandoffId }) })).status, 200);
    const restored = await waitForTask(b, bAuth, project.id, taskId, (item) => item.executionState === "idle"); assert.equal(restored.currentNodeId, aId);
    const handed = await fetch(`${a.baseUrl}/api/projects/${project.id}/tasks/${taskId}/handoff`, { method: "POST", headers: aAuth.headers, body: JSON.stringify({ peerId: bId }) });
    assert.equal(handed.status, 200, a.output());
    const handedTask = (await handed.json() as { task: any }).task;
    assert.equal(handedTask.currentNodeId, bId);
    assert.ok(handedTask.updatedAt > task.updatedAt);
    await waitForTask(a, aAuth, project.id, taskId, (item) => item.currentNodeId === bId && item.executionState === "idle"); await waitForTask(b, bAuth, project.id, taskId, (item) => item.currentNodeId === bId && item.executionState === "idle");
    const patched = await fetch(`${a.baseUrl}/api/projects/${project.id}/tasks/${taskId}`, { method: "PATCH", headers: aAuth.headers, body: JSON.stringify({ title: "After" }) }); assert.equal(patched.status, 200, a.output()); assert.equal((await patched.json() as { task: any }).task.title, "After");
    await waitForTask(b, bAuth, project.id, taskId, (item) => item.title === "After"); await waitForTask(a, aAuth, project.id, taskId, (item) => item.title === "After");
    const returnEligibility = await fetch(`${a.baseUrl}/api/projects/${project.id}/tasks/${taskId}/eligibility`, { headers: aAuth.headers });
    assert.equal(returnEligibility.status, 200, a.output());
    const eligibleNodes = (await returnEligibility.json() as { nodes: Array<{ node: { id: string }; eligible: boolean }> }).nodes;
    assert.ok(eligibleNodes.some((entry) => entry.node.id === aId && entry.eligible));
    assert.equal(eligibleNodes.some((entry) => entry.node.id === bId), false);
    const returned = await fetch(`${a.baseUrl}/api/projects/${project.id}/tasks/${taskId}/handoff`, { method: "POST", headers: aAuth.headers, body: JSON.stringify({ peerId: aId }) });
    assert.equal(returned.status, 200, a.output());
    await waitForTask(a, aAuth, project.id, taskId, (item) => item.currentNodeId === aId && item.executionState === "idle");
    await waitForTask(b, bAuth, project.id, taskId, (item) => item.currentNodeId === aId && item.executionState === "idle");
  } finally { await Promise.all(nodes.map(stopNode)); await rm(root, { recursive: true, force: true }); }
});

test("pending outgoing handoff commits its prepared snapshot after source restart", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-task-handoff-restart-")); const nodes: NodeProcess[] = [];
  try {
    const [a, b] = await Promise.all([startNode(root, "a"), startNode(root, "b")]); nodes.push(a, b);
    const [aAuth, bAuth] = await Promise.all([login(a), login(b)]);
    for (const [node, auth, name] of [[a, aAuth, "A"], [b, bAuth, "B"]] as const) {
      assert.equal((await fetch(`${node.baseUrl}/api/cluster/node`, { method: "PUT", headers: auth.headers, body: JSON.stringify({ name, url: node.baseUrl }) })).status, 200);
    }
    const bToken = (await (await fetch(`${b.baseUrl}/api/cluster/invite`, { headers: bAuth.headers })).json() as { token: string }).token;
    assert.equal((await fetch(`${a.baseUrl}/api/cluster/peers`, { method: "POST", headers: aAuth.headers, body: JSON.stringify({ url: b.baseUrl, token: bToken }) })).status, 201, a.output());
    const [aId, bId] = await Promise.all([
      (async () => ((await (await fetch(`${a.baseUrl}/api/cluster/node`, { headers: aAuth.headers })).json() as { node: { id: string } }).node.id))(),
      (async () => ((await (await fetch(`${b.baseUrl}/api/cluster/node`, { headers: bAuth.headers })).json() as { node: { id: string } }).node.id))(),
    ]);
    await Promise.all([mkdir(path.join(root, "project"), { recursive: true }), mkdir(path.join(b.homeDir, "project"), { recursive: true })]);
    const project = (await (await fetch(`${a.baseUrl}/api/projects`, { method: "POST", headers: aAuth.headers, body: JSON.stringify({ name: "shared", path: path.join(root, "project") }) })).json() as { project: { id: string } }).project;
    assert.equal((await fetch(`${b.baseUrl}/api/cluster/projects/import`, { method: "POST", headers: bAuth.headers, body: JSON.stringify({ peerId: aId }) })).status, 200);
    assert.equal((await fetch(`${b.baseUrl}/api/cluster/projects/map`, { method: "POST", headers: bAuth.headers, body: JSON.stringify({ peerId: aId, projectId: project.id, localPath: path.join(b.homeDir, "project") }) })).status, 201, b.output());
    const taskId = "restart-prepared-task";
    const task = { id: taskId, title: "Prepared snapshot", description: "No Git", status: "backlog", engine: "pi", planMode: false, reviewMode: false, phaseConfig: {}, sessionPath: null, worktreePath: null, worktreeBranch: null, mergedAt: null, currentNodeId: aId, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", handoffContext: null, originNodeId: aId, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
    const aToken = (await (await fetch(`${a.baseUrl}/api/cluster/invite`, { headers: aAuth.headers })).json() as { token: string }).token;
    assert.equal((await fetch(`${a.baseUrl}/api/cluster/events`, { method: "POST", headers: { Authorization: `Bearer ${aToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ events: [{ id: randomUUID(), originNodeId: aId, entityType: "task", entityKey: `${project.id}:${taskId}`, operation: "upsert", payload: { projectId: project.id, task, originNodeId: aId }, createdAt: task.updatedAt }] }) })).status, 200);
    await Promise.all([waitForTask(a, aAuth, project.id, taskId, () => true), waitForTask(b, bAuth, project.id, taskId, () => true)]);
    const handoffId = randomUUID();
    assert.equal((await fetch(`${b.baseUrl}/api/cluster/tasks/prepare`, { method: "POST", headers: { Authorization: `Bearer ${bToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ projectId: project.id, task, handoffId, handoffContext: "", handoffVersion: task.createdAt, bundle: null }) })).status, 201, b.output());
    await stopNode(a);
    nodes.splice(nodes.indexOf(a), 1);
    const db = new DatabaseSync(path.join(root, "a-data", "node.db"));
    const now = new Date().toISOString();
    db.prepare("UPDATE tasks SET current_node_id = ?, lease_owner_node_id = NULL, lease_expires_at = NULL, execution_state = 'handoff_pending', active_handoff_id = ?, updated_at = ?, origin_node_id = ? WHERE project_id = ? AND id = ?").run(aId, handoffId, now, aId, project.id, taskId);
    db.prepare("INSERT INTO task_handoffs (handoff_id, project_id, protocol_project_id, task_id, source_node_id, destination_node_id, direction, status, task_json, handoff_context, worktree_path, worktree_branch, worktree_created, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'outgoing', 'pending', ?, NULL, NULL, NULL, 0, ?, ?)").run(handoffId, project.id, project.id, taskId, aId, bId, JSON.stringify(task), now, now);
    db.close();
    const restarted = await startNode(root, "a"); nodes.push(restarted);
    assert.equal((await fetch(`${restarted.baseUrl}/api/cluster/node`, { method: "PUT", headers: aAuth.headers, body: JSON.stringify({ name: "A", url: restarted.baseUrl }) })).status, 200);
    const [sourceTask, destinationTask] = await Promise.all([
      waitForTask(restarted, aAuth, project.id, taskId, (item) => item.currentNodeId === bId && item.executionState === "idle"),
      waitForTask(b, bAuth, project.id, taskId, (item) => item.currentNodeId === bId && item.executionState === "idle"),
    ]);
    assert.equal(destinationTask.title, "Prepared snapshot");
    assert.equal(sourceTask.title, "Prepared snapshot");
    const sourceDb = new DatabaseSync(path.join(root, "a-data", "node.db"));
    assert.equal((sourceDb.prepare("SELECT COUNT(*) AS count FROM task_handoffs WHERE handoff_id = ?").get(handoffId) as { count: number }).count, 1);
    sourceDb.close();
    const destinationDb = new DatabaseSync(path.join(root, "b-data", "node.db"));
    assert.equal((destinationDb.prepare("SELECT COUNT(*) AS count FROM task_handoffs WHERE handoff_id = ?").get(handoffId) as { count: number }).count, 1);
    destinationDb.close();

    const missingTask = { ...task, id: "restart-missing-task", title: "Missing remote", updatedAt: "2026-01-02T00:00:00.000Z" };
    assert.equal((await fetch(`${restarted.baseUrl}/api/cluster/events`, { method: "POST", headers: { Authorization: `Bearer ${aToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ events: [{ id: randomUUID(), originNodeId: aId, entityType: "task", entityKey: `${project.id}:${missingTask.id}`, operation: "upsert", payload: { projectId: project.id, task: missingTask, originNodeId: aId }, createdAt: missingTask.updatedAt }] }) })).status, 200);
    await waitForTask(restarted, aAuth, project.id, missingTask.id, () => true);
    await stopNode(restarted);
    nodes.splice(nodes.indexOf(restarted), 1);
    const missingHandoffId = randomUUID();
    const pendingDb = new DatabaseSync(path.join(root, "a-data", "node.db"));
    const missingNow = new Date().toISOString();
    pendingDb.prepare("UPDATE tasks SET current_node_id = ?, lease_owner_node_id = NULL, lease_expires_at = NULL, execution_state = 'handoff_pending', active_handoff_id = ?, updated_at = ?, origin_node_id = ? WHERE project_id = ? AND id = ?").run(aId, missingHandoffId, missingNow, aId, project.id, missingTask.id);
    pendingDb.prepare("INSERT INTO task_handoffs (handoff_id, project_id, protocol_project_id, task_id, source_node_id, destination_node_id, direction, status, task_json, handoff_context, worktree_path, worktree_branch, worktree_created, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'outgoing', 'pending', ?, NULL, NULL, NULL, 0, ?, ?)").run(missingHandoffId, project.id, project.id, missingTask.id, aId, bId, JSON.stringify(missingTask), missingNow, missingNow);
    pendingDb.close();
    const restartedAgain = await startNode(root, "a"); nodes.push(restartedAgain);
    await waitForTask(restartedAgain, aAuth, project.id, missingTask.id, (item) => item.currentNodeId === aId && item.executionState === "idle");
    await new Promise((resolve) => setTimeout(resolve, 250));
    const abortedDb = new DatabaseSync(path.join(root, "a-data", "node.db"));
    assert.equal((abortedDb.prepare("SELECT status FROM task_handoffs WHERE handoff_id = ?").get(missingHandoffId) as { status: string }).status, "aborted");
    abortedDb.close();
  } finally { await Promise.all(nodes.map(stopNode)); await rm(root, { recursive: true, force: true }); }
});

test("machine settlement preserves committed deleted handoff evidence until acknowledged", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mobile-web-task-settlement-api-")); const nodes: NodeProcess[] = [];
  try {
    const [a, b] = await Promise.all([startNode(root, "a"), startNode(root, "b")]); nodes.push(a, b);
    const [aAuth, bAuth] = await Promise.all([login(a), login(b)]);
    for (const [node, auth, name] of [[a, aAuth, "A"], [b, bAuth, "B"]] as const) assert.equal((await fetch(`${node.baseUrl}/api/cluster/node`, { method: "PUT", headers: auth.headers, body: JSON.stringify({ name, url: node.baseUrl }) })).status, 200);
    const bToken = (await (await fetch(`${b.baseUrl}/api/cluster/invite`, { headers: bAuth.headers })).json() as { token: string }).token;
    assert.equal((await fetch(`${a.baseUrl}/api/cluster/peers`, { method: "POST", headers: aAuth.headers, body: JSON.stringify({ url: b.baseUrl, token: bToken }) })).status, 201, a.output());
    const aId = (await (await fetch(`${a.baseUrl}/api/cluster/node`, { headers: aAuth.headers })).json() as { node: { id: string } }).node.id;
    const bId = (await (await fetch(`${b.baseUrl}/api/cluster/node`, { headers: bAuth.headers })).json() as { node: { id: string } }).node.id;
    await Promise.all([mkdir(path.join(root, "project"), { recursive: true }), mkdir(path.join(b.homeDir, "project"), { recursive: true })]);
    const project = (await (await fetch(`${a.baseUrl}/api/projects`, { method: "POST", headers: aAuth.headers, body: JSON.stringify({ name: "shared", path: path.join(root, "project") }) })).json() as { project: { id: string } }).project;
    assert.equal((await fetch(`${b.baseUrl}/api/cluster/projects/import`, { method: "POST", headers: bAuth.headers, body: JSON.stringify({ peerId: aId }) })).status, 200);
    assert.equal((await fetch(`${b.baseUrl}/api/cluster/projects/map`, { method: "POST", headers: bAuth.headers, body: JSON.stringify({ peerId: aId, projectId: project.id, localPath: path.join(b.homeDir, "project") }) })).status, 201, b.output());
    const handoffId = randomUUID();
    const task = { id: "settlement-task", title: "Settlement", description: "No Git", status: "backlog", engine: "pi", planMode: false, reviewMode: false, phaseConfig: {}, sessionPath: null, worktreePath: null, worktreeBranch: null, mergedAt: null, currentNodeId: aId, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", handoffContext: null, originNodeId: aId, createdAt: "2026-06-01T00:00:00.000Z", updatedAt: "2026-06-01T00:00:00.000Z" };
    const machineHeaders = { Authorization: `Bearer ${bToken}`, "Content-Type": "application/json" };
    assert.equal((await fetch(`${b.baseUrl}/api/cluster/tasks/prepare`, { method: "POST", headers: machineHeaders, body: JSON.stringify({ projectId: project.id, task, handoffId, handoffContext: "", handoffVersion: task.createdAt, bundle: null }) })).status, 201, b.output());
    assert.equal((await fetch(`${b.baseUrl}/api/cluster/tasks/commit`, { method: "POST", headers: machineHeaders, body: JSON.stringify({ handoffId }) })).status, 200, b.output());
    const onward = await fetch(`${b.baseUrl}/api/projects/${project.id}/tasks/${task.id}/handoff`, { method: "POST", headers: bAuth.headers, body: JSON.stringify({ peerId: aId }) });
    assert.equal(onward.status, 409, b.output());
    assert.equal((await onward.json() as { error: string }).error, "Wait for incoming task handoff settlement before handing off again");
    const destinationTask = await waitForTask(b, bAuth, project.id, task.id, (candidate) => candidate.currentNodeId === bId && candidate.executionState === "idle");
    assert.equal(destinationTask.currentNodeId, bId);
    assert.equal(destinationTask.executionState, "idle");
    assert.equal((await fetch(`${b.baseUrl}/api/projects/${project.id}/tasks/${task.id}`, { method: "DELETE", headers: bAuth.headers })).status, 204, b.output());
    assert.equal((await fetch(`${b.baseUrl}/api/projects/${project.id}`, { method: "DELETE", headers: bAuth.headers })).status, 409, b.output());
    assert.equal((await fetch(`${b.baseUrl}/api/cluster/tasks/settle`, { method: "POST", headers: machineHeaders, body: JSON.stringify({ handoffId }) })).status, 200, b.output());
    assert.equal((await fetch(`${b.baseUrl}/api/projects/${project.id}`, { method: "DELETE", headers: bAuth.headers })).status, 204, b.output());
    const deletedProjectDb = new DatabaseSync(path.join(root, "b-data", "node.db"));
    assert.equal(deletedProjectDb.prepare("SELECT 1 FROM projects WHERE id = ?").get(project.id), undefined);
    assert.equal(deletedProjectDb.prepare("SELECT 1 FROM tasks WHERE project_id = ? AND id = ?").get(project.id, task.id), undefined);
    assert.equal(deletedProjectDb.prepare("SELECT 1 FROM task_tombstones WHERE project_id = ? AND task_id = ?").get(project.id, task.id), undefined);
    const settlementReceipt = deletedProjectDb.prepare("SELECT direction, status, acknowledged_at FROM task_handoffs WHERE handoff_id = ?").get(handoffId) as { direction: string; status: string; acknowledged_at: string | null };
    assert.equal(settlementReceipt.direction, "incoming");
    assert.equal(settlementReceipt.status, "committed");
    assert.ok(settlementReceipt.acknowledged_at);
    deletedProjectDb.close();
    assert.equal((await fetch(`${b.baseUrl}/api/cluster/tasks/settle`, { method: "POST", headers: machineHeaders, body: JSON.stringify({ handoffId }) })).status, 200, b.output());
  } finally { await Promise.all(nodes.map(stopNode)); await rm(root, { recursive: true, force: true }); }
});
