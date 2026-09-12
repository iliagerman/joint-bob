import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { app } from "../src/server.js";
import { browserAgentEnvironment } from "../src/browser-agent.js";
import { getClusterNode } from "../src/cluster.js";
import { addProject } from "../src/store.js";
import { browserRuntime, closeBrowserRuntime } from "../src/server/browser.js";
import type { BrowserSessionView, BrowserStart } from "../src/browser-types.js";

async function fixture(t: TestContext) {
  const folder = path.join(os.homedir(), randomUUID());
  await mkdir(folder, { recursive: true });
  const project = await addProject("Profile routing", folder, { writeInstructions: false });
  const identity = { projectId: project.id, engine: "pi" as const, conversationId: randomUUID() };
  const node = await getClusterNode();
  const sessions: BrowserSessionView[] = [0, 1].map(() => ({ ...identity, id: randomUUID(), profileId: randomUUID(), appNodeId: node.id, nodeId: node.id,
    state: "running", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), tabs: [], activePageId: null,
    owner: "agent", fileChooser: false, fileChooserRequest: null, dialog: null, downloads: [] }));
  const runtime = browserRuntime();
  const profiles = [...sessions.map((s, i) => ({ id: s.profileId!, projectId: identity.projectId, label: `Account ${i}` })), { id: randomUUID(), projectId: identity.projectId, label: "Unattached account" }];
  t.mock.method(runtime, "profiles", async () => profiles);
  const executed: string[] = [], started: BrowserStart[] = [];
  t.mock.method(runtime, "list", async (actual: unknown) => { assert.deepEqual(actual, identity); return sessions; });
  t.mock.method(runtime, "get", async (id: string) => { const found = sessions.find(s => s.id === id); assert.ok(found); return found; });
  t.mock.method(runtime, "execute", async (id: string) => { executed.push(id); return { target: id }; });
  t.mock.method(runtime, "create", async (start: BrowserStart) => { started.push(start); return sessions[0]; });
  const download = path.join(folder, "download.txt");
  await writeFile(download, "work download");
  t.mock.method(runtime, "download", async (id: string) => { executed.push(id); return { path: download, name: "download.txt" }; });
  const environment = browserAgentEnvironment(identity.projectId, identity.engine, identity.conversationId);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); t.mock.restoreAll(); await closeBrowserRuntime(); });
  return { sessions, profiles, executed, started, identity, async request(body: unknown) {
    return fetch(`http://127.0.0.1:${address.port}/api/browser/agent`, { method: "POST", headers: {
      authorization: `Bearer ${environment.JOINT_BOB_BROWSER_TOKEN}`, "content-type": "application/json",
    }, body: JSON.stringify(body) });
  } };
}

test("agent account commands reject ambiguity and bind explicit profiles inside the conversation", async t => {
  const f = await fixture(t);
  const command = { action: "snapshot" };
  const ambiguous = await f.request({ operation: "command", command });
  assert.equal(ambiguous.status, 409);
  assert.match((await ambiguous.json()).error, /profile/i);
  assert.deepEqual(f.executed, []);
  const work = await f.request({ operation: "command", command, profileId: f.sessions[1].profileId });
  assert.equal(work.status, 200);
  assert.equal((await work.json()).result.target, f.sessions[1].id);
  assert.deepEqual(f.executed, [f.sessions[1].id]);
  const foreign = await f.request({ operation: "command", command, profileId: randomUUID(), conversationId: "another-conversation", id: f.sessions[0].id });
  assert.equal(foreign.status, 404);
  assert.deepEqual(f.executed, [f.sessions[1].id], "Unknown profile must not fall back to another account");
});

test("agent downloads require the selected account and preserve single-session compatibility", async t => {
  const f = await fixture(t);
  const downloadId = randomUUID();
  assert.equal((await f.request({ operation: "download", downloadId })).status, 409);
  const download = await f.request({ operation: "download", downloadId, profileId: f.sessions[1].profileId });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "work download");
  assert.deepEqual(f.executed, [f.sessions[1].id]);
  f.sessions.splice(0, 1);
  const single = await f.request({ operation: "command", command: { action: "snapshot" } });
  assert.equal(single.status, 200);
  assert.equal((await single.json()).result.target, f.sessions[0].id);
});

test("agent can explicitly cancel a failed profile restore without selecting another account", async t => {
  const f = await fixture(t);
  f.sessions[1].state = "interrupted";
  f.sessions[1].restoreOnRestart = true;
  const snapshot = await f.request({ operation: "command", profileId: f.sessions[1].profileId, command: { action: "snapshot" } });
  assert.equal(snapshot.status, 404, "Non-running profile must not fall back to another account");
  const close = await f.request({ operation: "command", profileId: f.sessions[1].profileId, command: { action: "close" } });
  assert.equal(close.status, 200);
  assert.deepEqual(f.executed, [f.sessions[1].id]);
});

test("agents discover and reopen only profiles attached to their conversation", async t => {
  const f = await fixture(t);
  const listed = await f.request({ operation: "profiles" });
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).profiles.map((p: { id: string }) => p.id), f.sessions.map(s => s.profileId));
  const unattached = await f.request({ operation: "start", profileId: f.profiles[2].id });
  assert.equal(unattached.status, 403);
  assert.match((await unattached.json()).error, /viewer|attached/i);
  assert.equal(f.started.length, 0);
  const attached = await f.request({ operation: "start", profileId: f.profiles[0].id });
  assert.equal(attached.status, 200);
  assert.equal(f.started[0].profileId, f.profiles[0].id);
});

test("agent start forwards a named profile and rejects contradictory profile input", async t => {
  const f = await fixture(t);
  const named = await f.request({ operation: "start", profileName: " Synthetic personal ", url: "http://127.0.0.1:1234", nodeId: f.sessions[0].nodeId });
  assert.equal(named.status, 200);
  assert.equal((f.started[0] as BrowserStart & { profileName?: string }).profileName, "Synthetic personal");
  assert.equal(f.started[0].conversationId, f.identity.conversationId);
  const both = await f.request({ operation: "start", profileName: "New", profileId: f.sessions[0].profileId });
  assert.equal(both.status, 400);
  assert.equal(f.started.length, 1);
});
