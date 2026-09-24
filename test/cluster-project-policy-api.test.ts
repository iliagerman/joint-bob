import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";

interface Project { id: string; name: string; path: string }
interface SharingView { ownerNodeId: string; generation: number; deleted: boolean; editable: boolean; shares: Array<{ clusterId: string; projectId: null }>; pendingDeliveries: number }

async function createCluster(node: SeededNode, session: SignedIn): Promise<string> {
  const result = await api<{ snapshot: { body: { clusterId: string } } }>(node, session, "POST", "/clusters", { name: "Projects" });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body.snapshot.body.clusterId;
}

async function startFixture(root: string): Promise<{ environment: DevEnvironment; node: SeededNode; session: SignedIn; child: Awaited<ReturnType<typeof startDevNode>> }> {
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const child = await startDevNode(environment, node);
  return { environment, node, child, session: await signIn(environment, node) };
}

async function createProject(node: SeededNode, session: SignedIn, name: string, projectPath: string) {
  return api<{ project: Project }>(node, session, "POST", "/projects", { name, path: projectPath, synced: false });
}

test("new selective projects atomically receive owner policy, auto-shares, and CAS semantics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-project-policy-"));
  const fixture = await startFixture(root);
  try {
    const clusterId = await createCluster(fixture.node, fixture.session);
    const topology = new DatabaseSync(path.join(fixture.node.dataDir, "node.db"));
    topology.exec("PRAGMA busy_timeout=5000");
    topology.prepare("INSERT INTO sharing_memberships(cluster_id,node_id,auto_share_projects,join_sequence) VALUES(?,?,0,2)").run(clusterId, randomUUID());
    topology.close();
    const legacy = await api<{ error: string }>(fixture.node, fixture.session, "GET", `/sharing/project/${fixture.node.projects[0].id}`);
    assert.equal(legacy.status, 409);
    assert.equal(legacy.body.error, "Project ownership requires adoption");

    const privateCreated = await createProject(fixture.node, fixture.session, "Private new", path.join(root, "private"));
    assert.equal(privateCreated.status, 201);
    const privateView = await api<SharingView>(fixture.node, fixture.session, "GET", `/sharing/project/${privateCreated.body.project.id}`);
    assert.deepEqual(privateView.body.shares, []);
    assert.equal(privateView.body.ownerNodeId, fixture.node.nodeId);
    assert.equal(privateView.body.generation, 1);

    assert.equal((await api(fixture.node, fixture.session, "PATCH", `/clusters/${clusterId}/membership`, { autoShareProjects: true })).status, 200);
    const shared = await createProject(fixture.node, fixture.session, "Shared new", path.join(root, "shared"));
    const initial = await api<SharingView>(fixture.node, fixture.session, "GET", `/sharing/project/${shared.body.project.id}`);
    assert.deepEqual(initial.body.shares, [{ clusterId, projectId: null }]);
    assert.ok(initial.body.pendingDeliveries > 0);
    const unshared = await api<SharingView>(fixture.node, fixture.session, "PUT", `/sharing/project/${shared.body.project.id}`, { expectedGeneration: 1, shares: [] });
    assert.equal(unshared.body.generation, 2);
    const duplicate = await createProject(fixture.node, fixture.session, "Renamed duplicate", path.join(root, "shared"));
    assert.equal(duplicate.body.project.id, shared.body.project.id);
    const unchanged = await api<SharingView>(fixture.node, fixture.session, "GET", `/sharing/project/${shared.body.project.id}`);
    assert.equal(unchanged.body.generation, 2);
    assert.deepEqual(unchanged.body.shares, []);
    assert.equal((await api(fixture.node, fixture.session, "PUT", `/sharing/project/${shared.body.project.id}`, { expectedGeneration: 1, shares: [{ clusterId, projectId: null }] })).status, 409);
  } finally {
    await stopDevNode(fixture.child);
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical aliases mutate one owner policy and bulk sharing excludes unadopted projects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-project-alias-"));
  const fixture = await startFixture(root);
  try {
    const clusterId = await createCluster(fixture.node, fixture.session);
    const created = await createProject(fixture.node, fixture.session, "Canonical", path.join(root, "canonical"));
    const alias = `alias-${randomUUID()}`;
    const db = new DatabaseSync(path.join(fixture.node.dataDir, "node.db"));
    db.exec("PRAGMA busy_timeout=5000");
    db.prepare("INSERT INTO project_aliases(alias_id,project_id,created_at) VALUES(?,?,?)").run(alias, created.body.project.id, new Date().toISOString());
    db.close();
    const changed = await api<SharingView>(fixture.node, fixture.session, "PUT", `/sharing/project/${alias}`, { expectedGeneration: 1, shares: [{ clusterId, projectId: null }] });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    const canonical = await api<SharingView>(fixture.node, fixture.session, "GET", `/sharing/project/${created.body.project.id}`);
    assert.equal(canonical.body.generation, 2);
    const bulk = await api<{ shared: number }>(fixture.node, fixture.session, "POST", `/clusters/${clusterId}/share-all-projects`, {});
    assert.equal(bulk.status, 200);
    assert.equal(bulk.body.shared, 0);
    const repeat = await api<{ shared: number }>(fixture.node, fixture.session, "POST", `/clusters/${clusterId}/share-all-projects`, {});
    assert.equal(repeat.body.shared, 0);
    assert.equal((await api(fixture.node, fixture.session, "GET", `/sharing/project/${fixture.node.projects[0].id}`)).status, 409);
  } finally {
    await stopDevNode(fixture.child);
    await rm(root, { recursive: true, force: true });
  }
});

