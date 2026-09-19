import assert from "node:assert/strict";
import { createDecipheriv, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { signClusterRequest } from "../src/cluster-protocol.js";
import {
  api, seedDevEnvironment, signIn, startDevNode, stopDevNode,
  type DevEnvironment, type SeededNode, type SignedIn,
} from "./dev-nodes.js";

const isolatedServerEnv = {
  AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "", AWS_SESSION_TOKEN: "", AWS_PROFILE: "",
  GOOGLE_APPLICATION_CREDENTIALS: "", AZURE_CLIENT_ID: "", AZURE_CLIENT_SECRET: "", AZURE_TENANT_ID: "",
};
type Child = Awaited<ReturnType<typeof startDevNode>>;

async function legacyToken(node: SeededNode): Promise<string> {
  const key = Buffer.from((await readFile(path.join(node.dataDir, "secret.key"), "utf8")).trim(), "base64");
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT token FROM cluster_machine_credentials WHERE singleton = 1").get() as { token: string };
    const [iv, tag, encrypted] = row.token.split(".");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
  } finally { db.close(); }
}

function machinePost(node: SeededNode, token: string, endpoint: string, body: unknown): Promise<Response> {
  return fetch(`${node.url}/api${endpoint}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function updateJobCount(node: SeededNode): number {
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"), { readOnly: true });
  try {
    return (db.prepare("SELECT count(*) AS count FROM update_jobs").get() as { count: number }).count;
  } finally { db.close(); }
}

async function removeFixture(root: string, children: Child[]): Promise<void> {
  await Promise.all(children.map(stopDevNode));
  await rm(root, { recursive: true, force: true });
}

test("legacy cluster peers cannot request remote update installation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-update-peer-"));
  const children: Child[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const [nodeA, nodeB] = environment.nodes;
    children.push(await startDevNode(environment, nodeA, isolatedServerEnv), await startDevNode(environment, nodeB, isolatedServerEnv));
    const response = await machinePost(nodeB, await legacyToken(nodeA), "/cluster/update/install", { version: "99.0.0" });
    assert.equal(response.status, 403, "an ordinary paired peer must be forbidden before installer eligibility checks");
    assert.equal(updateJobCount(nodeB), 0, "a denied update must not create an update job");
  } finally { await removeFixture(root, children); }
});

test("legacy cluster peers cannot fence a node for update preparation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-prepare-peer-"));
  const children: Child[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const [nodeA, nodeB] = environment.nodes;
    children.push(await startDevNode(environment, nodeA, isolatedServerEnv), await startDevNode(environment, nodeB, isolatedServerEnv));
    const response = await machinePost(nodeB, await legacyToken(nodeA), "/update/prepare", {});
    const health = await fetch(`${nodeB.url}/api/health`);
    assert.equal(response.status, 403, "an ordinary paired peer must not prepare another node for update");
    assert.equal(health.status, 200, "denied preparation must leave the node healthy");
  } finally { await removeFixture(root, children); }
});

async function createMembership(manager: SeededNode, managerSession: SignedIn, joiner: SeededNode, joinerSession: SignedIn, clusterId: string): Promise<void> {
  const invitation = await api<{ link: string }>(manager, managerSession, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
  assert.equal(invitation.status, 201);
  const joined = await api(joiner, joinerSession, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() });
  assert.ok(joined.status === 200 || joined.status === 201, `cluster join returned ${joined.status}`);
}

async function createTwin(inviter: SeededNode, inviterSession: SignedIn, acceptor: SeededNode, acceptorSession: SignedIn): Promise<string> {
  const invitation = await api<{ link: string; relationshipId: string }>(inviter, inviterSession, "POST", "/twins/invitations", { confirmOwnedData: true });
  assert.equal(invitation.status, 201);
  const accepted = await api<{ relationshipId: string }>(acceptor, acceptorSession, "POST", "/twins/accept", { link: invitation.body.link, confirmOwnedData: true });
  assert.equal(accepted.status, 201);
  return accepted.body.relationshipId;
}

async function signedRequest(sender: SeededNode, recipient: SeededNode, target: string, payload: unknown): Promise<Response> {
  const body = Buffer.from(JSON.stringify(payload));
  const db = new DatabaseSync(path.join(sender.dataDir, "node.db"), { readOnly: true });
  const previous = process.env.JOINT_BOB_SECRET_KEY;
  try {
    process.env.JOINT_BOB_SECRET_KEY = (await readFile(path.join(sender.dataDir, "secret.key"), "utf8")).trim();
    const authorization = signClusterRequest(db, sender.nodeId, recipient.nodeId, "POST", target, body);
    return fetch(`${recipient.url}${target}`, { method: "POST", headers: { authorization, "content-type": "application/json" }, body });
  } finally {
    db.close();
    if (previous === undefined) delete process.env.JOINT_BOB_SECRET_KEY;
    else process.env.JOINT_BOB_SECRET_KEY = previous;
  }
}

test("signed v2 remote updates require the stated direct active twin relationship", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-twin-update-"));
  const children: Child[] = [];
  try {
    const environments: DevEnvironment[] = await Promise.all(["a", "b", "c"].map(name => seedDevEnvironment(path.join(root, name), 1)));
    const [nodeA, nodeB, nodeC] = environments.map(environment => environment.nodes[0]);
    children.push(...await Promise.all(environments.map((environment, index) => startDevNode(environment, environment.nodes[0], isolatedServerEnv))));
    const [sessionA, sessionB, sessionC] = await Promise.all(environments.map((environment, index) => signIn(environment, environment.nodes[0])));

    const created = await api<{ snapshot: { body: { clusterId: string } } }>(nodeA, sessionA, "POST", "/clusters", { name: "X" });
    assert.equal(created.status, 201);
    const clusterId = created.body.snapshot.body.clusterId;
    await createMembership(nodeA, sessionA, nodeB, sessionB, clusterId);
    await createMembership(nodeA, sessionA, nodeC, sessionC, clusterId);
    const relationshipAB = await createTwin(nodeA, sessionA, nodeB, sessionB);
    await createTwin(nodeB, sessionB, nodeC, sessionC);

    const installTarget = "/api/cluster/v2/update/install";
    const installBody = { relationshipId: relationshipAB, version: "99.0.0" };
    const transitive = await signedRequest(nodeC, nodeA, installTarget, installBody);
    const direct = await signedRequest(nodeA, nodeB, installTarget, installBody);
    const wrongRelationship = await signedRequest(nodeC, nodeB, installTarget, installBody);
    const cookieOnly = await fetch(`${nodeB.url}/api/cluster/v2/update/install`, {
      method: "POST", headers: { cookie: sessionB.cookie, "x-csrf-token": sessionB.csrfToken, "content-type": "application/json" },
      body: JSON.stringify({ relationshipId: relationshipAB, version: "99.0.0" }),
    });
    const prepareTarget = "/api/cluster/v2/update/prepare";
    const activeRemotePrepare = await signedRequest(nodeA, nodeB, prepareTarget, {});
    assert.equal(activeRemotePrepare.status, 403, "an active twin still may not prepare another node");
    assert.equal((await fetch(`${nodeB.url}/api/health`)).status, 200, "active-twin denial must leave the node healthy");

    const revoked = await api(nodeB, sessionB, "DELETE", `/twins/${relationshipAB}`);
    assert.equal(revoked.status, 200);
    const afterRevocation = await signedRequest(nodeA, nodeB, installTarget, installBody);

    assert.deepEqual({
      transitive: transitive.status,
      direct: direct.status,
      wrongRelationship: wrongRelationship.status,
      cookieOnly: cookieOnly.status,
      afterRevocation: afterRevocation.status,
    }, { transitive: 403, direct: 409, wrongRelationship: 403, cookieOnly: 401, afterRevocation: 403 });

    const remotePrepare = await signedRequest(nodeA, nodeB, prepareTarget, {});
    const extraField = await signedRequest(nodeB, nodeB, prepareTarget, { extra: true });
    assert.equal(updateJobCount(nodeB), 0);
    assert.equal((await fetch(`${nodeB.url}/api/health`)).status, 200);
    const selfPrepare = await signedRequest(nodeB, nodeB, prepareTarget, {});
    const selfPrepareRetry = await signedRequest(nodeB, nodeB, prepareTarget, {});
    const cookiePrepare = await fetch(`${nodeB.url}${prepareTarget}`, {
      method: "POST", headers: { cookie: sessionB.cookie, "x-csrf-token": sessionB.csrfToken, "content-type": "application/json" }, body: "{}",
    });
    assert.deepEqual({
      remote: remotePrepare.status,
      extraField: extraField.status,
      self: selfPrepare.status,
      retry: selfPrepareRetry.status,
      cookieOnly: cookiePrepare.status,
    }, { remote: 403, extraField: 400, self: 200, retry: 200, cookieOnly: 401 });
    assert.equal(updateJobCount(nodeB), 0);
    assert.equal((await fetch(`${nodeA.url}/api/health`)).status, 200);
    assert.equal((await fetch(`${nodeB.url}/api/health`)).status, 503);
  } finally { await removeFixture(root, children); }
});
