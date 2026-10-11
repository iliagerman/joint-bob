import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import type { SessionSummary } from "../src/types.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

let root: string, environment: DevEnvironment, node: SeededNode, server: ChildProcess, auth: SignedIn;
before(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "joint-bob-transfer-")));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);
  auth = await signIn(environment, node);
}, { timeout: 120_000 });
after(async () => {
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});
const file = (session: SessionSummary) => session.path.replace(/^(claude|pi):/, "");
const list = async (projectId: string) => (await api<{ sessions: SessionSummary[] }>(node, auth, "GET", `/projects/${projectId}/sessions`)).body.sessions;
const transfer = (source: SessionSummary, destinationProjectId: string, mode: "copy" | "move", projectId = node.projects[0].id) =>
  api<{ session: SessionSummary; projectId: string; error?: string }>(node, auth, "POST", `/projects/${projectId}/sessions/transfer`, { engine: source.harnessId, sessionId: source.id, destinationProjectId, mode });

for (const engine of ["pi", "claude"] as const) {
  test(`${engine} copy lands in the destination project and keeps the source`, async () => {
    const [from, to] = node.projects;
    const source = (await list(from.id)).find((session) => session.harnessId === engine && !session.readOnly)!;
    await api(node, auth, "PUT", `/projects/${from.id}/sessions/title`, { engine, sessionId: source.id, title: `Copy me ${engine}` });
    const result = await transfer(source, to.id, "copy");
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.session.title, `Copy me ${engine}`);
    assert.notEqual(result.body.session.id, source.id);
    assert.ok((await list(to.id)).some((session) => session.id === result.body.session.id));
    assert.ok((await list(from.id)).some((session) => session.id === source.id));
    assert.ok(file(result.body.session).length > 0 && await stat(file(result.body.session)));
  });

  test(`${engine} move removes the source and lists it only in the destination`, async () => {
    const [from, to] = node.projects;
    const source = (await list(from.id)).find((session) => session.harnessId === engine && !session.readOnly && !session.title.startsWith("Copy me"))!;
    const result = await transfer(source, to.id, "move");
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.ok(!(await list(from.id)).some((session) => session.id === source.id));
    assert.ok((await list(to.id)).some((session) => session.id === result.body.session.id));
    assert.equal(await stat(file(source)).catch(() => null), null, "source transcript is gone");
  });
}

test("transfer rejects the same project and unknown destinations", async () => {
  const source = (await list(node.projects[1].id))[0];
  assert.equal((await transfer(source, node.projects[1].id, "move", node.projects[1].id)).status, 400);
  assert.equal((await transfer(source, "missing-project", "copy", node.projects[1].id)).status, 404);
});
