import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { offeredTo } from "../src/dashboards/sharing.js";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SignedIn } from "./dev-nodes.js";

const base = { saved: true, origin: "own" as const, receiverIsTwin: false, createdByAdmin: true, selection: { nodeIds: [], clusterIds: [] }, receiverNodeId: "r", receiverClusterIds: ["c1"], projectShared: true };

test("a dashboard is offered to twins by default and to chosen nodes and clusters", () => {
  assert.equal(offeredTo(base), false, "nothing is shared unless chosen");
  assert.equal(offeredTo({ ...base, receiverIsTwin: true }), true, "twins receive the node owner's dashboards");
  assert.equal(offeredTo({ ...base, receiverIsTwin: true, createdByAdmin: false }), false, "a member's dashboards do not follow the owner's twin trust");
  assert.equal(offeredTo({ ...base, selection: { nodeIds: ["r"], clusterIds: [] } }), true);
  assert.equal(offeredTo({ ...base, selection: { nodeIds: [], clusterIds: ["c1"] } }), true);
  assert.equal(offeredTo({ ...base, selection: { nodeIds: [], clusterIds: ["c2"] } }), false);
  assert.equal(offeredTo({ ...base, receiverIsTwin: true, projectShared: false }), false, "never where its project is not shared");
  assert.equal(offeredTo({ ...base, receiverIsTwin: true, saved: false }), false, "a dashboard being created is not offered");
  assert.equal(offeredTo({ ...base, receiverIsTwin: true, origin: "received" }), false, "received dashboards are never passed on");
});

async function fakeAgent(root: string): Promise<string> {
  const module = path.join(root, "dashboard-agent.mjs");
  await writeFile(module, `import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
export default async (input) => {
  const draft = /Draft folder \\(edit here\\): (.+)/.exec(input.prompt)[1].trim();
  await mkdir(draft, { recursive: true });
  const version = /## The person's request\\s+Make version (\\d+)/.exec(input.prompt)[1];
  const command = "node -e \\"console.log(JSON.stringify({generatedAt:'2026-10-24T09:00:00Z',version:" + version + "}))\\"";
  await writeFile(path.join(draft, "manifest.json"), JSON.stringify({ title: "Bugs v" + version, refresh: { method: "script", command } }));
  await writeFile(path.join(draft, "index.html"), "<p>v" + version + "</p>");
  return "done";
};
`);
  return module;
}

type View = Record<string, any>;
type Node = Parameters<typeof api>[0];

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function build(node: Node, auth: SignedIn, id: string, projectId: string, version: number): Promise<void> {
  assert.equal((await api(node, auth, "POST", `/dashboards/${id}/messages`, { text: `Make version ${version}`, projectId })).status, 202);
  await waitFor(() => api<View>(node, auth, "GET", `/dashboards/${id}?projectId=${projectId}`), (view) => !view.body.dashboard.running, "the creator turn");
  const saved = await api<View>(node, auth, "POST", `/dashboards/${id}/draft/save`, { projectId });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
}

function listing(node: Node, auth: SignedIn, projectId: string) {
  return api<View>(node, auth, "GET", `/dashboards?kind=project&id=${projectId}&projectId=${projectId}`);
}

