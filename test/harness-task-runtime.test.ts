import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

const fixture = `#!/usr/bin/env node
const fs=require("node:fs");
const path=require("node:path");
const readline=require("node:readline");
if(process.argv.includes("whoami")&&fs.existsSync(path.join(path.dirname(process.argv[1]),"fail-preflight")))process.exit(1);
if(process.argv.includes("--version")||process.argv.includes("whoami"))process.exit(0);
const send=v=>process.stdout.write(JSON.stringify(v)+"\\n");
const rl=readline.createInterface({input:process.stdin});
rl.on("line",line=>{const r=JSON.parse(line);if(r.method==="initialize")return send({jsonrpc:"2.0",id:r.id,result:{protocolVersion:1,agentCapabilities:{loadSession:true}}});if(r.method==="session/new")return send({jsonrpc:"2.0",id:r.id,result:{sessionId:"native-fixed"}});if(r.method==="session/load")return send({jsonrpc:"2.0",id:r.id,result:null});if(r.method==="session/prompt"){const text=r.params.prompt[0].text;if(text.includes("FAIL TASK"))return send({jsonrpc:"2.0",id:r.id,error:{code:-32000,message:"fixture failure"}});send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"native-fixed",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"completed"}}}});return send({jsonrpc:"2.0",id:r.id,result:{stopReason:"end_turn"}})}});
`;

function configure(dataDir: string, executable: string, configPath: string, sessionPath: string): void {
  const db = new DatabaseSync(path.join(dataDir, "node.db"));
  const save = db.prepare("INSERT INTO node_settings (key,value,is_secret,updated_at) VALUES (?,?,0,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  for (const [key, value] of [["kiro.executable", executable], ["kiro.configPath", configPath], ["kiro.sessionPath", sessionPath]]) save.run(key, value, new Date().toISOString());
  db.close();
}

async function waitForTask(node: Parameters<typeof api>[0], auth: Parameters<typeof api>[1], projectId: string, id: string, predicate: (task: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await api<{ tasks: Array<Record<string, unknown>> }>(node, auth, "GET", `/projects/${projectId}/tasks`);
    const task = response.body.tasks.find((candidate) => candidate.id === id)!;
    if (predicate(task)) return task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Task outcome timed out");
}

test("Kiro task completion and failure follow the harness prompt outcome", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-task-"));
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const executable = path.join(environment.home, "bin", "kiro-fixture");
    const configPath = path.join(environment.home, ".kiro");
    const sessionPath = path.join(configPath, "sessions");
    await Promise.all([mkdir(path.dirname(executable), { recursive: true }), mkdir(sessionPath, { recursive: true })]);
    await writeFile(executable, fixture); await chmod(executable, 0o700); configure(node.dataDir, executable, configPath, sessionPath);
    const project = projectNamed(node, "Joint Bob");
    const now = new Date().toISOString();
    const tasks = ["success", "failure", "preflight", "automatic-review"].map((id) => ({ id, title: id === "failure" ? "FAIL TASK" : `Kiro ${id}`, description: id, status: "backlog", engine: "kiro", planMode: false, reviewMode: id === "automatic-review", phaseConfig: {}, sessionPath: null, worktreePath: project.path, worktreeBranch: null, mergedAt: null, currentNodeId: node.nodeId, leaseOwnerNodeId: null, leaseExpiresAt: null, executionState: "idle", handoffContext: null, originNodeId: node.nodeId, createdAt: now, updatedAt: now }));
    await mkdir(path.join(node.dataDir, "tasks"), { recursive: true });
    await writeFile(path.join(node.dataDir, "tasks", `${project.id}.json`), JSON.stringify({ tasks }));
    server = await startDevNode(environment, node);
    const auth = await signIn(environment, node);
    const created = await api<{ task: Record<string, unknown> }>(node, auth, "PATCH", `/projects/${project.id}/tasks/success`, { status: "in_progress" });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const completed = await waitForTask(node, auth, project.id, "success", (task) => task.status === "review");
    assert.match(String(completed.sessionPath), /^kiro:/);
    const failedCreate = await api<{ task: Record<string, unknown> }>(node, auth, "PATCH", `/projects/${project.id}/tasks/failure`, { status: "in_progress" });
    assert.equal(failedCreate.status, 200, JSON.stringify(failedCreate.body));
    const failed = await waitForTask(node, auth, project.id, "failure", (task) => task.executionState === "failed");
    assert.equal(failed.status, "in_progress");

    const automaticReview = await api<{ task: Record<string, unknown> }>(node, auth, "PATCH", `/projects/${project.id}/tasks/automatic-review`, { status: "in_progress" });
    assert.equal(automaticReview.status, 200, JSON.stringify(automaticReview.body));
    await waitForTask(node, auth, project.id, "automatic-review", (task) => task.status === "done");

    const preflightFlag = path.join(path.dirname(executable), "fail-preflight");
    await writeFile(preflightFlag, "fail");
    const rejected = await api<{ task: Record<string, unknown> }>(node, auth, "PATCH", `/projects/${project.id}/tasks/preflight`, { status: "in_progress" });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
    const preflightFailed = await waitForTask(node, auth, project.id, "preflight", (task) => task.executionState === "failed");
    assert.equal(preflightFailed.runKind, null);
    await rm(preflightFlag);
    const reset = await api<{ task: Record<string, unknown> }>(node, auth, "PATCH", `/projects/${project.id}/tasks/preflight`, { status: "backlog" });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    const retry = await api<{ task: Record<string, unknown> }>(node, auth, "PATCH", `/projects/${project.id}/tasks/preflight`, { status: "in_progress" });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    await waitForTask(node, auth, project.id, "preflight", (task) => task.status === "review");
  } finally { if (server) await stopDevNode(server); await rm(root, { recursive: true, force: true }); }
});
