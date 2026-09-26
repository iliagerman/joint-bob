import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { applyResourcePolicy, type SignedResourcePolicy } from "../src/cluster-sharing.js";
import { isTrustedTwin } from "../src/cluster-sharing-policy.js";
import {
  api, freePort, seedDevEnvironment, signIn, startDevNode, stopDevNode,
  type SeededNode, type SignedIn,
} from "./dev-nodes.js";

interface ClusterStatus {
  clusters: Array<{ id: string; members: Array<{ nodeId: string }> }>;
  mode: "legacy" | "selective";
}
interface TwinView {
  relationshipId: string;
  peer: { nodeId: string; publicKey: string; fingerprint: string };
  status: "pending" | "active" | "revoked";
  pendingDeliveries: number;
}
interface TwinInvitationLink {
  invitation: { body: { relationshipId: string }; secret: string };
  endpoint: { nodeId: string; name: string; url: string };
  endpointSignature: string;
}
interface ProjectResponse { project: { id: string; name: string; path: string; type: string; createdAt: string; updatedAt: string } }

type Child = Awaited<ReturnType<typeof startDevNode>>;

function dbFor(node: SeededNode): DatabaseSync {
  return new DatabaseSync(path.join(node.dataDir, "node.db"));
}

function decodeTwinLink(link: string): TwinInvitationLink {
  const encoded = new URL(link).hash.slice(1).split(".")[1];
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as TwinInvitationLink;
}

