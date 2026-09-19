import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  seedDevEnvironment, signIn, startDevNode, stopDevNode,
  type DevEnvironment, type SeededNode, type SignedIn,
} from "./dev-nodes.js";

type Child = Awaited<ReturnType<typeof startDevNode>>;
interface Project {
  id: string;
  name: string;
  path: string;
  type: string;
  color?: string | null;
  ownerNodeId?: string;
  locallyOwned?: boolean;
  clusterIds?: string[];
}
interface SharingView { ownerNodeId: string; generation: number; editable: boolean }

async function apiJSON<T>(node: SeededNode, session: SignedIn, method: string, endpoint: string, body?: unknown): Promise<{ status: number; body?: T }> {
  const response = await fetch(`${node.url}/api${endpoint}`, {
    method,
    headers: {
      Cookie: session.cookie,
      "x-csrf-token": session.csrfToken,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 404 || response.status === 204) {
    await response.body?.cancel();
    return { status: response.status };
  }
  const text = await response.text();
  const parsed = response.headers.get("content-type")?.includes("application/json") && text
    ? JSON.parse(text) as T
    : undefined;
  return { status: response.status, body: parsed };
}

async function poll<T>(read: () => Promise<T | undefined>, message: string, timeout = 25_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new assert.AssertionError({ message });
}

async function createCluster(node: SeededNode, session: SignedIn, name: string): Promise<string> {
  const response = await apiJSON<{ snapshot: { body: { clusterId: string } } }>(node, session, "POST", "/clusters", { name });
  assert.equal(response.status, 201);
  return response.body!.snapshot.body.clusterId;
}

async function join(manager: SeededNode, managerSession: SignedIn, member: SeededNode, memberSession: SignedIn, clusterId: string): Promise<void> {
  const invitation = await apiJSON<{ link: string }>(manager, managerSession, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
  assert.equal(invitation.status, 201);
  const joined = await apiJSON(member, memberSession, "POST", "/clusters/join", { link: invitation.body!.link, requestId: randomUUID() });
  assert.ok(joined.status === 200 || joined.status === 201, `joining cluster returned ${joined.status}`);
}

async function createProject(node: SeededNode, session: SignedIn, name: string): Promise<Project> {
  const response = await apiJSON<{ project: Project }>(node, session, "POST", "/projects", { name, type: "personal", synced: false });
  assert.equal(response.status, 201, `creating ${name} returned ${response.status}`);
  return response.body!.project;
}

async function projects(node: SeededNode, session: SignedIn): Promise<Project[]> {
  const response = await apiJSON<{ projects: Project[] }>(node, session, "GET", "/projects?syncStatus=false");
  assert.equal(response.status, 200);
  return response.body!.projects;
}

async function waitForProject(node: SeededNode, session: SignedIn, id: string): Promise<Project> {
  return poll(async () => (await projects(node, session)).find((project) => project.id === id), `authorized shared project ${id} did not appear in recipient inventory`);
}

async function waitForNoProject(node: SeededNode, session: SignedIn, id: string): Promise<void> {
  await poll(async () => (await projects(node, session)).some((project) => project.id === id) ? undefined : true, `unshared project ${id} remained in recipient inventory`);
}

function assertStrictlyInside(candidate: string, root: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  assert.ok(relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative), `${candidate} is not strictly inside ${root}`);
}

async function pairTwins(nodeB: SeededNode, sessionB: SignedIn, nodeD: SeededNode, sessionD: SignedIn): Promise<void> {
  const invitation = await apiJSON<{ link: string }>(nodeB, sessionB, "POST", "/twins/invitations", { confirmOwnedData: true });
  assert.equal(invitation.status, 201);
  const accepted = await apiJSON(nodeD, sessionD, "POST", "/twins/accept", { link: invitation.body!.link, confirmOwnedData: true });
  assert.equal(accepted.status, 201);
}

function openDb(node: SeededNode): DatabaseSync {
  return new DatabaseSync(path.join(node.dataDir, "node.db"));
}

async function startEnvironment(environment: DevEnvironment, children: Set<Child>): Promise<{ node: SeededNode; session: SignedIn }> {
  const node = environment.nodes[0];
  children.add(await startDevNode(environment, node));
  return { node, session: await signIn(environment, node) };
}

test("authorized project metadata updates, revokes without deleting files, and returns fresh on reshare", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-project-metadata-"));
  const children = new Set<Child>();
  const databases = new Set<DatabaseSync>();
  try {
    const [environmentA, environmentB] = await Promise.all([
      seedDevEnvironment(path.join(root, "a"), 1), seedDevEnvironment(path.join(root, "b"), 1),
    ]);
    const [{ node: nodeA, session: sessionA }, { node: nodeB, session: sessionB }] = await Promise.all([
      startEnvironment(environmentA, children), startEnvironment(environmentB, children),
    ]);
    const clusterX = await createCluster(nodeA, sessionA, "X");
    await join(nodeA, sessionA, nodeB, sessionB, clusterX);
    const projectA = await createProject(nodeA, sessionA, "Metadata P");
    const sourcePathA = projectA.path;
    const shared = await apiJSON(nodeA, sessionA, "PUT", `/sharing/project/${projectA.id}`, {
      expectedGeneration: 1, shares: [{ clusterId: clusterX, projectId: null }],
    });
    assert.equal(shared.status, 200);

    const received = await waitForProject(nodeB, sessionB, projectA.id);
    assert.equal(received.name, projectA.name);
    assert.equal(received.ownerNodeId, nodeA.nodeId);
    assert.equal(received.locallyOwned, false);
    assert.deepEqual(received.clusterIds, [clusterX]);
    assertStrictlyInside(received.path, environmentB.root);
    assert.notEqual(received.path, sourcePathA);
    assert.notEqual(received.type, "personal", "incoming metadata inherited the recipient's private personal workspace");
    const sharingB = await apiJSON<SharingView>(nodeB, sessionB, "GET", `/sharing/project/${projectA.id}`);
    assert.equal(sharingB.status, 200);
    assert.equal(sharingB.body!.ownerNodeId, nodeA.nodeId);
    assert.equal(sharingB.body!.editable, false);
    assert.equal((await apiJSON(nodeB, sessionB, "PUT", `/sharing/project/${projectA.id}`, { expectedGeneration: sharingB.body!.generation, shares: [] })).status, 403);

    assert.equal((await apiJSON(nodeA, sessionA, "PATCH", `/projects/${projectA.id}`, { name: "Metadata P updated", color: "blue" })).status, 200);
    const updated = await poll(async () => {
      const candidate = (await projects(nodeB, sessionB)).find((project) => project.id === projectA.id);
      return candidate?.name === "Metadata P updated" && candidate.color === "blue" ? candidate : undefined;
    }, "updated project metadata did not reach recipient inventory");
    assert.equal(updated.ownerNodeId, nodeA.nodeId);
    assert.equal(updated.path, received.path);

    assertStrictlyInside(received.path, environmentB.root);
    await mkdir(received.path, { recursive: true });
    const marker = path.join(received.path, "retained.txt");
    await writeFile(marker, "retained bytes");
    const sharingA = await apiJSON<SharingView>(nodeA, sessionA, "GET", `/sharing/project/${projectA.id}`);
    assert.equal(sharingA.status, 200);
    assert.equal((await apiJSON(nodeA, sessionA, "PUT", `/sharing/project/${projectA.id}`, { expectedGeneration: sharingA.body!.generation, shares: [] })).status, 200);
    await waitForNoProject(nodeB, sessionB, projectA.id);
    assert.equal((await apiJSON(nodeB, sessionB, "GET", `/projects/${projectA.id}`)).status, 404);
    assert.equal(await readFile(marker, "utf8"), "retained bytes");
    const dbB = openDb(nodeB); databases.add(dbB);
    assert.equal((dbB.prepare("SELECT owner_node_id owner FROM sharing_resource_owners WHERE kind='project' AND resource_id=?").get(projectA.id) as { owner: string }).owner, nodeA.nodeId);

    assert.equal((await apiJSON(nodeA, sessionA, "PATCH", `/projects/${projectA.id}`, { name: "Metadata P private latest" })).status, 200);
    const privateSharing = await apiJSON<SharingView>(nodeA, sessionA, "GET", `/sharing/project/${projectA.id}`);
    assert.equal((await apiJSON(nodeA, sessionA, "PUT", `/sharing/project/${projectA.id}`, {
      expectedGeneration: privateSharing.body!.generation, shares: [{ clusterId: clusterX, projectId: null }],
    })).status, 200);
    const reshared = await waitForProject(nodeB, sessionB, projectA.id);
    assert.equal(reshared.name, "Metadata P private latest");
    assert.equal(reshared.ownerNodeId, nodeA.nodeId);
    assert.equal(reshared.path, received.path);
  } finally {
    for (const database of databases) database.close();
    await Promise.all([...children].map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});

test("received cluster metadata never crosses a bridge or twin while owned twin projects do", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-project-metadata-isolation-"));
  const children = new Set<Child>();
  const databases = new Set<DatabaseSync>();
  try {
    const environments = await Promise.all(["a", "b", "d"].map((key) => seedDevEnvironment(path.join(root, key), 1)));
    const [a, b, d] = await Promise.all(environments.map((environment) => startEnvironment(environment, children)));
    const clusterX = await createCluster(a.node, a.session, "X");
    await join(a.node, a.session, b.node, b.session, clusterX);
    const clusterY = await createCluster(b.node, b.session, "Y");
    await join(b.node, b.session, d.node, d.session, clusterY);
    const projectP = await createProject(a.node, a.session, "Bridge P");
    assert.equal((await apiJSON(a.node, a.session, "PUT", `/sharing/project/${projectP.id}`, {
      expectedGeneration: 1, shares: [{ clusterId: clusterX, projectId: null }],
    })).status, 200);
    const receivedP = await waitForProject(b.node, b.session, projectP.id);
    assert.equal(receivedP.ownerNodeId, a.node.nodeId);
    assert.equal((await projects(d.node, d.session)).some((project) => project.id === projectP.id), false);

    const privateQ = await createProject(b.node, b.session, "Private Q");
    await pairTwins(b.node, b.session, d.node, d.session);
    const receivedQ = await waitForProject(d.node, d.session, privateQ.id);
    assert.equal(receivedQ.ownerNodeId, b.node.nodeId);
    assert.equal((await projects(d.node, d.session)).some((project) => project.id === projectP.id), false);
    assert.equal((await apiJSON(d.node, d.session, "GET", `/projects/${projectP.id}`)).status, 404);
    const sharingP = await apiJSON<SharingView>(b.node, b.session, "GET", `/sharing/project/${projectP.id}`);
    assert.equal((await apiJSON(b.node, b.session, "PUT", `/sharing/project/${projectP.id}`, {
      expectedGeneration: sharingP.body!.generation, shares: [{ clusterId: clusterY, projectId: null }],
    })).status, 403);

    const dbB = openDb(b.node); databases.add(dbB);
    assert.equal((dbB.prepare("SELECT count(*) count FROM cluster_v2_resource_deliveries WHERE kind='project' AND resource_id=? AND peer_id=?").get(projectP.id, d.node.nodeId) as { count: number }).count, 0);
    assert.equal((dbB.prepare("SELECT count(*) count FROM cluster_v2_resource_contexts WHERE kind='project' AND resource_id=? AND recipient_id=?").get(projectP.id, d.node.nodeId) as { count: number }).count, 0);

    const freshR = await createProject(b.node, b.session, "Fresh R");
    const receivedR = await waitForProject(d.node, d.session, freshR.id);
    assert.equal(receivedR.ownerNodeId, b.node.nodeId);
    assert.equal((await projects(d.node, d.session)).some((project) => project.id === projectP.id), false);
    const dbD = openDb(d.node); databases.add(dbD);
    assert.equal((dbD.prepare("SELECT count(*) count FROM projects WHERE id=?").get(projectP.id) as { count: number }).count, 0);
    assert.equal((dbD.prepare("SELECT count(*) count FROM sharing_resource_owners WHERE kind='project' AND resource_id=?").get(projectP.id) as { count: number }).count, 0);
    assert.equal((dbD.prepare("SELECT count(*) count FROM cluster_v2_resource_policy WHERE kind='project' AND resource_id=?").get(projectP.id) as { count: number }).count, 0);
    assert.ok((await projects(d.node, d.session)).some((project) => project.id === privateQ.id));
    assert.ok((await projects(d.node, d.session)).some((project) => project.id === freshR.id));
  } finally {
    for (const database of databases) database.close();
    await Promise.all([...children].map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
