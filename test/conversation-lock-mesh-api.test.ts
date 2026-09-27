import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { pairTwinNodes, seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

/** A signed machine Authorization header, as a node's own runtime would send it. */
function signedAuthorization(environment: DevEnvironment, sender: SeededNode, recipient: SeededNode, target: string): string {
  return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import {DatabaseSync} from 'node:sqlite';
    import {signClusterRequest} from './src/cluster-protocol.ts';
    const db=new DatabaseSync(process.env.JOINT_BOB_DATA_DIR+'/node.db');
    process.stdout.write(signClusterRequest(db,${JSON.stringify(sender.nodeId)},${JSON.stringify(recipient.nodeId)},'GET',${JSON.stringify(target)},Buffer.alloc(0)));db.close();
  `], { env: { ...process.env, HOME: environment.home, JOINT_BOB_DATA_DIR: sender.dataDir }, encoding: "utf8" });
}

// Resolves with the `ready` frame so the test can read the ownership the node published.
// The socket is a routed node session, signed by the node that serves it.
function openConversation(environment: DevEnvironment, node: SeededNode, projectId: string, sessionPath: string, sockets: WebSocket[]): Promise<Record<string, unknown>> {
  const url = new URL("/ws", node.url.replace(/^http/, "ws"));
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("sessionPath", sessionPath);
  url.searchParams.set("nodeSession", "1");
  const authorization = signedAuthorization(environment, node, node, url.pathname + url.search);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: authorization } });
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

// Ownership claims replicate asynchronously, so a peer only reports the lock
// once the claim event reaches it.
async function waitForOwnershipOn(environment: DevEnvironment, asker: SeededNode, node: SeededNode, sessionId: string, ownerNodeId: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const response = await signedNodeRequest(environment, asker, node, "GET", `/api/cluster/v2/runtime/sessions/ownership?engine=pi&sessionId=${encodeURIComponent(sessionId)}`);
    const ownership = (await response.json() as { ownership: { ownerNodeId: string } | null }).ownership;
    if (ownership?.ownerNodeId === ownerNodeId) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${node.url} to see the owner ${ownerNodeId}`);
}

test("opening a never-prompted conversation claims it, and the second node is told who owns it", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-lock-mesh-"));
  const children: ChildProcess[] = [];
  const sockets: WebSocket[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const [homeserver, mac] = environment.nodes;
    const project = homeserver.projects[0];
    const transcriptPath = path.join(environment.home, ".pi", "sessions", "lock-session.jsonl");
    await writeFile(transcriptPath, `${JSON.stringify({ type: "session", version: 3, id: "lock-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: project.path })}\n`);
    for (const node of environment.nodes) children.push(await startDevNode(environment, node));
    await pairTwinNodes(environment);

    // Nobody has ever prompted this conversation, so opening it is what creates its owner.
    const first = await openConversation(environment, homeserver, project.id, transcriptPath, sockets);
    assert.equal(first.ownership, null, "The node that opens an unowned conversation owns it");

    await waitForOwnershipOn(environment, homeserver, mac, "lock-session", homeserver.nodeId);
    const second = await openConversation(environment, mac, project.id, transcriptPath, sockets);
    assert.deepEqual(second.ownership, { nodeId: homeserver.nodeId, nodeName: homeserver.name, status: "owned" });

    // Reopening on the owner still reports no lock.
    const reopened = await openConversation(environment, homeserver, project.id, transcriptPath, sockets);
    assert.equal(reopened.ownership, null);
  } finally {
    for (const socket of sockets) socket.terminate();
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
