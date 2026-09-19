import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { appVersion } from "../src/changelog.js";
import { getClusterNode, saveClusterPeer } from "../src/cluster.js";
import { getOrCreateClusterIdentity } from "../src/cluster-identity.js";
import { recordPeerEndpoint } from "../src/cluster-peer-endpoints.js";
import { verifyClusterRequest } from "../src/cluster-protocol.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { applyTwinCertificate, confirmTwinAcceptance, createTwinInvitation, prepareTwinAcceptance, revokeTwinRelationship } from "../src/cluster-twins.js";

const B = "00000000-0000-4000-8000-000000000102";
const C = "00000000-0000-4000-8000-000000000103";
const D = "00000000-0000-4000-8000-000000000104";
const E = "00000000-0000-4000-8000-000000000105";
const releasePayload = { tag_name: `v${appVersion()}`, draft: false, prerelease: false, assets: [
  { name: "joint-bob.tar.gz", browser_download_url: "https://example.invalid/release.tar.gz" },
  { name: "joint-bob.tar.gz.sha256", browser_download_url: "https://example.invalid/release.tar.gz.sha256" },
] };

type TestServer = ReturnType<typeof createServer>;
type FleetRun = { state: string };

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<{ server: TestServer; url: string }> {
  const server = createServer((request, response) => { void handler(request, response); });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No test server address");
    resolve({ server, url: `http://127.0.0.1:${address.port}` });
  }));
}

function close(server: TestServer): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function terminal(run: FleetRun): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (run.state === "running" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.notEqual(run.state, "running", "fleet run did not settle");
}

