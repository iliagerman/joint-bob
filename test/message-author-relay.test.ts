// A peer relaying a browser names the writer in the signed socket URL; a browser can't name
// anyone but itself.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { encodeAuthor } from "../src/message-authors.js";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "./dev-nodes.js";

const relayed = { accountId: "f".repeat(32), email: "dana@example.test", username: "dana", homeNodeId: "33333333-3333-4333-8333-333333333333" };

function frames(socket: WebSocket): Array<Record<string, unknown>> {
  const received: Array<Record<string, unknown>> = [];
  socket.on("message", (raw) => received.push(JSON.parse(String(raw)) as Record<string, unknown>));
  socket.on("close", (code, reason) => received.push({ type: "closed", code, reason: String(reason) }));
  return received;
}

async function until(received: Array<Record<string, unknown>>, predicate: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const found = received.find(predicate);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Timed out: ${JSON.stringify(received)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function signedUrl(environment: DevEnvironment, node: SeededNode, url: URL): string {
  return execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import {DatabaseSync} from 'node:sqlite';
    import {signClusterRequest} from './src/cluster-protocol.ts';
    import {getOrCreateClusterIdentity, pinClusterPublicKey} from './src/cluster-identity.ts';
    const db=new DatabaseSync(process.env.JOINT_BOB_DATA_DIR+'/node.db');
    pinClusterPublicKey(db,${JSON.stringify(node.nodeId)},getOrCreateClusterIdentity(db,${JSON.stringify(node.nodeId)}).publicKey);
    process.stdout.write(signClusterRequest(db,${JSON.stringify(node.nodeId)},${JSON.stringify(node.nodeId)},'GET',${JSON.stringify(url.pathname + url.search)},Buffer.alloc(0)));db.close();
  `], { env: { ...process.env, HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir }, encoding: "utf8" });
}

test("a signed relay names the writer, and a browser can't name anyone else", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "author-relay-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const holds = path.join(root, "holds");
  await mkdir(holds);
  const child = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log"), JOINT_BOB_TEST_ENGINE_HOLD_DIR: holds });
  const sockets: WebSocket[] = [];
  try {
    const projectId = node.projects[0].id;
    const relayUrl = new URL("/ws", node.url.replace(/^http/, "ws"));
    relayUrl.searchParams.set("projectId", projectId);
    relayUrl.searchParams.set("sessionPath", "new");
    relayUrl.searchParams.set("nodeSession", "1");
    relayUrl.searchParams.set("author", encodeAuthor(relayed));
    const relay = new WebSocket(relayUrl, { headers: { Authorization: signedUrl(environment, node, relayUrl) } });
    sockets.push(relay);
    const relayFrames = frames(relay);
    await until(relayFrames, (frame) => frame.type === "ready");
    relay.send(JSON.stringify({ type: "prompt", message: "relayed words" }));
    const relayedMessage = await until(relayFrames, (frame) => frame.type === "userMessage");
    assert.deepEqual(relayedMessage.author, relayed, "the signed URL names the writer");

    const session = await signIn(environment, node);
    const browserUrl = new URL("/ws", node.url.replace(/^http/, "ws"));
    browserUrl.searchParams.set("projectId", projectId);
    browserUrl.searchParams.set("sessionPath", "new");
    browserUrl.searchParams.set("author", encodeAuthor(relayed));
    const browser = new WebSocket(browserUrl, { origin: node.url, headers: { Cookie: session.cookie } });
    sockets.push(browser);
    const browserFrames = frames(browser);
    await until(browserFrames, (frame) => frame.type === "ready");
    browser.send(JSON.stringify({ type: "prompt", message: "my own words" }));
    const own = await until(browserFrames, (frame) => frame.type === "userMessage") as { author?: { email: string | null; username: string } };
    assert.equal(own.author?.username, environment.username, "a browser always writes as the person signed in");
    assert.notEqual(own.author?.email, relayed.email);
  } finally {
    for (const socket of sockets) socket.terminate();
    await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});
