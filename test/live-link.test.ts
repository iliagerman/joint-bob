// Your unshared projects on a node you signed in to travel live: that node relays your
// requests home and streams the answers back, and keeps nothing of them.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import WebSocket from "ws";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";

async function eventually(check: () => Promise<void>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await check(); return; } catch (error) { if (Date.now() > deadline) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function login(node: SeededNode, identifier: string, password: string): Promise<SignedIn> {
  const response = await fetch(`${node.url}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: identifier, password }) });
  assert.equal(response.status, 200);
  const body = await response.json() as { csrfToken: string };
  return { cookie: response.headers.get("set-cookie")!.split(";")[0], csrfToken: body.csrfToken };
}

async function filesContaining(root: string, needle: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(root, { recursive: true }).catch(() => [] as string[])) {
    const file = path.join(root, String(entry));
    try { if ((await stat(file)).isFile() && (await readFile(file)).includes(needle)) found.push(file); } catch { /* gone meanwhile */ }
  }
  return found;
}

function watchSocket(node: SeededNode, session: SignedIn, projectId: string): Promise<{ first: unknown; close: () => void }> {
  const url = new URL(`/ws?projectId=${encodeURIComponent(projectId)}&sessionPath=watch`, node.url);
  url.protocol = "ws:";
  const socket = new WebSocket(url, { headers: { Cookie: session.cookie, Origin: node.url } });
  return new Promise((resolve, reject) => {
    socket.once("message", (raw) => resolve({ first: JSON.parse(String(raw)), close: () => socket.terminate() }));
    socket.once("close", (code, reason) => reject(new Error(`closed ${code} ${reason}`)));
    socket.once("error", reject);
  });
}

/** Requests signed with `from`'s own node key, as its server would send them to `to`. */
function signedFrom(home: string, from: SeededNode, to: SeededNode, requests: Array<[string, string, unknown?]>): number[] {
  const script = `
    const { clusterV2Database } = await import("./src/cluster-v2-store.ts");
    const { getClusterNode } = await import("./src/cluster.ts");
    const { signClusterRequest } = await import("./src/cluster-protocol.ts");
    const db = await clusterV2Database(), local = await getClusterNode(), statuses = [];
    for (const [method, target, payload] of ${JSON.stringify(requests)}) {
      const body = payload === undefined || payload === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(payload));
      const response = await fetch(${JSON.stringify(to.url)} + target, { method, headers: { Authorization: signClusterRequest(db, local.id, ${JSON.stringify(to.nodeId)}, method, target, body), ...(body.length ? { "Content-Type": "application/json" } : {}) }, ...(body.length ? { body } : {}) });
      statuses.push(response.status);
      await response.arrayBuffer();
    }
    process.stdout.write("STATUSES" + JSON.stringify(statuses) + "\\n");
    process.exit(0);`;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), env: { ...process.env, HOME: home, JOINT_BOB_DATA_DIR: from.dataDir, NODE_ENV: "test" }, encoding: "utf8" });
  return JSON.parse(output.split("STATUSES")[1].trim()) as number[];
}

test("your unshared projects travel live to a node you signed in to, and nothing of them stays", { timeout: 360_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "live-link-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const envA = await seedDevEnvironment(path.join(root, "a"), 1, { username: "ana" });
    const envB = await seedDevEnvironment(path.join(root, "b"), 1, { username: "ben" });
    const [a, b] = [envA.nodes[0], envB.nodes[0]];
    children.push(await startDevNode(envA, a), await startDevNode(envB, b));
    const [sa, sb] = await Promise.all([signIn(envA, a), signIn(envB, b)]);
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(a, sa, "POST", "/clusters", { name: "Family" });
    const clusterId = created.body.snapshot.body.clusterId;
    const invitation = await api<{ link: string }>(a, sa, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal((await api(b, sb, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);

    // An unshared project at home with a file in it.
    const folder = path.join(envA.home, "JointBob", "private-notes");
    await mkdir(folder, { recursive: true });
    const secret = `only-at-home-${randomUUID()}`;
    await writeFile(path.join(folder, "notes.txt"), secret);
    const project = (await api<{ project: { id: string } }>(a, sa, "POST", "/projects", { name: "Private notes", path: folder, type: "personal" })).body.project;
    await eventually(async () => {
      const nodes = (await api<{ nodes: Array<{ nodeId: string; status: string }> }>(a, sa, "GET", "/account/nodes")).body.nodes;
      assert.equal(nodes.find((node) => node.nodeId === b.nodeId)?.status, "can sign in");
    });

    const anaOnB = await login(b, "ana", envA.password);
    await eventually(async () => assert.equal((await api<{ loaded: boolean }>(b, anaOnB, "GET", "/account/profile-status")).body.loaded, true));
    const listed = await api<{ projects: Array<{ id: string; live?: { homeNodeId: string } }>; liveHome: { online: boolean } }>(b, anaOnB, "GET", "/projects");
    assert.equal(listed.body.liveHome.online, true);
    assert.deepEqual(listed.body.projects.find((entry) => entry.id === project.id)?.live, { homeNodeId: a.nodeId }, "her unshared project is listed on B, live");
    assert.equal((await api<{ projects: Array<{ id: string }> }>(b, sb, "GET", "/projects")).body.projects.some((entry) => entry.id === project.id), false, "Ben sees nothing of it");

    const file = await fetch(`${b.url}/api/projects/${project.id}/file?path=notes.txt&download=1`, { headers: { Cookie: anaOnB.cookie } });
    assert.equal(file.status, 200);
    assert.equal(await file.text(), secret, "its file streams from home");
    const benFile = await fetch(`${b.url}/api/projects/${project.id}/file?path=notes.txt&download=1`, { headers: { Cookie: sb.cookie } });
    assert.equal(benFile.status, 404, "Ben's requests aren't relayed");
    const watch = await watchSocket(b, anaOnB, project.id);
    assert.deepEqual(watch.first, { type: "watchReady" }, "a project socket is relayed home too");
    watch.close();

    // B keeps nothing of it: no project row, and the file's contents are nowhere in its data.
    const dbB = new DatabaseSync(path.join(b.dataDir, "node.db"), { readOnly: true });
    try { assert.equal((dbB.prepare("SELECT count(*) count FROM projects WHERE id = ?").get(project.id) as { count: number }).count, 0); } finally { dbB.close(); }
    assert.deepEqual(await filesContaining(b.dataDir, secret), [], "nothing of the project is written on B");

    // Hidden from other nodes, it's gone from B; so it is with the setting off.
    assert.equal((await api(a, sa, "PUT", `/projects/${project.id}/other-nodes`, { hidden: true })).status, 200);
    assert.equal((await api<{ projects: Array<{ id: string }> }>(b, anaOnB, "GET", "/projects")).body.projects.some((entry) => entry.id === project.id), false);
    assert.equal((await fetch(`${b.url}/api/projects/${project.id}/file?path=notes.txt&download=1`, { headers: { Cookie: anaOnB.cookie } })).status, 404);
    assert.equal((await api(a, sa, "PUT", `/projects/${project.id}/other-nodes`, { hidden: false })).status, 200);
    assert.equal((await api(a, sa, "PUT", "/settings/personal", { showProjectsOnOtherNodes: false })).status, 200);
    assert.equal((await api<{ projects: Array<{ id: string }> }>(b, anaOnB, "GET", "/projects")).body.projects.some((entry) => entry.id === project.id), false, "her setting keeps them all at home");
    assert.equal((await api(a, sa, "PUT", "/settings/personal", { showProjectsOnOtherNodes: true })).status, 200);
    assert.equal((await fetch(`${b.url}/api/projects/${project.id}/file?path=notes.txt&download=1`, { headers: { Cookie: anaOnB.cookie } })).status, 200);

    // What B's own signature can and can't do at Ana's home, where she is the admin: only her
    // live project's routes, never another route with her project named beside it, never
    // passed on to another node, and no sign-in or forget on B's word alone.
    const accountId = ((await (await fetch(`${a.url}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "ana", password: envA.password }) })).json()) as { accountId: string }).accountId;
    const hiddenFolder = path.join(envA.home, "JointBob", "kept-home");
    await mkdir(hiddenFolder, { recursive: true });
    await writeFile(path.join(hiddenFolder, "notes.txt"), "kept at home");
    const hidden = (await api<{ project: { id: string } }>(a, sa, "POST", "/projects", { name: "Kept home", path: hiddenFolder, type: "personal" })).body.project;
    assert.equal((await api(a, sa, "PUT", `/projects/${hidden.id}/other-nodes`, { hidden: true })).status, 200);
    const live = `/api/cluster/v2/live/${accountId}`;
    const asNodeB = signedFrom(envB.home, b, a, [
      ["GET", `${live}/projects/${project.id}/file?path=notes.txt&download=1`],
      ["GET", `${live}/users?projectId=${project.id}`],
      ["PUT", `${live}/settings?projectId=${project.id}`, {}],
      ["PUT", `${live}/settings/personal`, { projectId: project.id, showProjectsOnOtherNodes: true }],
      ["GET", `${live}/secrets?projectId=${project.id}`],
      ["GET", `${live}/PROJECTS/${hidden.id}/file?path=notes.txt&projectId=${project.id}`],
      ["GET", `${live}/projects/${hidden.id}/file?path=notes.txt`],
      ["GET", `${live}/projects/${project.id}/file?path=notes.txt&nodeId=${b.nodeId}`],
      ["GET", `${live}/cluster/v2/accounts?projectId=${project.id}`],
      ["POST", "/api/cluster/v2/accounts/signed-in", { accountId, proof: "0".repeat(64) }],
      ["POST", "/api/cluster/v2/accounts/signed-in", { accountId }],
      ["POST", "/api/cluster/v2/accounts/forget", { accountId }],
    ]);
    assert.deepEqual(asNodeB, [200, 404, 404, 404, 404, 404, 404, 404, 404, 404, 400, 404], "B's signature reaches only Ana's live project");
    assert.equal((await api(a, sa, "GET", "/settings")).status, 200, "Ana is still signed in at home after a forget from B");
    assert.equal((await fetch(`${b.url}/api/projects/${project.id}/file?path=notes.txt&download=1`, { headers: { Cookie: anaOnB.cookie } })).status, 200, "and her link still works");

    // Home offline: listed as offline, can't be opened.
    await stopDevNode(children.shift()!);
    const offline = await api<{ projects: Array<{ id: string }>; liveHome: { online: boolean } }>(b, anaOnB, "GET", "/projects");
    assert.equal(offline.body.liveHome.online, false);
    assert.equal(offline.body.projects.some((entry) => entry.id === project.id), false, "nothing stale is shown");
    assert.equal((await fetch(`${b.url}/api/projects/${project.id}/file?path=notes.txt&download=1`, { headers: { Cookie: anaOnB.cookie } })).status, 503);
  } finally {
    for (const child of children) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});