test("fleet dispatch uses only direct active twins, signed exact acknowledgements, and serialized starts", { timeout: 30_000 }, async (t) => {
  const oldRelease = process.env.JOINT_BOB_RELEASE;
  const oldApi = process.env.JOINT_BOB_RELEASE_API;
  const servers: TestServer[] = [];
  const databases: DatabaseSync[] = [];
  const runs: FleetRun[] = [];
  let releaseHealth: () => void = () => {};
  let healthGate: Promise<void> | undefined;
  let healthHook = () => {};

  t.after(async () => {
    releaseHealth();
    healthGate = undefined;
    healthHook = () => {};
    await Promise.allSettled(runs.map(terminal));
    await Promise.allSettled(servers.map(close));
    for (const database of databases) database.close();
    if (oldRelease === undefined) delete process.env.JOINT_BOB_RELEASE; else process.env.JOINT_BOB_RELEASE = oldRelease;
    if (oldApi === undefined) delete process.env.JOINT_BOB_RELEASE_API; else process.env.JOINT_BOB_RELEASE_API = oldApi;
  });

  let feedRequests = 0;
  const feed = await listen((_request, response) => {
    feedRequests++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(releasePayload));
  });
  servers.push(feed.server);
  process.env.JOINT_BOB_RELEASE = "a".repeat(40);
  process.env.JOINT_BOB_RELEASE_API = feed.url;
  const updater = await import(`../src/updater.js?fleet=${Date.now()}`);
  const local = await getClusterNode();
  const dbA = await clusterV2Database();
  const dbB = new DatabaseSync(":memory:");
  const dbC = new DatabaseSync(":memory:");
  const dbD = new DatabaseSync(":memory:");
  const dbE = new DatabaseSync(":memory:");
  databases.push(dbB, dbC, dbD, dbE);
  getOrCreateClusterIdentity(dbB, B);
  getOrCreateClusterIdentity(dbC, C);
  getOrCreateClusterIdentity(dbD, D);
  getOrCreateClusterIdentity(dbE, E);

  let cRequests = 0;
  const legacyC = await listen((request, response) => {
    cRequests++;
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/health") response.end(JSON.stringify({ version: appVersion() }));
    else { response.statusCode = 404; response.end("{}"); }
  });
  servers.push(legacyC.server);
  await saveClusterPeer({ id: C, name: "Legacy C", url: legacyC.url, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), invitedByNodeId: local.id, token: "fixture-token", pairedAt: new Date().toISOString(), lastSeenAt: null });

  const bcInvite = createTwinInvitation(dbB, B);
  const bcAccept = prepareTwinAcceptance(dbC, C, bcInvite, bcInvite.body.inviter.fingerprint);
  applyTwinCertificate(dbC, C, confirmTwinAcceptance(dbB, B, bcAccept, bcInvite.secret));

  let dRequests = 0;
  const pendingD = await listen((_request, response) => {
    dRequests++;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ version: appVersion() }));
  });
  servers.push(pendingD.server);
  const pendingInvitation = createTwinInvitation(dbD, D);
  const pendingAcceptance = prepareTwinAcceptance(dbA, local.id, pendingInvitation, pendingInvitation.body.inviter.fingerprint);
  recordPeerEndpoint(dbA, { kind: "twin", id: pendingAcceptance.body.relationshipId }, { nodeId: D, name: "Pending D", url: pendingD.url });

  let peerVersion = appVersion();
  let posts = 0;
  let relationshipId = "";
  let acknowledgementTarget = appVersion();
  const verificationErrors: string[] = [];
  const peer = await listen(async (request, response) => {
    if (request.url === "/api/health") {
      healthHook();
      const gate = healthGate;
      if (gate) await gate;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ version: peerVersion }));
      return;
    }
    if (request.url === "/api/cluster/v2/update/install" && request.method === "POST") {
      posts++;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      try {
        assert.equal(request.headers.authorization?.startsWith("Bearer "), false);
        assert.equal(verifyClusterRequest(dbB, B, "POST", request.url, raw, request.headers.authorization), local.id);
        assert.deepEqual(JSON.parse(raw.toString()), { relationshipId, version: appVersion() });
      } catch (error) {
        verificationErrors.push(error instanceof Error ? error.message : String(error));
        response.statusCode = 401;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: "invalid request" }));
        return;
      }
      peerVersion = appVersion();
      response.statusCode = 202;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ accepted: true, jobId: randomUUID(), targetVersion: acknowledgementTarget }));
      return;
    }
    response.statusCode = 404;
    response.setHeader("content-type", "application/json");
    response.end("{}");
  });
  servers.push(peer.server);

  const pair = (): void => {
    const invitation = createTwinInvitation(dbA, local.id);
    const acceptance = prepareTwinAcceptance(dbB, B, invitation, invitation.body.inviter.fingerprint);
    const certificate = confirmTwinAcceptance(dbA, local.id, acceptance, invitation.secret);
    applyTwinCertificate(dbB, B, certificate);
    relationshipId = certificate.body.relationshipId;
    recordPeerEndpoint(dbA, { kind: "twin", id: relationshipId }, { nodeId: B, name: "Twin B", url: peer.url });
  };
  pair();

  await t.test("excludes legacy, transitive, and pending nodes and keeps local last", async () => {
    cRequests = 0;
    dRequests = 0;
    const run = await updater.startFleetUpdate();
    runs.push(run);
    await terminal(run);
    assert.deepEqual(run.entries.map((entry) => entry.nodeId), [B, local.id]);
    assert.equal(cRequests, 0);
    assert.equal(dRequests, 0);
    assert.equal(posts, 0);
    assert.equal(updater.recentUpdateJobs().length, 0);
    assert.equal(run.state, "succeeded");
  });

  await t.test("dispatches a signed request and requires the exact 202 acknowledgement", async () => {
    peerVersion = "0.0.1";
    posts = 0;
    verificationErrors.length = 0;
    acknowledgementTarget = appVersion();
    const run = await updater.startFleetUpdate();
    runs.push(run);
    await terminal(run);
    assert.equal(posts, 1);
    assert.deepEqual(verificationErrors, []);
    assert.equal(run.state, "succeeded");
    assert.equal(updater.recentUpdateJobs().length, 0);
  });

  await t.test("rejects a mismatched 202 acknowledgement", async () => {
    peerVersion = "0.0.1";
    posts = 0;
    acknowledgementTarget = "0.0.2";
    try {
      const run = await updater.startFleetUpdate();
      runs.push(run);
      await terminal(run);
      assert.equal(posts, 1);
      assert.equal(run.state, "failed");
      assert.match(run.entries[0].error ?? "", /acknowledg|target/i);
    } finally {
      acknowledgementTarget = appVersion();
    }
  });

  await t.test("refuses a newer active twin without dispatching or installing locally", async () => {
    peerVersion = "999.0.0";
    posts = 0;
    const run = await updater.startFleetUpdate();
    runs.push(run);
    await terminal(run);
    assert.equal(run.entries[0].nodeId, B);
    assert.equal(run.state, "failed");
    assert.match(run.entries[0].error ?? "", /newer/i);
    assert.equal(posts, 0);
    assert.equal(updater.recentUpdateJobs().length, 0);
  });

  await t.test("revalidates the relationship after health", async () => {
    peerVersion = "0.0.1";
    posts = 0;
    let hookCalled = false;
    healthHook = () => {
      healthHook = () => {};
      hookCalled = true;
      revokeTwinRelationship(dbA, local.id, relationshipId);
    };
    try {
      const run = await updater.startFleetUpdate();
      runs.push(run);
      await terminal(run);
      assert.equal(hookCalled, true);
      assert.equal(run.entries[0].nodeId, B);
      assert.equal(run.state, "failed");
      assert.match(run.entries[0].error ?? "", /relationship|twin|authoriz/i);
      assert.equal(posts, 0);
    } finally {
      healthHook = () => {};
      if (hookCalled) {
        revokeTwinRelationship(dbB, B, relationshipId);
        pair();
      }
    }
  });

  await t.test("serializes concurrent starts across feed lookup", async () => {
    peerVersion = appVersion();
    feedRequests = 0;
    healthGate = new Promise<void>((resolve) => { releaseHealth = resolve; });
    const settledRuns: FleetRun[] = [];
    try {
      const results = await Promise.allSettled([updater.startFleetUpdate(), updater.startFleetUpdate()]);
      for (const result of results) {
        if (result.status === "fulfilled") {
          runs.push(result.value);
          settledRuns.push(result.value);
        }
      }
      assert.equal(feedRequests >= 1, true);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected" && /already running/.test(String(result.reason))).length, 1);
    } finally {
      releaseHealth();
      releaseHealth = () => {};
      healthGate = undefined;
      await Promise.allSettled(settledRuns.map(terminal));
    }
  });

  await t.test("marks an endpoint-less active twin failed without rejecting fleet startup", async () => {
    const invitation = createTwinInvitation(dbA, local.id);
    const acceptance = prepareTwinAcceptance(dbE, E, invitation, invitation.body.inviter.fingerprint);
    const certificate = confirmTwinAcceptance(dbA, local.id, acceptance, invitation.secret);
    applyTwinCertificate(dbE, E, certificate);
    const run = await updater.startFleetUpdate();
    runs.push(run);
    await terminal(run);
    const missing = run.entries.find((entry) => entry.nodeId === E);
    assert.ok(missing, "active twin remains visible in the fleet run");
    assert.equal(run.state, "failed");
    assert.equal(missing.state, "failed");
    assert.match(missing.error ?? "", /configured endpoint/i);
  });
});
