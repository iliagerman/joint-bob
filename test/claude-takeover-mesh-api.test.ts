import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { freePort, pairTwinNodes, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

const username = "admin";
const password = "claude-takeover-password";

function runScript(dataDir: string, home: string, code: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, "--", ...args], {
      cwd: process.cwd(), env: { ...process.env, HOME: home, JOINT_BOB_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => status === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `child exited ${status}`)));
  });
}

// Both nodes share one HOME, which is what Syncthing's wholesale replication of
// ~/.claude looks like from the transcript's point of view. What differs is the
// project checkout path, and that is exactly what the defect turns on. Node A owns
// the project; node B records the same project ID at its own checkout, as a twin
// that mirrors node A's projects would.
async function initializeNode(root: string, key: string, home: string, projectPath: string, mirror?: SeededNode["projects"][number]): Promise<SeededNode> {
  const port = await freePort();
  const node = { key, name: `node-${key}`, port, url: `http://127.0.0.1:${port}`, dataDir: path.join(root, `node-${key}-data`), cookieName: `mb_session_takeover_${key}` };
  const output = await runScript(node.dataDir, home, `
    const job = JSON.parse(process.argv[1]);
    const { updateSettings } = await import('./src/settings.ts');
    const { createAdministrator } = await import('./src/auth.ts');
    const { addProject, importProject } = await import('./src/store.ts');
    const { updateClusterNode } = await import('./src/cluster.ts');
    updateSettings({ pi: { executable: '', configPath: job.home + '/.pi', sessionPath: job.home + '/.pi/sessions' }, claude: { executable: '', configPath: job.home + '/.claude', sessionPath: job.home + '/.claude/projects' }, syncthing: { endpoint: '' }, projects: { homePath: job.home + '/JointBob' } });
    createAdministrator(job.username, job.password, false);
    const cluster = await updateClusterNode(job.name, job.url);
    const project = job.mirror ? await importProject(job.mirror, job.projectPath) : await addProject('Takeover project', job.projectPath);
    console.log(JSON.stringify({ nodeId: cluster.id, project }));
  `, [JSON.stringify({ ...node, home, username, password, projectPath, mirror })]);
  const parsed = JSON.parse(output) as { nodeId: string; project: SeededNode["projects"][number] };
  return { ...node, nodeId: parsed.nodeId, projects: [parsed.project] };
}

async function listedClaudeSessionIds(node: SeededNode, home: string): Promise<string[]> {
  const output = await runScript(node.dataDir, home, `
    const store = await import('./src/store.ts');
    const claude = await import('./src/claude-service.ts');
    const project = await store.getProject(process.argv[1]);
    console.log(JSON.stringify((await claude.listClaudeSessions(project)).map((session) => session.id)));
  `, [node.projects[0].id]);
  return JSON.parse(output) as string[];
}

/** The takeover a user starts from the conversation on this node. */
async function takeOwnership(node: SeededNode, session: SignedIn, body: { sessionId: string; sessionPath: string }): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${node.url}/api/projects/${node.projects[0].id}/sessions/take-ownership`, {
    method: "POST",
    headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ peerId: node.nodeId, ...body }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function openConversation(environment: DevEnvironment, node: SeededNode, sessionPath: string): Promise<WebSocket> {
  const url = new URL("/ws", node.url.replace(/^http/, "ws"));
  url.searchParams.set("projectId", node.projects[0].id);
  url.searchParams.set("sessionPath", sessionPath);
  url.searchParams.set("nodeSession", "1");
  // A routed node session, signed by the node that serves it.
  const authorization = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import {DatabaseSync} from 'node:sqlite';
    import {signClusterRequest} from './src/cluster-protocol.ts';
    const db=new DatabaseSync(process.env.JOINT_BOB_DATA_DIR+'/node.db');
    process.stdout.write(signClusterRequest(db,${JSON.stringify(node.nodeId)},${JSON.stringify(node.nodeId)},'GET',${JSON.stringify(url.pathname + url.search)},Buffer.alloc(0)));db.close();
  `], { env: { ...process.env, HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir }, encoding: "utf8" });
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: authorization } });
    const timeout = setTimeout(() => reject(new Error("WebSocket ready timed out")), 10_000);
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as { type?: string };
      if (event.type !== "ready") return;
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("error", reject);
    socket.once("close", (code, reason) => reject(new Error(`WebSocket closed ${code}: ${reason.toString()}`)));
  });
}

function prompt(socket: WebSocket, message: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Prompt result timed out")), 15_000);
    const onMessage = (raw: WebSocket.RawData): void => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!["textDelta", "error"].includes(String(event.type))) return;
      clearTimeout(timeout);
      socket.off("message", onMessage);
      resolve(event);
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ type: "prompt", message }));
  });
}

function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/^\//, "-").replace(/[\s_.\/]+/g, "-");
}

