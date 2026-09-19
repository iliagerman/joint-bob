import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { signClusterRequest } from "../src/cluster-protocol.js";
import {
  registerLocalSharingResource, updateResourceSharing, type SignedResourcePolicy,
} from "../src/cluster-sharing.js";
import {
  api, seedDevEnvironment, signIn, startDevNode, stopDevNode,
  type SeededNode, type SignedIn,
} from "./dev-nodes.js";

type Child = Awaited<ReturnType<typeof startDevNode>>;
interface Project { id: string; name: string }
interface Snapshot { body: { clusterId: string } }

function openDb(node: SeededNode): DatabaseSync {
  return new DatabaseSync(path.join(node.dataDir, "node.db"));
}
async function poll(action: () => void | Promise<void>, timeout = 25_000): Promise<void> {
  const end = Date.now() + timeout;
  let failure: unknown;
  while (Date.now() < end) {
    try { await action(); return; } catch (error) { failure = error; }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw failure;
}
async function createCluster(node: SeededNode, session: SignedIn, name: string): Promise<string> {
  const result = await api<{ snapshot: Snapshot }>(node, session, "POST", "/clusters", { name });
  assert.equal(result.status, 201);
  return result.body.snapshot.body.clusterId;
}
async function join(manager: SeededNode, managerSession: SignedIn, member: SeededNode, memberSession: SignedIn, clusterId: string): Promise<void> {
  const invitation = await api<{ link: string }>(manager, managerSession, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
  assert.equal(invitation.status, 201);
  const result = await api(member, memberSession, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() });
  assert.ok([200, 201].includes(result.status), `join returned ${result.status}`);
}
async function createProject(node: SeededNode, session: SignedIn, root: string, name: string): Promise<Project> {
  const fixtureDirectory = path.join(root, name.toLowerCase().replaceAll(" ", "-"));
  await mkdir(fixtureDirectory, { recursive: true });
  const result = await api<{ project: Project }>(node, session, "POST", "/projects", {
    name, type: "personal", path: fixtureDirectory, synced: false,
  });
  assert.equal(result.status, 201);
  return result.body.project;
}
function contextStatement(db: DatabaseSync, resourceId: string, generation: number): SignedResourcePolicy {
  const row = db.prepare(`SELECT statement FROM cluster_v2_resource_contexts
    WHERE kind='project' AND resource_id=? AND generation=? ORDER BY rowid DESC LIMIT 1`)
    .get(resourceId, generation) as { statement: string };
  return JSON.parse(row.statement) as SignedResourcePolicy;
}
async function signedPost(sender: SeededNode, recipient: SeededNode, statement: unknown, extra?: object): Promise<Response> {
  const target = "/api/cluster/v2/resources/policy";
  const body = Buffer.from(JSON.stringify({ statement, ...extra }));
  const key = await readFile(path.join(sender.dataDir, "secret.key"), "utf8");
  const db = openDb(sender);
  let authorization: string;
  const previous = process.env.JOINT_BOB_SECRET_KEY;
  try {
    process.env.JOINT_BOB_SECRET_KEY = key.trim();
    authorization = signClusterRequest(db, sender.nodeId, recipient.nodeId, "POST", target, body);
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_SECRET_KEY;
    else process.env.JOINT_BOB_SECRET_KEY = previous;
    db.close();
  }
  return fetch(`${recipient.url}${target}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: authorization }, body,
  });
}
function policy(db: DatabaseSync, resourceId: string): { owner: string; generation: number; deleted: number } | undefined {
  return db.prepare(`SELECT owner_node_id owner,generation,deleted FROM cluster_v2_resource_policy
    WHERE kind='project' AND resource_id=?`).get(resourceId) as { owner: string; generation: number; deleted: number } | undefined;
}
function deliveryCount(db: DatabaseSync, resourceId: string): number {
  return (db.prepare("SELECT count(*) count FROM cluster_v2_resource_deliveries WHERE resource_id=?")
    .get(resourceId) as { count: number }).count;
}
function resourceRows(db: DatabaseSync, resourceId: string): { owners: number; policies: number; contexts: number } {
  const count = (table: string): number => (db.prepare(`SELECT count(*) count FROM ${table} WHERE kind='project' AND resource_id=?`)
    .get(resourceId) as { count: number }).count;
  return {
    owners: count("sharing_resource_owners"), policies: count("cluster_v2_resource_policy"),
    contexts: count("cluster_v2_resource_contexts"),
  };
}
async function forgeProjectPolicy(
  sender: SeededNode, recipient: SeededNode, clusterId: string, resourceId: string,
): Promise<SignedResourcePolicy> {
  const db = openDb(sender);
  const key = (await readFile(path.join(sender.dataDir, "secret.key"), "utf8")).trim();
  const previous = process.env.JOINT_BOB_SECRET_KEY;
  try {
    process.env.JOINT_BOB_SECRET_KEY = key;
    registerLocalSharingResource(db, sender.nodeId, { kind: "project", id: resourceId });
    updateResourceSharing(db, sender.nodeId, "project", resourceId, 1, [{ clusterId, projectId: null }]);
    return contextStatement(db, resourceId, 2);
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_SECRET_KEY;
    else process.env.JOINT_BOB_SECRET_KEY = previous;
    db.close();
  }
}

test("signed project policy cannot claim an unadopted local project", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-resource-policy-collision-"));
  const children = new Set<Child>();
  const databases = new Set<DatabaseSync>();
  try {
    const [environmentA, environmentB] = await Promise.all([
      seedDevEnvironment(path.join(root, "a"), 1), seedDevEnvironment(path.join(root, "b"), 1),
    ]);
    const nodeA = environmentA.nodes[0], nodeB = environmentB.nodes[0];
    const childA = await startDevNode(environmentA, nodeA); children.add(childA);
    const childB = await startDevNode(environmentB, nodeB); children.add(childB);
    const [sessionA, sessionB] = await Promise.all([signIn(environmentA, nodeA), signIn(environmentB, nodeB)]);
    const clusterId = await createCluster(nodeA, sessionA, "collision");
    await join(nodeA, sessionA, nodeB, sessionB, clusterId);
    await stopDevNode(childA); children.delete(childA);
    const projectId = nodeB.projects[0].id;
    const statement = await forgeProjectPolicy(nodeA, nodeB, clusterId, projectId);
    const dbB = openDb(nodeB); databases.add(dbB);
    const projectBefore = dbB.prepare("SELECT * FROM projects WHERE id=?").get(projectId);
    assert.deepEqual(resourceRows(dbB, projectId), { owners: 0, policies: 0, contexts: 0 });

    const invalid = structuredClone(statement);
    invalid.signature = `${invalid.signature.slice(0, -1)}${invalid.signature.endsWith("A") ? "B" : "A"}`;
    assert.equal((await signedPost(nodeA, nodeB, invalid)).status, 401);
    assert.deepEqual(resourceRows(dbB, projectId), { owners: 0, policies: 0, contexts: 0 });
    assert.equal((await signedPost(nodeA, nodeB, statement)).status, 409);
    assert.deepEqual(dbB.prepare("SELECT * FROM projects WHERE id=?").get(projectId), projectBefore);
    assert.deepEqual(resourceRows(dbB, projectId), { owners: 0, policies: 0, contexts: 0 });
  } finally {
    for (const db of databases) db.close();
    await Promise.all([...children].map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});

test("signed project policy cannot claim a local project alias", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-resource-policy-alias-collision-"));
  const children = new Set<Child>();
  const databases = new Set<DatabaseSync>();
  try {
    const [environmentA, environmentB] = await Promise.all([
      seedDevEnvironment(path.join(root, "a"), 1), seedDevEnvironment(path.join(root, "b"), 1),
    ]);
    const nodeA = environmentA.nodes[0], nodeB = environmentB.nodes[0];
    const childA = await startDevNode(environmentA, nodeA); children.add(childA);
    const childB = await startDevNode(environmentB, nodeB); children.add(childB);
    const [sessionA, sessionB] = await Promise.all([signIn(environmentA, nodeA), signIn(environmentB, nodeB)]);
    const clusterId = await createCluster(nodeA, sessionA, "alias collision");
    await join(nodeA, sessionA, nodeB, sessionB, clusterId);
    await stopDevNode(childA); children.delete(childA);
    const canonicalId = nodeB.projects[0].id;
    const aliasId = `remote-${randomUUID()}`;
    const dbB = openDb(nodeB); databases.add(dbB);
    dbB.prepare("INSERT INTO project_aliases(alias_id,project_id,created_at) VALUES(?,?,?)")
      .run(aliasId, canonicalId, new Date().toISOString());
    const projectBefore = dbB.prepare("SELECT * FROM projects WHERE id=?").get(canonicalId);
    const aliasBefore = dbB.prepare("SELECT * FROM project_aliases WHERE alias_id=?").get(aliasId);
    const statement = await forgeProjectPolicy(nodeA, nodeB, clusterId, aliasId);

    assert.equal((await signedPost(nodeA, nodeB, statement)).status, 409);
    assert.deepEqual(dbB.prepare("SELECT * FROM projects WHERE id=?").get(canonicalId), projectBefore);
    assert.deepEqual(dbB.prepare("SELECT * FROM project_aliases WHERE alias_id=?").get(aliasId), aliasBefore);
    assert.deepEqual(resourceRows(dbB, aliasId), { owners: 0, policies: 0, contexts: 0 });
    assert.deepEqual(resourceRows(dbB, canonicalId), { owners: 0, policies: 0, contexts: 0 });
  } finally {
    for (const db of databases) db.close();
    await Promise.all([...children].map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});

test("signed policy HTTP delivery survives restart, revokes durably, and binds exact operations", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-resource-policy-http-"));
  const children = new Set<Child>();
  const databases = new Set<DatabaseSync>();
  try {
    const [environmentA, environmentB] = await Promise.all([
      seedDevEnvironment(path.join(root, "a"), 1), seedDevEnvironment(path.join(root, "b"), 1),
    ]);
    const nodeA = environmentA.nodes[0], nodeB = environmentB.nodes[0];
    let childA = await startDevNode(environmentA, nodeA); children.add(childA);
    let childB = await startDevNode(environmentB, nodeB); children.add(childB);
    const [sessionA, sessionB] = await Promise.all([signIn(environmentA, nodeA), signIn(environmentB, nodeB)]);
    const clusterX = await createCluster(nodeA, sessionA, "X");
    await join(nodeA, sessionA, nodeB, sessionB, clusterX);
    const project = await createProject(nodeA, sessionA, root, "Policy P");
    await stopDevNode(childA); children.delete(childA);
    const generation2 = await forgeProjectPolicy(nodeA, nodeB, clusterX, project.id);
    const dbA = openDb(nodeA), dbB = openDb(nodeB); databases.add(dbA); databases.add(dbB);
    const direct = await signedPost(nodeA, nodeB, generation2);
    assert.equal(direct.status, 200);
    assert.deepEqual(await direct.json(), { operationId: generation2.body.operationId });
    assert.equal(policy(dbB, project.id)?.owner, nodeA.nodeId);
    assert.equal(policy(dbB, project.id)?.generation, 2);
    assert.equal(policy(dbB, project.id)?.deleted, 0);
    assert.equal((dbB.prepare("SELECT count(*) count FROM sharing_resource_shares WHERE kind='project' AND resource_id=? AND cluster_id=?").get(project.id, clusterX) as { count: number }).count, 1);
    assert.equal((dbB.prepare("SELECT count(*) count FROM projects WHERE id=?").get(project.id) as { count: number }).count, 0, "policy transport must not import project metadata");

    const cookieOnly = await fetch(`${nodeB.url}/api/cluster/v2/resources/policy`, {
      method: "POST", headers: { Cookie: sessionB.cookie, "x-csrf-token": sessionB.csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ statement: generation2 }),
    });
    assert.equal(cookieOnly.status, 401);
    const invalid = structuredClone(generation2); invalid.signature = `${invalid.signature.slice(0, -1)}${invalid.signature.endsWith("A") ? "B" : "A"}`;
    const beforeContexts = (dbB.prepare("SELECT count(*) count FROM cluster_v2_resource_contexts WHERE resource_id=?").get(project.id) as { count: number }).count;
    assert.equal((await signedPost(nodeA, nodeB, invalid)).status, 401);
    assert.equal((dbB.prepare("SELECT count(*) count FROM cluster_v2_resource_contexts WHERE resource_id=?").get(project.id) as { count: number }).count, beforeContexts);

    childA = await startDevNode(environmentA, nodeA); children.add(childA);
    await stopDevNode(childB); children.delete(childB);
    const unshared = await api(nodeA, sessionA, "PUT", `/sharing/project/${project.id}`, { expectedGeneration: 2, shares: [] });
    assert.equal(unshared.status, 200);
    assert.ok(deliveryCount(dbA, project.id) > 0);
    await stopDevNode(childA); children.delete(childA);
    childA = await startDevNode(environmentA, nodeA); children.add(childA);
    assert.ok(deliveryCount(dbA, project.id) > 0, "restart discarded offline revocation");
    childB = await startDevNode(environmentB, nodeB); children.add(childB);
    await poll(() => {
      assert.equal(policy(dbB, project.id)?.owner, nodeA.nodeId);
      assert.equal(policy(dbB, project.id)?.generation, 3);
      assert.equal(policy(dbB, project.id)?.deleted, 0);
      assert.equal((dbB.prepare("SELECT count(*) count FROM sharing_resource_shares WHERE kind='project' AND resource_id=?").get(project.id) as { count: number }).count, 0);
      assert.equal(deliveryCount(dbA, project.id), 0);
    });
    assert.equal((await signedPost(nodeA, nodeB, generation2)).status, 409);
    const reshared = await api(nodeA, sessionA, "PUT", `/sharing/project/${project.id}`, {
      expectedGeneration: 3, shares: [{ clusterId: clusterX, projectId: null }],
    });
    assert.equal(reshared.status, 200);
    await poll(() => {
      assert.equal(policy(dbB, project.id)?.generation, 4);
      assert.equal(deliveryCount(dbA, project.id), 0);
    });
  } finally {
    for (const db of databases) db.close();
    await Promise.all([...children].map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});

test("policy transport does not relay across contexts and rejects unrelated signed replay", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-resource-policy-isolation-"));
  const children = new Set<Child>();
  const databases = new Set<DatabaseSync>();
  try {
    const environments = await Promise.all(["a", "b", "d"].map((name) => seedDevEnvironment(path.join(root, name), 1)));
    const [nodeA, nodeB, nodeD] = environments.map((environment) => environment.nodes[0]);
    for (const [environment, node] of environments.map((environment) => [environment, environment.nodes[0]] as const)) children.add(await startDevNode(environment, node));
    const [sessionA, sessionB, sessionD] = await Promise.all(environments.map((environment, index) => signIn(environment, [nodeA, nodeB, nodeD][index])));
    const clusterX = await createCluster(nodeA, sessionA, "X");
    await join(nodeA, sessionA, nodeB, sessionB, clusterX);
    const clusterY = await createCluster(nodeB, sessionB, "Y");
    await join(nodeB, sessionB, nodeD, sessionD, clusterY);
    const autoShare = await api(nodeB, sessionB, "PATCH", `/clusters/${clusterY}/membership`, { autoShareProjects: true });
    assert.equal(autoShare.status, 200);
    const project = await createProject(nodeA, sessionA, root, "Isolated P");
    assert.equal((await api(nodeA, sessionA, "PUT", `/sharing/project/${project.id}`, {
      expectedGeneration: 1, shares: [{ clusterId: clusterX, projectId: null }],
    })).status, 200);
    const dbA = openDb(nodeA), dbB = openDb(nodeB), dbD = openDb(nodeD);
    databases.add(dbA); databases.add(dbB); databases.add(dbD);
    await poll(() => {
      assert.equal(policy(dbB, project.id)?.generation, 2);
      assert.equal(deliveryCount(dbA, project.id), 0);
    });
    assert.equal(deliveryCount(dbB, project.id), 0, "B relayed A policy");
    assert.equal(policy(dbD, project.id), undefined);
    assert.equal((dbD.prepare("SELECT count(*) count FROM sharing_resource_owners WHERE kind='project' AND resource_id=?").get(project.id) as { count: number }).count, 0);
    const statement = contextStatement(dbA, project.id, 2);
    const before = (dbB.prepare("SELECT count(*) count FROM cluster_v2_resource_contexts WHERE resource_id=?").get(project.id) as { count: number }).count;
    assert.equal((await signedPost(nodeD, nodeB, statement)).status, 403);
    assert.equal((dbB.prepare("SELECT count(*) count FROM cluster_v2_resource_contexts WHERE resource_id=?").get(project.id) as { count: number }).count, before);
    assert.equal((await signedPost(nodeA, nodeB, statement, { extra: true })).status, 400);
    const ticket = structuredClone(statement); ticket.body.kind = "ticket" as "project";
    assert.equal((await signedPost(nodeA, nodeB, ticket)).status, 400);
  } finally {
    for (const db of databases) db.close();
    await Promise.all([...children].map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
