import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { listProjectMetadataDeliveries } from "../src/cluster-project-metadata.js";
import { signClusterRequest } from "../src/cluster-protocol.js";
import {
  api, seedDevEnvironment, signIn, startDevNode, stopDevNode,
  type SeededNode, type SignedIn,
} from "./dev-nodes.js";

type Child = Awaited<ReturnType<typeof startDevNode>>;
interface Project { id: string; name: string; ownerNodeId?: string }

async function createCluster(node: SeededNode, session: SignedIn): Promise<string> {
  const result = await api<{ snapshot: { body: { clusterId: string } } }>(node, session, "POST", "/clusters", { name: "metadata boundary" });
  assert.equal(result.status, 201);
  return result.body.snapshot.body.clusterId;
}

async function join(manager: SeededNode, managerSession: SignedIn, member: SeededNode, memberSession: SignedIn, clusterId: string): Promise<void> {
  const invitation = await api<{ link: string }>(manager, managerSession, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
  assert.equal(invitation.status, 201);
  const result = await api(member, memberSession, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() });
  assert.ok(result.status === 200 || result.status === 201);
}

async function waitForProject(node: SeededNode, session: SignedIn, id: string): Promise<Project> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const result = await api<{ projects: Project[] }>(node, session, "GET", "/projects?syncStatus=false");
    assert.equal(result.status, 200);
    const project = result.body.projects.find((candidate) => candidate.id === id);
    if (project) return project;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new assert.AssertionError({ message: `project ${id} did not reach B` });
}