test("project creation rolls back project and policy rows when delivery insertion fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-project-atomic-"));
  const fixture = await startFixture(root);
  try {
    const clusterId = await createCluster(fixture.node, fixture.session);
    const warmup = await createProject(fixture.node, fixture.session, "Policy schema warmup", path.join(root, "warmup"));
    assert.equal(warmup.status, 201);
    const db = new DatabaseSync(path.join(fixture.node.dataDir, "node.db"));
    db.exec("PRAGMA busy_timeout=5000");
    db.prepare("INSERT INTO sharing_memberships(cluster_id,node_id,auto_share_projects,join_sequence) VALUES(?,?,0,2)").run(clusterId, randomUUID());
    await api(fixture.node, fixture.session, "PATCH", `/clusters/${clusterId}/membership`, { autoShareProjects: true });
    db.exec("CREATE TRIGGER fail_project_delivery BEFORE INSERT ON cluster_v2_resource_deliveries BEGIN SELECT RAISE(ABORT,'known delivery failure'); END");
    const before = db.prepare("SELECT count(*) count FROM projects").get() as { count: number };
    const attemptedPath = path.join(root, "atomic");
    const failed = await createProject(fixture.node, fixture.session, "Atomic unique", attemptedPath);
    assert.notEqual(failed.status, 201);
    assert.equal((db.prepare("SELECT count(*) count FROM projects").get() as { count: number }).count, before.count);
    assert.equal((db.prepare("SELECT count(*) count FROM cluster_v2_resource_policy WHERE kind='project' AND resource_id NOT IN (SELECT id FROM projects)").get() as { count: number }).count, 0);
    db.exec("DROP TRIGGER fail_project_delivery");
    db.close();
    const retried = await createProject(fixture.node, fixture.session, "Atomic unique", attemptedPath);
    assert.equal(retried.status, 201, JSON.stringify(retried.body));
    const view = await api<SharingView>(fixture.node, fixture.session, "GET", `/sharing/project/${retried.body.project.id}`);
    assert.equal(view.body.generation, 1);
    assert.deepEqual(view.body.shares, [{ clusterId, projectId: null }]);
    assert.ok(view.body.pendingDeliveries > 0);
  } finally {
    await stopDevNode(fixture.child);
    await rm(root, { recursive: true, force: true });
  }
});
