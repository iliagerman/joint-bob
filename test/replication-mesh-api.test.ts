// Project metadata replication between two real twin nodes: a project created after
// pairing reaches the twin (and browser watch sockets route to it), and a rename on
// the owner converges on the twin.
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import WebSocket from "ws";
import { pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

let root: string;
let environment: DevEnvironment;
let source: SeededNode;
let destination: SeededNode;
let children: ChildProcess[] = [];
let sourceAuth: SignedIn;
let destinationAuth: SignedIn;

function headers(session: SignedIn): Record<string, string> {
  return { Cookie: session.cookie, "x-csrf-token": session.csrfToken, "Content-Type": "application/json" };
}

async function listProjects(node: SeededNode, auth: SignedIn): Promise<Array<{ id: string; name: string; path: string }>> {
  const response = await fetch(`${node.url}/api/projects`, { headers: headers(auth) });
  assert.equal(response.status, 200);
  return (await response.json() as { projects: Array<{ id: string; name: string; path: string }> }).projects;
}

async function waitForProject(node: SeededNode, auth: SignedIn, predicate: (projects: Array<{ id: string; name: string }>) => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate(await listProjects(node, auth))) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${what} on node ${node.key}: ${JSON.stringify(await listProjects(node, auth))}`);
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "jb-replication-mesh-"));
  environment = await seedDevEnvironment(root, 2);
  [source, destination] = environment.nodes;
  for (const node of environment.nodes) children.push(await startDevNode(environment, node));
  await pairTwinNodes(environment);
  [sourceAuth, destinationAuth] = await Promise.all([signIn(environment, source), signIn(environment, destination)]);
}, { timeout: 120_000 });

after(async () => {
  await Promise.all(children.map(stopDevNode));
  if (root) await rm(root, { recursive: true, force: true });
});

test("a project created after twin pairing reaches the twin and routes watch sockets to it", { timeout: 120_000 }, async () => {
  const created = await fetch(`${source.url}/api/projects`, { method: "POST", headers: headers(sourceAuth), body: JSON.stringify({ name: "demo", type: "personal" }) });
  assert.equal(created.status, 201, await created.clone().text());
  const projectId = (await created.json() as { project: { id: string } }).project.id;
  await waitForProject(destination, destinationAuth, (projects) => projects.some((project) => project.id === projectId), "New project never replicated");

  const sessionNodes = await fetch(`${source.url}/api/projects/${projectId}/session-nodes`, { headers: headers(sourceAuth) });
  assert.equal(sessionNodes.status, 200);
  assert.equal((await sessionNodes.json() as { nodes: Array<{ id: string; mapped: boolean }> }).nodes.find((node) => node.id === destination.nodeId)?.mapped, true);

  const socket = new WebSocket(`${source.url.replace(/^http/, "ws")}/ws?projectId=${projectId}&sessionPath=watch&nodeId=${destination.nodeId}`, {
    origin: source.url,
    headers: { Cookie: sourceAuth.cookie },
  });
  try {
    const routedMessage = await new Promise<unknown>((resolve, reject) => {
      socket.once("message", (raw) => resolve(JSON.parse(raw.toString())));
      socket.once("error", reject);
      socket.once("close", (code, reason) => reject(new Error(`Watch socket closed ${code}: ${reason}`)));
    });
    assert.deepEqual(routedMessage, { type: "watchReady" });
  } finally { socket.close(); }
});

test("project name override converges across paired process-isolated nodes", { timeout: 120_000 }, async () => {
  const project = source.projects[0];
  const renamed = await fetch(`${source.url}/api/projects/${project.id}`, { method: "PATCH", headers: headers(sourceAuth), body: JSON.stringify({ name: "Replicated name" }) });
  assert.equal(renamed.status, 200, await renamed.clone().text());
  await waitForProject(destination, destinationAuth, (projects) => projects.find((candidate) => candidate.id === project.id)?.name === "Replicated name", "Project name did not replicate");
});