test("a twin receives a dashboard inactive, runs it only after approval, and follows the owner's changes", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-dashboards-twins-"));
  const agent = await fakeAgent(root);
  const servers: Array<Awaited<ReturnType<typeof startDevNode>>> = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const [a, b] = environment.nodes;
    servers.push(await startDevNode(environment, a, { JOINT_BOB_DASHBOARD_AGENT: agent }), await startDevNode(environment, b, { JOINT_BOB_DASHBOARD_AGENT: agent }));
    await pairTwinNodes(environment);
    const [authA, authB] = await Promise.all([signIn(environment, a), signIn(environment, b)]);
    const projectId = a.projects[0].id;

    const created = await api<View>(a, authA, "POST", "/dashboards", { entity: { kind: "project", id: projectId }, projectId });
    const id = created.body.dashboard.id as string;
    await build(a, authA, id, projectId, 1);

    const received = await waitFor(() => listing(b, authB, projectId), (view) => view.body.dashboards?.some((d: View) => d.id === id), "the twin to receive the dashboard");
    const copy = received.body.dashboards.find((d: View) => d.id === id);
    assert.equal(copy.origin, "received");
    assert.equal(copy.approved, false);
    assert.equal(copy.active, false);
    assert.equal(copy.title, "Bugs v1");
    assert.equal(received.body.displayedId, id, "a twin with no dashboard of its own shows the received one, waiting for approval");

    const refused = await api(b, authB, "POST", `/dashboards/${id}/refresh`, { target: "live", projectId });
    assert.equal(refused.status, 403, "it never runs before approval");
    const edit = await api(b, authB, "POST", `/dashboards/${id}/messages`, { text: "change it", projectId });
    assert.equal(edit.status, 409, "a received dashboard is edited through a copy");

    const definition = await api<View>(b, authB, "GET", `/dashboards/${id}/definition?projectId=${projectId}`);
    assert.match(definition.body.files.find((file: View) => file.path === "manifest.json").text, /version:1/);
    const approved = await api<View>(b, authB, "POST", `/dashboards/${id}/approve`, { digest: definition.body.digest, projectId });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.dashboard.active, true, "approval activates it on a twin that has no dashboard of its own");
    assert.equal((await api(b, authB, "POST", `/dashboards/${id}/refresh`, { target: "live", projectId })).status, 202);
    const ran = await waitFor(() => api<View>(b, authB, "GET", `/dashboards/${id}?projectId=${projectId}`), (view) => view.body.dashboard.lastRefresh !== null && !view.body.dashboard.running, "the twin's refresh");
    assert.equal(ran.body.dashboard.lastRefresh.ok, true, JSON.stringify(ran.body.dashboard.lastRefresh));

    await build(a, authA, id, projectId, 2);
    const changed = await waitFor(() => listing(b, authB, projectId), (view) => view.body.dashboards.find((d: View) => d.id === id)?.title === "Bugs v2", "the owner's change");
    const updated = changed.body.dashboards.find((d: View) => d.id === id);
    assert.equal(updated.approved, false, "new code needs a new approval");
    assert.equal(updated.active, false);
    assert.equal((await api(b, authB, "POST", `/dashboards/${id}/refresh`, { target: "live", projectId })).status, 403);
    assert.equal((await api(b, authB, "POST", `/dashboards/${id}/approve`, { digest: definition.body.digest, projectId })).status, 409, "the old approval does not cover the new code");
    const unapprovedFrame = await (await fetch(`${b.url}/api/dashboards/${id}/frame?projectId=${projectId}`, { headers: { cookie: authB.cookie } })).text();
    assert.match(unapprovedFrame, /<p>v2<\/p>/, "the new layout can be previewed");
    assert.match(unapprovedFrame, /id="payload">\{\}<\/script>/, "unapproved code never sees this node's data");
    assert.equal((await api(b, authB, "POST", `/dashboards/${id}/copy`, { projectId })).status, 409, "a copy cannot skip approval");
    const second = await api<View>(b, authB, "GET", `/dashboards/${id}/definition?projectId=${projectId}`);
    assert.equal((await api(b, authB, "POST", `/dashboards/${id}/approve`, { digest: second.body.digest, projectId })).status, 200);

    const copied = await api<View>(b, authB, "POST", `/dashboards/${id}/copy`, { projectId });
    assert.equal(copied.status, 200, JSON.stringify(copied.body));
    assert.equal(copied.body.dashboard.origin, "own");
    assert.notEqual(copied.body.dashboard.id, id);

    assert.equal((await api(a, authA, "DELETE", `/dashboards/${id}?projectId=${projectId}`)).status, 200);
    const gone = await waitFor(() => listing(b, authB, projectId), (view) => !view.body.dashboards.some((d: View) => d.id === id), "the owner's deletion");
    assert.ok(gone.body.dashboards.some((d: View) => d.id === copied.body.dashboard.id), "the local copy stays");
  } finally {
    for (const server of servers) await stopDevNode(server);
  }
});
