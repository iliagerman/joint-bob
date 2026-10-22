import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";

async function api<T = unknown>(node: SeededNode, session: SignedIn, method: string, endpoint: string, body?: unknown): Promise<{status: number;body: T}> {
  const response = await fetch(`${node.url}/api${endpoint}`, { method, headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrfToken, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
}

async function eventually(check: () => Promise<void>) {
  const deadline = Date.now() + 45_000;
  for (;;) {
    try { await check(); return; } catch (error) { if (Date.now() > deadline) throw error; }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

test("workspace node grants stay narrow, relay grants reach existing and later admitted machines without sharing login accounts", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-relay-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const environments = await Promise.all(["relay", "owner", "recipient", "later"].map(name => seedDevEnvironment(path.join(root, name), 1)));
    const [r, a, b, c] = environments.map(environment => environment.nodes[0]);
    for (const environment of environments) children.push(await startDevNode(environment, environment.nodes[0]));
    const [sr, sa, sb, sc] = await Promise.all(environments.map(environment => signIn(environment, environment.nodes[0])));
    const serving = await api(r, sr, "PUT", "/relay/serving", { enabled: true, origin: `http://localhost:${r.port}`, environment: "Workspace test", requestsEnabled: true, maxMachines: 10, monthlyCapGb: 0, alertTopic: "" });
    assert.equal(serving.status, 204, JSON.stringify(serving.body));
    const join = async (node: SeededNode, session: SignedIn) => {
      const token = await api<{link: string}>(r, sr, "POST", "/relay/serving/tokens", { label: node.nodeId });
      assert.equal(token.status, 201);
      const joined = await api(node, session, "POST", "/relays", { link: token.body.link });
      assert.equal(joined.status, 201, JSON.stringify(joined.body));
    };
    await join(a, sa); await join(b, sb);
    await eventually(async () => {
      const destinations = await api<{relays: Array<{id: string}>;nodes: Array<{id: string}>}>(a, sa, "GET", "/workspace-sharing/destinations");
      assert.ok(destinations.body.relays.some(relay => relay.id === r.nodeId), JSON.stringify(destinations.body));
      assert.ok(destinations.body.nodes.some(node => node.id === b.nodeId), "other admitted nodes must be selectable");
    });
    const created = await api<{workspace: {id: string}}>(a, sa, "PUT", "/workspaces", { label: "Selected machines", sharing: { clusterIds: [], nodeIds: [b.nodeId], relayIds: [] } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const workspaceId = created.body.workspace.id;
    const project = await api<{project: {id: string}}>(a, sa, "POST", "/projects", { name: "Shared client", type: workspaceId });
    assert.equal(project.status, 201, JSON.stringify(project.body));
    const projectId = project.body.project.id;
    const ids = async (node: SeededNode, session: SignedIn) => (await api<{projects: Array<{id: string}>}>(node, session, "GET", "/projects?syncStatus=false")).body.projects.map(project => project.id);
    await eventually(async () => assert.ok((await ids(b, sb)).includes(projectId), "selected node receives project"));
    assert.ok(!(await ids(r, sr)).includes(projectId), "node grant must not reach the relay host");
    const expanded = await api(a, sa, "PUT", `/workspaces/${workspaceId}/sharing`, { clusterIds: [], nodeIds: [], relayIds: [r.nodeId] });
    assert.equal(expanded.status, 200, JSON.stringify(expanded.body));
    await eventually(async () => assert.ok((await ids(r, sr)).includes(projectId), "relay sharing includes its host"));
    const emptyWorkspace = await api(a, sa, "PUT", "/workspaces", { label: "Empty for future members", sharing: { clusterIds: [], nodeIds: [], relayIds: [r.nodeId] } });
    assert.equal(emptyWorkspace.status, 200);
    await join(c, sc);
    await eventually(async () => assert.ok((await ids(c, sc)).includes(projectId), "later admitted nodes inherit the workspace share"));
    await eventually(async () => {
      const workspaces = await api<{workspaces: Array<{label: string;source?: {nodeId: string}}> }>(c, sc, "GET", "/workspaces");
      assert.ok(workspaces.body.workspaces.some(workspace => workspace.label === "Empty for future members" && workspace.source?.nodeId === a.nodeId), "a later relay member also receives empty workspaces");
    });
    const memberships = await api<{relays: Array<{id: string}>}>(a, sa, "GET", "/relays");
    assert.equal((await api(a, sa, "DELETE", `/relays/${memberships.body.relays[0].id}`)).status, 204);
    const offlineProject = await api<{project: {id: string}}>(a, sa, "POST", "/projects", { name: "Created while disconnected", type: workspaceId });
    assert.equal(offlineProject.status, 201, JSON.stringify(offlineProject.body));
    assert.ok(!(await ids(c, sc)).includes(offlineProject.body.project.id), "disconnected relay grants fail closed");
    await join(a, sa);
    await eventually(async () => assert.ok((await ids(c, sc)).includes(offlineProject.body.project.id), "reconnecting restores persisted sharing for offline-created projects"));
    for (const node of [r, a, b, c]) {
      const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
      try { assert.equal((db.prepare("SELECT count(*) n FROM users WHERE home_node_id IS NOT NULL").get() as {n: number}).n, 0, "relay groups must never replicate login accounts"); }
      finally { db.close(); }
    }
    assert.equal((await api(a, sa, "PUT", `/workspaces/${workspaceId}/sharing`, { clusterIds: [], nodeIds: [], relayIds: [] })).status, 200);
    await eventually(async () => {
      const listed = await api<{projects: Array<{id: string; shared?: unknown}>}>(b, sb, "GET", "/projects?syncStatus=false");
      assert.ok(!listed.body.projects.some(project => project.id === projectId), "revoking a workspace removes remote access");
    });
  } finally { await Promise.all(children.map(stopDevNode)); await rm(root, { recursive: true, force: true }); }
});
