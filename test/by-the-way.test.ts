import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import type { SessionSummary } from "../src/types.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

let root: string, environment: DevEnvironment, node: SeededNode, server: ChildProcess, auth: SignedIn;

before(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), "joint-bob-btw-")));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);
  auth = await signIn(environment, node);
}, { timeout: 120_000 });

after(async () => {
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

async function sessions(): Promise<SessionSummary[]> {
  return (await api<{ sessions: SessionSummary[] }>(node, auth, "GET", `/projects/${node.projects[0].id}/sessions`)).body.sessions;
}

test("bob-btw creates an unlisted fork and closing it deletes the temporary transcript", async () => {
  const before = await sessions();
  const source = before.find((session) => session.harnessId === "pi" && !session.readOnly)!;
  const sourceTranscript = await readFile(source.path, "utf8");

  const created = await api<{ session: SessionSummary; token: string }>(node, auth, "POST", `/projects/${node.projects[0].id}/sessions/by-the-way`, {
    engine: source.harnessId,
    sessionId: source.id,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.session.title, `[BTW] ${source.title}`);
  assert.notEqual(created.body.session.id, source.id);
  assert.ok(created.body.token);
  await access(created.body.session.path);
  assert.equal((await sessions()).some((session) => session.id === created.body.session.id), false, "temporary fork must stay out of the conversation list");
  const paneSessions = (await api<{ sessions: SessionSummary[] }>(node, auth, "GET", `/projects/${node.projects[0].id}/sessions?byTheWayToken=${created.body.token}`)).body.sessions;
  assert.ok(paneSessions.some((session) => session.id === created.body.session.id), "the leased dialog can load its hidden fork");

  const closed = await api<{ closed: boolean }>(node, auth, "POST", `/projects/${node.projects[0].id}/sessions/by-the-way/close`, {
    engine: created.body.session.harnessId,
    sessionId: created.body.session.id,
    token: created.body.token,
  });
  assert.deepEqual(closed, { status: 200, body: { closed: true } });
  await assert.rejects(access(created.body.session.path));
  assert.equal(await readFile(source.path, "utf8"), sourceTranscript, "closing BTW must not change the source transcript");
});

test("startup removes a temporary fork abandoned by a closed browser", async () => {
  const source = (await sessions()).find((session) => session.harnessId === "pi" && !session.readOnly)!;
  const created = await api<{ session: SessionSummary; token: string }>(node, auth, "POST", `/projects/${node.projects[0].id}/sessions/by-the-way`, {
    engine: source.harnessId,
    sessionId: source.id,
  });
  await access(created.body.session.path);
  await stopDevNode(server);
  server = await startDevNode(environment, node);
  auth = await signIn(environment, node);
  await assert.rejects(access(created.body.session.path));
  assert.equal((await sessions()).some((session) => session.id === created.body.session.id), false);
});