async function signedMetadataPost(sender: SeededNode, recipient: SeededNode, envelope: unknown): Promise<Response> {
  const target = "/api/cluster/v2/resources/project-metadata";
  const body = Buffer.from(JSON.stringify(envelope));
  const key = await readFile(path.join(sender.dataDir, "secret.key"), "utf8");
  const db = new DatabaseSync(path.join(sender.dataDir, "node.db"));
  const previous = process.env.JOINT_BOB_SECRET_KEY;
  try {
    process.env.JOINT_BOB_SECRET_KEY = key.trim();
    const authorization = signClusterRequest(db, sender.nodeId, recipient.nodeId, "POST", target, body);
    return await fetch(`${recipient.url}${target}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: authorization }, body,
    });
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_SECRET_KEY;
    else process.env.JOINT_BOB_SECRET_KEY = previous;
    db.close();
  }
}

test("metadata capture reads native metadata and its revision from one SQLite snapshot", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-metadata-atomic-"));
  const children = new Set<Awaited<ReturnType<typeof startDevNode>>>();
  let sourceDb: DatabaseSync | undefined;
  let concurrentDb: DatabaseSync | undefined;
  try {
    const [environmentA, environmentB] = await Promise.all([
      seedDevEnvironment(path.join(root, "a"), 1), seedDevEnvironment(path.join(root, "b"), 1),
    ]);
    const nodeA = environmentA.nodes[0], nodeB = environmentB.nodes[0];
    const childA = await startDevNode(environmentA, nodeA); children.add(childA);
    const childB = await startDevNode(environmentB, nodeB); children.add(childB);
    const [sessionA, sessionB] = await Promise.all([signIn(environmentA, nodeA), signIn(environmentB, nodeB)]);
    const clusterId = await createCluster(nodeA, sessionA);
    await join(nodeA, sessionA, nodeB, sessionB, clusterId);
    const created = await api<{ project: Project }>(nodeA, sessionA, "POST", "/projects", { name: "Atomic P", type: "personal", synced: false });
    assert.equal(created.status, 201);
    const project = created.body.project;
    assert.equal((await api(nodeA, sessionA, "PUT", `/sharing/project/${project.id}`, {
      expectedGeneration: 1, shares: [{ clusterId, projectId: null }],
    })).status, 200);
    await stopDevNode(childA); children.delete(childA);

    const dbPath = path.join(nodeA.dataDir, "node.db");
    sourceDb = new DatabaseSync(dbPath);
    concurrentDb = new DatabaseSync(dbPath);
    sourceDb.prepare("UPDATE projects SET name=? WHERE id=?").run("Wanted", project.id);
    sourceDb.exec("PRAGMA busy_timeout=5000");
    concurrentDb.exec("PRAGMA busy_timeout=5000");
    const native = sourceDb.prepare("SELECT color,created_at,updated_at FROM projects WHERE id=?").get(project.id) as {
      color: string | null; created_at: string; updated_at: string;
    };
    const prior = sourceDb.prepare("SELECT revision FROM cluster_v2_project_metadata_versions WHERE owner_node_id=? AND project_id=?")
      .get(nodeA.nodeId, project.id) as { revision: number } | undefined;
    const revision = (prior?.revision ?? 0) + 1;
    const payload = JSON.stringify({ name: "Concurrent", color: native.color, createdAt: native.created_at, updatedAt: native.updated_at });
    const originalExec = sourceDb.exec.bind(sourceDb);
    let injected = false;
    sourceDb.exec = ((sql: string) => {
      if (!injected && sql.startsWith("SAVEPOINT project_metadata")) {
        injected = true;
        concurrentDb!.exec("BEGIN IMMEDIATE");
        concurrentDb!.prepare("UPDATE projects SET name=? WHERE id=?").run("Concurrent", project.id);
        concurrentDb!.prepare(`INSERT INTO cluster_v2_project_metadata_versions(owner_node_id,project_id,revision,payload)
          VALUES(?,?,?,?) ON CONFLICT(owner_node_id,project_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload`)
          .run(nodeA.nodeId, project.id, revision, payload);
        concurrentDb!.exec("COMMIT");
      }
      return originalExec(sql);
    }) as typeof sourceDb.exec;
    try {
      const delivery = listProjectMetadataDeliveries(sourceDb, nodeA.nodeId).find((item) => item.statement.body.resourceId === project.id);
      assert.equal(delivery?.metadata.name, "Concurrent");
      assert.equal(delivery?.revision, revision);
      const stored = sourceDb.prepare("SELECT revision,payload FROM cluster_v2_project_metadata_versions WHERE owner_node_id=? AND project_id=?")
        .get(nodeA.nodeId, project.id) as { revision: number; payload: string };
      assert.equal(stored.revision, revision);
      assert.equal(JSON.parse(stored.payload).name, "Concurrent");
    } finally {
      sourceDb.exec = originalExec as typeof sourceDb.exec;
    }
  } finally {
    sourceDb?.close();
    concurrentDb?.close();
    await Promise.all([...children].map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});

test("metadata HTTP boundary rejects invalid requests and protects revision ordering", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-metadata-revisions-"));
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
    const clusterId = await createCluster(nodeA, sessionA);
    await join(nodeA, sessionA, nodeB, sessionB, clusterId);
    const created = await api<{ project: Project }>(nodeA, sessionA, "POST", "/projects", {
      name: "Revision P", type: "personal", synced: false,
    });
    assert.equal(created.status, 201);
    const project = created.body.project;
    assert.equal((await api(nodeA, sessionA, "PUT", `/sharing/project/${project.id}`, {
      expectedGeneration: 1, shares: [{ clusterId, projectId: null }],
    })).status, 200);
    await waitForProject(nodeB, sessionB, project.id);
    await stopDevNode(childA); children.delete(childA);

    const dbA = new DatabaseSync(path.join(nodeA.dataDir, "node.db")); databases.add(dbA);
    const dbB = new DatabaseSync(path.join(nodeB.dataDir, "node.db")); databases.add(dbB);
    const statementRow = dbA.prepare(`SELECT statement FROM cluster_v2_resource_contexts
      WHERE kind='project' AND resource_id=? AND recipient_id=? AND active=1 ORDER BY rowid DESC LIMIT 1`)
      .get(project.id, nodeB.nodeId) as { statement: string };
    const version = dbA.prepare(`SELECT revision,payload FROM cluster_v2_project_metadata_versions
      WHERE owner_node_id=? AND project_id=?`).get(nodeA.nodeId, project.id) as { revision: number; payload: string };
    const originalEnvelope = {
      statement: JSON.parse(statementRow.statement), revision: version.revision, metadata: JSON.parse(version.payload),
    };
    const nativeRow = (): unknown => dbB.prepare("SELECT name,color,created_at,updated_at FROM projects WHERE id=?").get(project.id);
    const versionRow = (): unknown => dbB.prepare("SELECT * FROM cluster_v2_project_metadata_versions WHERE owner_node_id=? AND project_id=?")
      .get(nodeA.nodeId, project.id);
    const receiptRows = (): unknown[] => dbB.prepare("SELECT * FROM cluster_v2_project_metadata_receipts WHERE owner_node_id=? AND project_id=? ORDER BY rowid")
      .all(nodeA.nodeId, project.id);
    const assertState = (expected: { native: unknown; version: unknown; receipts: unknown[] }): void => {
      assert.deepEqual(nativeRow(), expected.native);
      assert.deepEqual(versionRow(), expected.version);
      assert.deepEqual(receiptRows(), expected.receipts);
    };
    const initial = { native: nativeRow(), version: versionRow(), receipts: receiptRows() };
    const target = "/api/cluster/v2/resources/project-metadata";
    const cookieOnly = await fetch(`${nodeB.url}${target}`, {
      method: "POST",
      headers: { Cookie: sessionB.cookie, "x-csrf-token": sessionB.csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify(originalEnvelope),
    });
    assert.equal(cookieOnly.status, 401);
    assertState(initial);

    const unknownPath = { ...originalEnvelope, metadata: { ...originalEnvelope.metadata, path: "/not-a-transfer-path" } };
    assert.equal((await signedMetadataPost(nodeA, nodeB, unknownPath)).status, 400);
    assertState(initial);

    const signature = originalEnvelope.statement.signature as string;
    const invalidSignature = {
      ...originalEnvelope,
      statement: { ...originalEnvelope.statement, signature: `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}` },
    };
    assert.equal((await signedMetadataPost(nodeA, nodeB, invalidSignature)).status, 401);
    assertState(initial);

    const envelopeNew = {
      ...originalEnvelope, revision: version.revision + 1,
      metadata: { ...originalEnvelope.metadata, name: "Latest metadata" },
    };
    assert.equal((await signedMetadataPost(nodeA, nodeB, envelopeNew)).status, 200);
    assert.equal((nativeRow() as { name: string }).name, "Latest metadata");
    const installedVersion = versionRow() as { revision: number; payload: string };
    assert.equal(installedVersion.revision, envelopeNew.revision);
    assert.deepEqual(JSON.parse(installedVersion.payload), envelopeNew.metadata);
    const latest = { native: nativeRow(), version: versionRow(), receipts: receiptRows() };

    assert.equal((await signedMetadataPost(nodeA, nodeB, originalEnvelope)).status, 200);
    assert.deepEqual(nativeRow(), latest.native, "stale metadata must not roll native data back");
    assert.deepEqual(versionRow(), latest.version);
    const staleReceipts = receiptRows() as Array<{ revision: number }>;
    const latestReceipts = latest.receipts as Array<{ revision: number }>;
    assert.equal(staleReceipts.length, latestReceipts.length);
    for (let index = 0; index < staleReceipts.length; index++) {
      assert.ok(staleReceipts[index].revision >= latestReceipts[index].revision);
    }

    const conflict = { ...envelopeNew, metadata: { ...envelopeNew.metadata, name: "Conflicting metadata" } };
    const beforeConflict = { native: nativeRow(), version: versionRow(), receipts: receiptRows() };
    assert.equal((await signedMetadataPost(nodeA, nodeB, conflict)).status, 409);
    assertState(beforeConflict);
  } finally {
    for (const database of databases) database.close();
    await Promise.all([...children].map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});

test("deleted native replicas reconstruct from retained metadata and private workspace reuse blocks adoption", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-metadata-reconstruction-"));
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
    const clusterId = await createCluster(nodeA, sessionA);
    await join(nodeA, sessionA, nodeB, sessionB, clusterId);
    const created = await api<{ project: Project }>(nodeA, sessionA, "POST", "/projects", {
      name: "Reconstructed P", type: "personal", synced: false,
    });
    assert.equal(created.status, 201);
    const project = created.body.project;
    assert.equal((await api(nodeA, sessionA, "PUT", `/sharing/project/${project.id}`, {
      expectedGeneration: 1, shares: [{ clusterId, projectId: null }],
    })).status, 200);
    await waitForProject(nodeB, sessionB, project.id);
    await stopDevNode(childA); children.delete(childA);

    const dbA = new DatabaseSync(path.join(nodeA.dataDir, "node.db")); databases.add(dbA);
    const dbB = new DatabaseSync(path.join(nodeB.dataDir, "node.db")); databases.add(dbB);
    const statement = dbA.prepare(`SELECT statement FROM cluster_v2_resource_contexts
      WHERE kind='project' AND resource_id=? AND recipient_id=? AND active=1 ORDER BY rowid DESC LIMIT 1`)
      .get(project.id, nodeB.nodeId) as { statement: string };
    const originalVersion = dbA.prepare(`SELECT revision,payload FROM cluster_v2_project_metadata_versions
      WHERE owner_node_id=? AND project_id=?`).get(nodeA.nodeId, project.id) as { revision: number; payload: string };
    const originalEnvelope = {
      statement: JSON.parse(statement.statement), revision: originalVersion.revision,
      metadata: JSON.parse(originalVersion.payload),
    };
    const newerEnvelope = {
      ...originalEnvelope, revision: originalEnvelope.revision + 1,
      metadata: { ...originalEnvelope.metadata, name: "Latest retained metadata" },
    };
    assert.equal((await signedMetadataPost(nodeA, nodeB, newerEnvelope)).status, 200);

    type NativeRow = { id: string; name: string; workspace_id: string; path: string };
    const nativeRow = (): NativeRow | undefined => dbB.prepare(
      "SELECT id,name,workspace_id,path FROM projects WHERE id=?").get(project.id) as NativeRow | undefined;
    const ownerRow = (): unknown => dbB.prepare(
      "SELECT owner_node_id FROM sharing_resource_owners WHERE kind='project' AND resource_id=?").get(project.id);
    const versionRow = (): unknown => dbB.prepare(
      "SELECT revision,payload FROM cluster_v2_project_metadata_versions WHERE owner_node_id=? AND project_id=?")
      .get(nodeA.nodeId, project.id);
    const receipts = (): unknown[] => dbB.prepare(
      "SELECT * FROM cluster_v2_project_metadata_receipts WHERE owner_node_id=? AND project_id=? ORDER BY rowid")
      .all(nodeA.nodeId, project.id);
    const raw = (method: string, endpoint: string, body?: unknown): Promise<Response> => fetch(`${nodeB.url}/api${endpoint}`, {
      method,
      headers: { Cookie: sessionB.cookie, "x-csrf-token": sessionB.csrfToken, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const retainedNative = nativeRow()!;
    assert.equal(retainedNative.name, "Latest retained metadata");
    assert.equal((versionRow() as { revision: number }).revision, newerEnvelope.revision);
    const retainedOwner = ownerRow();
    assert.equal((retainedOwner as { owner_node_id: string }).owner_node_id, nodeA.nodeId);

    assert.equal((await raw("DELETE", `/projects/${project.id}`)).status, 204);
    assert.equal(nativeRow(), undefined);
    assert.deepEqual(ownerRow(), retainedOwner, "native deletion must retain remote ownership");
    assert.equal((versionRow() as { revision: number }).revision, newerEnvelope.revision);
    assert.equal((await signedMetadataPost(nodeA, nodeB, newerEnvelope)).status, 200);
    assert.deepEqual(nativeRow(), retainedNative, "same-version delivery must reconstruct the native replica");

    assert.equal((await raw("DELETE", `/projects/${project.id}`)).status, 204);
    assert.equal((await signedMetadataPost(nodeA, nodeB, originalEnvelope)).status, 200);
    assert.deepEqual(nativeRow(), retainedNative, "lower-version delivery must reconstruct from highest retained payload");
    assert.equal((versionRow() as { revision: number }).revision, newerEnvelope.revision);

    assert.equal((await raw("DELETE", `/projects/${project.id}`)).status, 204);
    const workspaceId = retainedNative.workspace_id;
    assert.equal((await raw("DELETE", `/workspaces/${workspaceId}`)).status, 204);
    assert.equal(dbB.prepare("SELECT 1 FROM cluster_v2_project_workspaces WHERE workspace_id=?").get(workspaceId), undefined);
    assert.equal((await raw("PUT", "/workspaces", { id: workspaceId, label: "Private replacement" })).status, 200);

    const privateWorkspace = dbB.prepare("SELECT id,label FROM workspaces WHERE id=?").get(workspaceId);
    const beforeConflict = { owner: ownerRow(), version: versionRow(), receipts: receipts() };
    const finalEnvelope = {
      ...newerEnvelope, revision: newerEnvelope.revision + 1,
      metadata: { ...newerEnvelope.metadata, name: "Must not be adopted" },
    };
    assert.equal((await signedMetadataPost(nodeA, nodeB, finalEnvelope)).status, 409);
    assert.equal(nativeRow(), undefined);
    assert.deepEqual(dbB.prepare("SELECT id,label FROM workspaces WHERE id=?").get(workspaceId), privateWorkspace);
    assert.equal(dbB.prepare("SELECT 1 FROM cluster_v2_project_workspaces WHERE workspace_id=?").get(workspaceId), undefined);
    assert.deepEqual({ owner: ownerRow(), version: versionRow(), receipts: receipts() }, beforeConflict);
    assert.equal((ownerRow() as { owner_node_id: string }).owner_node_id, nodeA.nodeId);
  } finally {
    for (const database of databases) database.close();
    await Promise.all([...children].map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});

test("another admitted member cannot forge original-owner project metadata", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-metadata-sender-"));
  const children = new Set<Child>();
  const databases = new Set<DatabaseSync>();
  try {
    const environments = await Promise.all(["a", "b", "d"].map((name) => seedDevEnvironment(path.join(root, name), 1)));
    const [nodeA, nodeB, nodeD] = environments.map((environment) => environment.nodes[0]);
    const childA = await startDevNode(environments[0], nodeA); children.add(childA);
    const childB = await startDevNode(environments[1], nodeB); children.add(childB);
    const childD = await startDevNode(environments[2], nodeD); children.add(childD);
    const [sessionA, sessionB, sessionD] = await Promise.all(environments.map((environment, index) =>
      signIn(environment, [nodeA, nodeB, nodeD][index])));
    const clusterId = await createCluster(nodeA, sessionA);
    await join(nodeA, sessionA, nodeB, sessionB, clusterId);
    await join(nodeA, sessionA, nodeD, sessionD, clusterId);
    const created = await api<{ project: Project }>(nodeA, sessionA, "POST", "/projects", {
      name: "Owned P", type: "personal", synced: false,
    });
    assert.equal(created.status, 201);
    const project = created.body.project;
    assert.equal((await api(nodeA, sessionA, "PUT", `/sharing/project/${project.id}`, {
      expectedGeneration: 1, shares: [{ clusterId, projectId: null }],
    })).status, 200);
    await waitForProject(nodeB, sessionB, project.id);

    await stopDevNode(childA); children.delete(childA);
    await stopDevNode(childD); children.delete(childD);
    const dbA = new DatabaseSync(path.join(nodeA.dataDir, "node.db")); databases.add(dbA);
    const dbB = new DatabaseSync(path.join(nodeB.dataDir, "node.db")); databases.add(dbB);
    const statementRow = dbA.prepare(`SELECT statement FROM cluster_v2_resource_contexts
      WHERE kind='project' AND resource_id=? AND recipient_id=? AND active=1 ORDER BY rowid DESC LIMIT 1`)
      .get(project.id, nodeB.nodeId) as { statement: string };
    const version = dbA.prepare(`SELECT revision,payload FROM cluster_v2_project_metadata_versions
      WHERE owner_node_id=? AND project_id=?`).get(nodeA.nodeId, project.id) as { revision: number; payload: string };
    const envelope = {
      statement: JSON.parse(statementRow.statement), revision: version.revision + 1,
      metadata: { ...JSON.parse(version.payload), name: "forged metadata" },
    };
    const projectBefore = dbB.prepare("SELECT * FROM projects WHERE id=?").get(project.id);
    const versionBefore = dbB.prepare("SELECT * FROM cluster_v2_project_metadata_versions WHERE owner_node_id=? AND project_id=?")
      .get(nodeA.nodeId, project.id);
    const receiptsBefore = dbB.prepare("SELECT * FROM cluster_v2_project_metadata_receipts WHERE owner_node_id=? AND project_id=? ORDER BY rowid")
      .all(nodeA.nodeId, project.id);

    assert.equal((await signedMetadataPost(nodeD, nodeB, envelope)).status, 403);
    assert.deepEqual(dbB.prepare("SELECT * FROM projects WHERE id=?").get(project.id), projectBefore);
    assert.deepEqual(dbB.prepare("SELECT * FROM cluster_v2_project_metadata_versions WHERE owner_node_id=? AND project_id=?")
      .get(nodeA.nodeId, project.id), versionBefore);
    assert.deepEqual(dbB.prepare("SELECT * FROM cluster_v2_project_metadata_receipts WHERE owner_node_id=? AND project_id=? ORDER BY rowid")
      .all(nodeA.nodeId, project.id), receiptsBefore);

    assert.equal((await signedMetadataPost(nodeA, nodeB, envelope)).status, 200);
    const updated = await waitForProject(nodeB, sessionB, project.id);
    assert.equal(updated.name, "forged metadata");
    assert.equal(updated.ownerNodeId, nodeA.nodeId);
  } finally {
    for (const database of databases) database.close();
    await Promise.all([...children].map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
