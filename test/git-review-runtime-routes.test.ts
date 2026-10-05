import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("Git review reads reach a paired node through signed runtime routes", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-review-runtime-"));
  const servers: ChildProcess[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    for (const node of environment.nodes) servers.push(await startDevNode(environment, node));
    await pairTwinNodes(environment);
    const [local, peer] = environment.nodes;
    const session = await signIn(environment, local);
    const projectId = local.projects[0].id;
    for (const route of ["reviews", "guide-latest", "story-latest"]) {
      const response = await api(local, session, "GET", `/projects/${projectId}/git/${route}?nodeId=${peer.nodeId}`);
      assert.equal(response.status, 200, `${route}: ${JSON.stringify(response.body)}`);
    }
  } finally {
    for (const server of servers) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
