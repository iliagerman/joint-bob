import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

interface NodeFixture { dataDir: string; port: number; url: string; id: string; token: string; projectId: string }

function runScript(dataDir: string, home: string, code: string, args: string[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code, ...args], {
      cwd: process.cwd(), env: { ...process.env, HOME: home, JOINT_BOB_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => status === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `child exited ${status}`)));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (!address || typeof address === "string") throw new Error("Could not allocate test port");
      socket.close(() => resolve(address.port));
    });
  });
}

async function initializeNode(dataDir: string, home: string, projectPath: string, sessionRoot: string, port: number): Promise<NodeFixture> {
  const url = `http://127.0.0.1:${port}`;
  const output = await runScript(dataDir, home, `
    const cluster = await import('./src/cluster.ts');
    const store = await import('./src/store.ts');
    const settings = await import('./src/settings.ts');
    const node = await cluster.updateClusterNode('node-' + process.argv[1], process.argv[2]);
    const project = await store.addProject('Lock project', process.argv[3]);
    settings.updateSettings({ pi: { executable: '', configPath: process.argv[4], sessionPath: process.argv[5] }, claude: { executable: '', configPath: process.argv[6], sessionPath: process.argv[7] }, syncthing: { endpoint: '' }, projects: { homePath: process.argv[8] } });
    console.log(JSON.stringify({ node, token: await cluster.getClusterMachineToken(), projectId: project.id }));
  `, [String(port), url, projectPath, path.join(home, ".pi"), sessionRoot, path.join(home, ".claude"), path.join(home, ".claude", "projects"), path.join(home, "JointBob")]);
  const parsed = JSON.parse(output) as { node: { id: string }; token: string; projectId: string };
  return { dataDir, port, url, id: parsed.node.id, token: parsed.token, projectId: parsed.projectId };
}

async function pairNode(local: NodeFixture, remote: NodeFixture, home: string, remoteName: string): Promise<void> {
  await runScript(local.dataDir, home, `
    const cluster = await import('./src/cluster.ts');
    const store = await import('./src/store.ts');
    const now = new Date().toISOString();
    await cluster.saveClusterPeer({ id: process.argv[1], name: process.argv[6], url: process.argv[2], token: process.argv[3], pairedAt: now, lastSeenAt: now, createdAt: now, updatedAt: now });
    await store.registerProjectAliases(process.argv[4], [process.argv[5]]);
  `, [remote.id, remote.url, remote.token, local.projectId, remote.projectId, remoteName]);
}

function startNode(node: NodeFixture, home: string): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(node.port), NODE_ENV: "test", HOME: home, JOINT_BOB_DATA_DIR: node.dataDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => reject(new Error("Server startup timed out")), 15_000);
    child.once("exit", (status) => reject(new Error(`Server exited during startup: ${status}`)));
    child.stdout!.on("data", (chunk) => {
      if (!String(chunk).includes("Joint Bob listening")) return;
      clearTimeout(timeout);
      resolve(child);
    });
  });
}

async function stopNode(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
}

// Resolves with the `ready` frame so the test can read the ownership the node published.
function openConversation(node: NodeFixture, sessionPath: string, sockets: WebSocket[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const url = new URL("/ws", node.url.replace(/^http/, "ws"));
    url.searchParams.set("projectId", node.projectId);
    url.searchParams.set("sessionPath", sessionPath);
    url.searchParams.set("nodeSession", "1");
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${node.token}` } });
    sockets.push(socket);
    const timeout = setTimeout(() => reject(new Error("WebSocket ready timed out")), 15_000);
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (event.type !== "ready") return;
      clearTimeout(timeout);
      resolve(event);
    });
    socket.once("error", reject);
    socket.once("close", (code, reason) => { clearTimeout(timeout); reject(new Error(`closed ${code}: ${reason}`)); });
  });
}

test("opening a never-prompted conversation claims it, and the second node is told who owns it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-lock-mesh-"));
  const home = path.join(root, "home");
  const projectPath = path.join(root, "project");
  const sessionRoot = path.join(home, ".pi", "sessions");
  const transcriptPath = path.join(sessionRoot, "lock-session.jsonl");
  const children: ChildProcess[] = [];
  const sockets: WebSocket[] = [];
  try {
    await Promise.all([mkdir(projectPath, { recursive: true }), mkdir(sessionRoot, { recursive: true })]);
    await writeFile(transcriptPath, `${JSON.stringify({ type: "session", version: 3, id: "lock-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath })}\n`);
    const [homeserver, mac] = await Promise.all([
      initializeNode(path.join(root, "homeserver-data"), home, projectPath, sessionRoot, await freePort()),
      initializeNode(path.join(root, "mac-data"), home, projectPath, sessionRoot, await freePort()),
    ]);
    await Promise.all([pairNode(homeserver, mac, home, "Mac"), pairNode(mac, homeserver, home, "Homeserver")]);
    children.push(await startNode(homeserver, home), await startNode(mac, home));

    // Nobody has ever prompted this conversation, so opening it is what creates its owner.
    const first = await openConversation(homeserver, transcriptPath, sockets);
    assert.equal(first.ownership, null, "The node that opens an unowned conversation owns it");

    const second = await openConversation(mac, transcriptPath, sockets);
    assert.deepEqual(second.ownership, { nodeId: homeserver.id, nodeName: "Homeserver", status: "owned" });

    // Reopening on the owner still reports no lock.
    const reopened = await openConversation(homeserver, transcriptPath, sockets);
    assert.equal(reopened.ownership, null);
  } finally {
    for (const socket of sockets) socket.terminate();
    await Promise.all(children.map(stopNode));
    await rm(root, { recursive: true, force: true });
  }
});