function replaceTwinLink(link: string, origin: string, changeEndpoint: boolean): string {
  const result = new URL(link);
  const payload = decodeTwinLink(link);
  if (changeEndpoint) payload.endpoint.url = origin;
  result.protocol = new URL(origin).protocol;
  result.host = new URL(origin).host;
  result.hash = `twin-v2.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return result.toString();
}

async function clusters(node: SeededNode, session: SignedIn): Promise<ClusterStatus> {
  const response = await api<ClusterStatus>(node, session, "GET", "/clusters");
  assert.equal(response.status, 200);
  return response.body;
}

function membershipShape(status: ClusterStatus): Array<[string, string[]]> {
  return status.clusters.map((cluster) => [cluster.id, cluster.members.map((member) => member.nodeId).sort()] as [string, string[]])
    .sort((left, right) => left[0].localeCompare(right[0]));
}

async function createProject(node: SeededNode, session: SignedIn, root: string, name: string): Promise<ProjectResponse["project"]> {
  const projectPath = path.join(root, name.toLowerCase().replaceAll(" ", "-"));
  await mkdir(projectPath, { recursive: true });
  const response = await api<ProjectResponse>(node, session, "POST", "/projects", {
    name, type: "personal", path: projectPath, synced: false,
  });
  assert.equal(response.status, 201, `creating ${name} returned ${response.status}`);
  return response.body.project;
}

async function twinApi<T>(node: SeededNode, session: SignedIn, method: string, endpoint: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${node.url}/api${endpoint}`, {
    method,
    headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  const parsed = response.headers.get("content-type")?.includes("application/json") && text ? JSON.parse(text) : undefined;
  return { status: response.status, body: parsed as T };
}

async function twins(node: SeededNode, session: SignedIn): Promise<TwinView[]> {
  const response = await twinApi<{ relationships: TwinView[] }>(node, session, "GET", "/twins");
  assert.equal(response.status, 200, `listing twins returned ${response.status}`);
  return response.body.relationships;
}

async function poll(assertion: () => Promise<void>, deadlineMs = 20_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { await assertion(); return; } catch (error) { lastError = error; }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw lastError;
}

function deliveryStatements(db: DatabaseSync): SignedResourcePolicy[] {
  // Delivery rows disappear after acknowledgement; signed emissions remain durable.
  return (db.prepare("SELECT statement FROM cluster_v2_resource_contexts WHERE json_extract(statement,'$.body.ownerNodeId')=(SELECT id FROM cluster_node LIMIT 1)").all() as Array<{ statement: string }>)
    .map((row) => JSON.parse(row.statement) as SignedResourcePolicy);
}

async function rawCookiePost(node: SeededNode, session: SignedIn, endpoint: string, body: unknown): Promise<Response> {
  return fetch(`${node.url}/api${endpoint}`, {
    method: "POST",
    headers: { Cookie: session.cookie, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function listenFixture(): Promise<{ server: Server; origin: string; requests: () => number }> {
  const port = await freePort();
  let count = 0;
  const server = createServer((request, response) => {
    count++;
    request.resume();
    response.writeHead(503, { "Content-Type": "application/json" });
    response.end('{"error":"fixture"}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return { server, origin: `http://127.0.0.1:${port}`, requests: () => count };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("HTTP twins require consent, bootstrap only owned policies, and revoke durably without leaving clusters", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-twins-http-"));
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

    const createdX = await api<{ snapshot: { body: { clusterId: string } } }>(nodeA, sessionA, "POST", "/clusters", { name: "X" });
    const createdY = await api<{ snapshot: { body: { clusterId: string } } }>(nodeB, sessionB, "POST", "/clusters", { name: "Y" });
    assert.equal(createdX.status, 201); assert.equal(createdY.status, 201);
    const clusterX = createdX.body.snapshot.body.clusterId;
    const invitationX = await api<{ link: string }>(nodeA, sessionA, "POST", `/clusters/${clusterX}/invitations`, { expectedEpoch: 1 });
    assert.equal(invitationX.status, 201);
    const joined = await api(nodeB, sessionB, "POST", "/clusters/join", { link: invitationX.body.link, requestId: randomUUID() });
    assert.ok([200, 201].includes(joined.status), `joining X returned ${joined.status}`);
    const membershipsBeforeA = membershipShape(await clusters(nodeA, sessionA));
    const membershipsBeforeB = membershipShape(await clusters(nodeB, sessionB));

    const projectP = await createProject(nodeA, sessionA, root, "Project P");
    const sharedP = await api(nodeA, sessionA, "PUT", `/sharing/project/${projectP.id}`, {
      expectedGeneration: 1, shares: [{ clusterId: clusterX, projectId: null }],
    });
    assert.equal(sharedP.status, 200);
    const privateQ = await createProject(nodeA, sessionA, root, "Private Q");
    const ownedR = await createProject(nodeB, sessionB, root, "Owned R");

    const dbA = dbFor(nodeA), dbB = dbFor(nodeB); databases.add(dbA); databases.add(dbB);
    const publicP = deliveryStatements(dbA).find((statement) => statement.body.resourceId === projectP.id
      && statement.body.recipientNodeId === nodeB.nodeId && statement.body.context.kind === "cluster");
    assert.ok(publicP, "A must have an A-signed public P policy addressed to B");
    applyResourcePolicy(dbB, nodeB.nodeId, nodeA.nodeId, publicP);
    await poll(async () => {
      assert.ok(dbB.prepare("SELECT 1 FROM projects WHERE id=?").get(projectP.id), "shared project metadata must arrive on B");
    });

    const deniedInvitation = await twinApi(nodeA, sessionA, "POST", "/twins/invitations", {});
    assert.equal(deniedInvitation.status, 400);
    assert.deepEqual(await twins(nodeA, sessionA), []);
    const invitation = await twinApi<{ link: string; relationshipId: string }>(nodeA, sessionA, "POST", "/twins/invitations", { confirmOwnedData: true });
    assert.equal(invitation.status, 201);
    assert.equal(typeof invitation.body.link, "string");
    assert.equal(decodeTwinLink(invitation.body.link).invitation.body.relationshipId, invitation.body.relationshipId);

    const deniedAcceptance = await twinApi(nodeB, sessionB, "POST", "/twins/accept", { link: invitation.body.link });
    assert.equal(deniedAcceptance.status, 400);
    assert.deepEqual(await twins(nodeB, sessionB), []);
    const accepted = await twinApi<{ relationshipId: string; status: string }>(nodeB, sessionB, "POST", "/twins/accept", {
      link: invitation.body.link, confirmOwnedData: true,
    });
    assert.equal(accepted.status, 201);
    assert.deepEqual(accepted.body, { relationshipId: invitation.body.relationshipId, status: "active" });
    await poll(async () => {
      for (const [node, session] of [[nodeA, sessionA], [nodeB, sessionB]] as const) {
        const listed = await twins(node, session);
        assert.equal(listed.length, 1);
        assert.equal(listed[0].relationshipId, invitation.body.relationshipId);
        assert.equal(listed[0].status, "active");
      }
    });
    assert.deepEqual(membershipShape(await clusters(nodeA, sessionA)), membershipsBeforeA);
    assert.deepEqual(membershipShape(await clusters(nodeB, sessionB)), membershipsBeforeB);

    const twinA = deliveryStatements(dbA).filter((statement) => statement.body.context.kind === "twin" && statement.body.context.id === invitation.body.relationshipId);
    const twinB = deliveryStatements(dbB).filter((statement) => statement.body.context.kind === "twin" && statement.body.context.id === invitation.body.relationshipId);
    assert.ok(twinA.some((statement) => statement.body.resourceId === privateQ.id && statement.body.ownerNodeId === nodeA.nodeId && statement.body.recipientNodeId === nodeB.nodeId));
    assert.ok(twinB.some((statement) => statement.body.resourceId === ownedR.id && statement.body.ownerNodeId === nodeB.nodeId && statement.body.recipientNodeId === nodeA.nodeId));
    assert.equal(twinB.some((statement) => statement.body.resourceId === projectP.id), false, "received P must not bootstrap as B-owned");
    const twinQ = twinA.find((statement) => statement.body.resourceId === privateQ.id)!;
    applyResourcePolicy(dbB, nodeB.nodeId, nodeA.nodeId, twinQ);

    dbA.close(); databases.delete(dbA);
    await stopDevNode(childA); children.delete(childA);
    const revoked = await twinApi<{ relationshipId: string; status: string; pending: boolean }>(nodeB, sessionB, "DELETE", `/twins/${invitation.body.relationshipId}`);
    assert.equal(revoked.status, 200);
    assert.deepEqual(revoked.body, { relationshipId: invitation.body.relationshipId, status: "revoked", pending: true });
    assert.equal(isTrustedTwin(dbB, nodeB.nodeId, nodeA.nodeId), false);
    assert.equal((dbB.prepare("SELECT active FROM cluster_v2_resource_contexts WHERE resource_id=? AND context_kind='twin' AND context_id=?").get(privateQ.id, invitation.body.relationshipId) as { active: number }).active, 0);
    assert.equal((dbB.prepare("SELECT active FROM cluster_v2_resource_contexts WHERE resource_id=? AND context_kind='cluster' AND context_id=?").get(projectP.id, clusterX) as { active: number }).active, 1);
    assert.deepEqual(membershipShape(await clusters(nodeB, sessionB)), membershipsBeforeB);
    const afterRevocation = await createProject(nodeB, sessionB, root, "Owned After Revocation");
    assert.equal(deliveryStatements(dbB).some((statement) => statement.body.resourceId === afterRevocation.id
      && statement.body.context.kind === "twin" && statement.body.context.id === invitation.body.relationshipId
      && statement.body.operation === "upsert"), false);

    dbB.close(); databases.delete(dbB);
    const restartedA = await startDevNode(environmentA, nodeA); children.add(restartedA);
    await poll(async () => {
      const [viewA, viewB] = await Promise.all([twins(nodeA, sessionA), twins(nodeB, sessionB)]);
      assert.equal(viewA[0]?.status, "revoked"); assert.equal(viewA[0]?.pendingDeliveries, 0);
      assert.equal(viewB[0]?.status, "revoked"); assert.equal(viewB[0]?.pendingDeliveries, 0);
    });
    assert.deepEqual(membershipShape(await clusters(nodeA, sessionA)), membershipsBeforeA);
    assert.deepEqual(membershipShape(await clusters(nodeB, sessionB)), membershipsBeforeB);
  } finally {
    for (const database of databases) database.close();
    await Promise.all([...children].map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});

test("twin acceptance rejects a valid certificate for another relationship", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-twin-response-binding-"));
  const children = new Set<Child>();
  let fixture: Server | undefined;
  try {
    const [environmentA, environmentB, environmentC] = await Promise.all([
      seedDevEnvironment(path.join(root, "a"), 1),
      seedDevEnvironment(path.join(root, "b"), 1),
      seedDevEnvironment(path.join(root, "c"), 1),
    ]);
    const nodeA = environmentA.nodes[0], nodeB = environmentB.nodes[0], nodeC = environmentC.nodes[0];
    const childA = await startDevNode(environmentA, nodeA); children.add(childA);
    const childB = await startDevNode(environmentB, nodeB); children.add(childB);
    const childC = await startDevNode(environmentC, nodeC); children.add(childC);
    const [sessionA, sessionB, sessionC] = await Promise.all([
      signIn(environmentA, nodeA), signIn(environmentB, nodeB), signIn(environmentC, nodeC),
    ]);

    const invitationCB = await twinApi<{ link: string; relationshipId: string }>(nodeC, sessionC, "POST", "/twins/invitations", { confirmOwnedData: true });
    assert.equal(invitationCB.status, 201);
    const acceptedCB = await twinApi(nodeB, sessionB, "POST", "/twins/accept", { link: invitationCB.body.link, confirmOwnedData: true });
    assert.equal(acceptedCB.status, 201);
    const dbB = dbFor(nodeB);
    const certificateRow = dbB.prepare(`SELECT body,acceptor_signature,inviter_signature
      FROM cluster_v2_twin_relationships WHERE relationship_id=?`).get(invitationCB.body.relationshipId) as {
        body: string; acceptor_signature: string; inviter_signature: string;
      };
    dbB.close();
    const certificate = {
      body: JSON.parse(certificateRow.body),
      acceptorSignature: certificateRow.acceptor_signature,
      inviterSignature: certificateRow.inviter_signature,
    };

    const port = await freePort();
    fixture = createServer((request, response) => {
      request.resume();
      response.writeHead(201, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ certificate }));
    });
    await new Promise<void>((resolve, reject) => {
      fixture!.once("error", reject);
      fixture!.listen(port, "127.0.0.1", resolve);
    });
    const fixtureOrigin = `http://127.0.0.1:${port}`;
    const updatedA = await api(nodeA, sessionA, "PUT", "/cluster/node", { name: nodeA.name, url: fixtureOrigin });
    assert.equal(updatedA.status, 200);
    const invitationAB = await twinApi<{ link: string; relationshipId: string }>(nodeA, sessionA, "POST", "/twins/invitations", { confirmOwnedData: true });
    assert.equal(invitationAB.status, 201);

    const rejected = await twinApi<{ status?: string }>(nodeB, sessionB, "POST", "/twins/accept", {
      link: invitationAB.body.link, confirmOwnedData: true,
    });
    assert.equal(rejected.status, 503, `unrelated valid certificate returned ${rejected.status}`);
    assert.notEqual(rejected.body.status, "active", "response claimed the A/B relationship was active");
    const relationshipsB = await twins(nodeB, sessionB);
    assert.equal(relationshipsB.find((relationship) => relationship.relationshipId === invitationAB.body.relationshipId)?.status, "pending");
    assert.equal(relationshipsB.find((relationship) => relationship.relationshipId === invitationCB.body.relationshipId)?.status, "active");
  } finally {
    if (fixture) await closeServer(fixture);
    await Promise.all([...children].map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});

test("twin endpoint substitution and cookie bootstrap cannot bypass proof", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-twin-binding-"));
  const children = new Set<Child>();
  let fixture: Awaited<ReturnType<typeof listenFixture>> | undefined;
  try {
    const [environmentA, environmentB] = await Promise.all([
      seedDevEnvironment(path.join(root, "a"), 1), seedDevEnvironment(path.join(root, "b"), 1),
    ]);
    const nodeA = environmentA.nodes[0], nodeB = environmentB.nodes[0];
    const childA = await startDevNode(environmentA, nodeA); children.add(childA);
    const childB = await startDevNode(environmentB, nodeB); children.add(childB);
    const [sessionA, sessionB] = await Promise.all([signIn(environmentA, nodeA), signIn(environmentB, nodeB)]);
    const invitation = await twinApi<{ link: string; relationshipId: string }>(nodeA, sessionA, "POST", "/twins/invitations", { confirmOwnedData: true });
    assert.equal(invitation.status, 201);
    fixture = await listenFixture();

    for (const changeEndpoint of [false, true]) {
      const substituted = replaceTwinLink(invitation.body.link, fixture.origin, changeEndpoint);
      const rejected = await twinApi(nodeB, sessionB, "POST", "/twins/accept", { link: substituted, confirmOwnedData: true });
      assert.equal(rejected.status, 401, `endpoint substitution (${changeEndpoint}) returned ${rejected.status}`);
      assert.equal(fixture.requests(), 0, "invalid endpoint binding made a network request");
      assert.deepEqual(await twins(nodeB, sessionB), []);
      const dbB = dbFor(nodeB);
      assert.equal((dbB.prepare("SELECT count(*) count FROM cluster_v2_public_keys WHERE node_id=?").get(nodeA.nodeId) as { count: number }).count, 0);
      assert.equal((dbB.prepare("SELECT count(*) count FROM cluster_v2_twin_relationships").get() as { count: number }).count, 0);
      assert.equal((await clusters(nodeB, sessionB)).mode, "legacy", "invalid link activated selective mode");
      dbB.close();
    }

    const accepted = await twinApi(nodeB, sessionB, "POST", "/twins/accept", { link: invitation.body.link, confirmOwnedData: true });
    assert.equal(accepted.status, 201);
    const payload = decodeTwinLink(invitation.body.link);
    const dbB = dbFor(nodeB);
    const row = dbB.prepare("SELECT body,acceptor_signature FROM cluster_v2_twin_relationships WHERE relationship_id=?")
      .get(invitation.body.relationshipId) as { body: string; acceptor_signature: string };
    dbB.close();
    const acceptance = { body: JSON.parse(row.body), acceptorSignature: row.acceptor_signature };
    const cookieOnly = await rawCookiePost(nodeA, sessionA, "/cluster/v2/twins/confirm", {
      acceptance,
      acceptor: { nodeId: nodeB.nodeId, name: nodeB.name, url: nodeB.url },
      secret: payload.invitation.secret,
    });
    assert.equal(cookieOnly.status, 401, `cookie-only twin bootstrap returned ${cookieOnly.status}`);
    await cookieOnly.body?.cancel();
    const relationshipA = dbFor(nodeA);
    assert.equal((relationshipA.prepare("SELECT count(*) count FROM cluster_v2_twin_relationships WHERE relationship_id=?").get(invitation.body.relationshipId) as { count: number }).count, 1, "cookie-only confirm changed relationship count");
    relationshipA.close();
  } finally {
    if (fixture) await closeServer(fixture.server);
    await Promise.all([...children].map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