test("a Claude conversation is claimed from a node whose checkout sits elsewhere and resumes its existing transcript", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-takeover-"));
  const home = path.join(root, "home");
  const projectA = path.join(root, "checkout-a", "project");
  const projectB = path.join(root, "workspace-b", "project");
  const projectsRoot = path.join(home, ".claude", "projects");
  const sourceDir = path.join(projectsRoot, claudeProjectDirName(projectA));
  const localDir = path.join(projectsRoot, claudeProjectDirName(projectB));
  const sessionId = "claude-takeover-session";
  const sourcePath = path.join(sourceDir, `${sessionId}.jsonl`);
  const localPath = path.join(localDir, `${sessionId}.jsonl`);
  const invocationLog = path.join(root, "invocations.log");
  const holdDir = path.join(root, "engine-holds");
  const engineEnv = { JOINT_BOB_TEST_ENGINE_LOG: invocationLog, JOINT_BOB_TEST_ENGINE_HOLD_DIR: holdDir };
  const children = new Map<SeededNode, ChildProcess>();
  const sockets: WebSocket[] = [];
  try {
    await Promise.all([
      mkdir(projectA, { recursive: true }), mkdir(projectB, { recursive: true }),
      mkdir(sourceDir, { recursive: true }), mkdir(holdDir, { recursive: true }),
      mkdir(path.join(home, ".pi", "sessions"), { recursive: true }),
    ]);
    // The stubbed engine waits for this file, so every turn below runs straight through.
    await writeFile(path.join(holdDir, "claude.release"), "release");
    const originalTranscript = `${JSON.stringify({ type: "user", sessionId, cwd: projectA, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "preserve me" } })}\n`;
    await writeFile(sourcePath, originalTranscript);

    const nodeA = await initializeNode(root, "a", home, projectA);
    const nodeB = await initializeNode(root, "b", home, projectB, nodeA.projects[0]);
    const environment: DevEnvironment = { root, home, username, password, nodes: [nodeA, nodeB] };
    for (const node of [nodeA, nodeB]) children.set(node, await startDevNode(environment, node, engineEnv));
    await pairTwinNodes(environment);
    const [sessionA, sessionB] = await Promise.all([signIn(environment, nodeA), signIn(environment, nodeB)]);

    // Node A owns the conversation first; the claim is applied on node B before it answers.
    const claimed = await takeOwnership(nodeA, sessionA, { sessionId, sessionPath: `claude:${sourcePath}` });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
    assert.equal((claimed.body.ownership as Record<string, unknown>).ownerNodeId, nodeA.nodeId);
    assert.deepEqual(claimed.body.pendingPeerIds, []);

    // FR1.1/FR1.2 — the takeover no longer refuses a `claude:` path and derives the engine from it.
    const takeover = await takeOwnership(nodeB, sessionB, { sessionId, sessionPath: `claude:${sourcePath}` });
    assert.equal(takeover.status, 200, JSON.stringify(takeover.body));
    const ownership = takeover.body.ownership as Record<string, unknown>;
    assert.equal(ownership.engine, "claude");
    assert.equal(ownership.ownerNodeId, nodeB.nodeId);
    assert.deepEqual(takeover.body.pendingPeerIds, []);

    // FR3.1/FR3.2 — node B lists the conversation and its turn resumes the existing transcript.
    assert.deepEqual(await listedClaudeSessionIds(nodeB, home), [sessionId]);
    const socket = await openConversation(environment, nodeB, `claude:${sourcePath}`);
    sockets.push(socket);
    assert.equal((await prompt(socket, "continue on node B")).type, "textDelta");

    const resumed = await readFile(localPath, "utf8");
    assert.match(resumed, /preserve me/);
    assert.equal(resumed.trim().split("\n").length, 3, resumed);

    // FR3.3/NFR3 — the transcript node A still holds on disk is untouched.
    assert.equal(await readFile(sourcePath, "utf8"), originalTranscript);

    // A3 from the requirements: the copy must not duplicate the conversation in the list.
    assert.deepEqual(await listedClaudeSessionIds(nodeB, home), [sessionId]);

    for (const open of sockets.splice(0)) open.terminate();

    // FR1.4 — a peer that is offline does not fail the takeover; it is reported as pending.
    await stopDevNode(children.get(nodeA)!);
    const offlineTakeover = await takeOwnership(nodeB, sessionB, { sessionId, sessionPath: `claude:${localPath}` });
    assert.equal(offlineTakeover.status, 200, JSON.stringify(offlineTakeover.body));
    assert.deepEqual(offlineTakeover.body.pendingPeerIds, [nodeA.nodeId]);
    const offlineOwnership = offlineTakeover.body.ownership as Record<string, unknown>;
    assert.equal(offlineOwnership.ownerNodeId, nodeB.nodeId);

    // FR1.4 — ownership survives a restart of the claiming node.
    await stopDevNode(children.get(nodeB)!);
    children.set(nodeB, await startDevNode(environment, nodeB, engineEnv));
    const persisted = await signedNodeRequest(environment, nodeA, nodeB, "GET", `/api/cluster/v2/runtime/sessions/ownership?engine=claude&sessionId=${encodeURIComponent(sessionId)}`);
    assert.equal(persisted.status, 200);
    assert.deepEqual((await persisted.json() as { ownership: unknown }).ownership, offlineOwnership);
  } finally {
    for (const socket of sockets) socket.close();
    await Promise.all([...children.values()].map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
