// Sharing invariance over a relay (RELAY-PLAN.md §4.10, §9). The same isolation as
// multi-cluster.test.ts, but no member has a direct URL: every node-to-node request goes
// through one relay that all of them share. Being on the same relay must grant nothing.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";
import { fixtureTotp } from "./mfa-fixture.js";

/** Authenticated JSON call that also accepts empty (204) answers. */
async function api<T>(node: SeededNode, session: SignedIn, method: string, endpoint: string, body?: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${node.url}/api${endpoint}`, {
    method,
    headers: { Cookie: session.cookie, "x-csrf-token": session.csrfToken, ...(body ? { "Content-Type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T };
}

async function eventually(check: () => Promise<void>, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await check(); return; } catch (error) { if (Date.now() > deadline) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function projectIds(node: SeededNode, session: SignedIn): Promise<string[]> {
  return (await api<{ projects: Array<{ id: string }> }>(node, session, "GET", "/projects?syncStatus=false")).body.projects.map((project) => project.id);
}

async function createClusterWith(manager: SeededNode, managerSession: SignedIn, member: SeededNode, memberSession: SignedIn, name: string): Promise<string> {
  const created = await api<{ snapshot: { body: { clusterId: string } } }>(manager, managerSession, "POST", "/clusters", { name });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const clusterId = created.body.snapshot.body.clusterId;
  const invitation = await api<{ link: string }>(manager, managerSession, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
  assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
  assert.match(invitation.body.link, /^https:\/\/[0-9a-f-]{36}\.relay\.invalid\/join#v2\./, "a relay-only manager's invitation names it by node ID");
  const joined = await api(member, memberSession, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  return clusterId;
}

/** A request to the relay's own port, addressed to a machine name the way a phone would. */
function throughGateway(port: number, host: string, method: string, target: string, body?: unknown): Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = http.request({ host: "127.0.0.1", port, method, path: target, headers: { Host: host, ...(payload ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload)) } : {}) } }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text, headers: response.headers }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

test("relay-only machines share exactly what their clusters allow, and the relay grants nothing", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "relay-cluster-"));
  const environments: DevEnvironment[] = [];
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    for (const key of ["r", "a", "b", "c"]) environments.push(await seedDevEnvironment(path.join(root, key), 1));
    for (const environment of environments.slice(1)) {
      if (environment === environments[1]) continue;
      await rm(path.join(environment.home, ".pi", "sessions"), { recursive: true, force: true });
      await rm(path.join(environment.home, ".claude", "projects"), { recursive: true, force: true });
    }
    const [r, a, b, c] = environments.map((environment) => environment.nodes[0]);
    const [envR, envA, envB, envC] = environments;
    for (const [environment, node] of [[envR, r], [envA, a], [envB, b], [envC, c]] as const) children.push(await startDevNode(environment, node));
    const [sr, sa, sb, sc] = await Promise.all([signIn(envR, r), signIn(envA, a), signIn(envB, b), signIn(envC, c)]);

    // The relay: a working machine that also serves relays at its own address.
    const origin = `http://localhost:${r.port}`;
    const serving = await api(r, sr, "PUT", "/relay/serving", { enabled: true, origin, environment: "test", requestsEnabled: true, maxMachines: 10, monthlyCapGb: 0, alertTopic: "" });
    assert.equal(serving.status, 204, JSON.stringify(serving.body));

    // A, B and C drop their direct URLs and join the relay with tokens.
    const names = new Map<string, string>();
    for (const [node, session, label] of [[a, sa, "alpha"], [b, sb, "bravo"], [c, sc, "charlie"]] as const) {
      const cleared = await api(node, session, "PUT", "/cluster/node", { name: label, url: "" });
      assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
      const created = await api<{ link: string }>(r, sr, "POST", "/relay/serving/tokens", { label });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const added = await api(node, session, "POST", "/relays", { link: created.body.link });
      assert.equal(added.status, 201, JSON.stringify(added.body));
    }
    for (const [node, session] of [[a, sa], [b, sb], [c, sc]] as const) {
      await eventually(async () => {
        const view = await api<{ relays: Array<{ status: string; name: string; phoneAddress: string }>; advertisedUrl: string }>(node, session, "GET", "/relays");
        assert.equal(view.body.relays[0]?.status, "admitted", JSON.stringify(view.body));
        assert.equal(view.body.advertisedUrl, `https://${node.nodeId}.relay.invalid`);
        names.set(node.nodeId, view.body.relays[0].name);
      });
    }

    const relayId = (await api<{ relays: Array<{ id: string }> }>(a, sa, "GET", "/relays")).body.relays[0].id;
    const history = await api<{ events: Array<{ transport: string; event: string }> }>(a, sa, "GET", `/relays/${relayId}/transport-events`);
    assert.equal(history.status, 200);
    assert.ok(history.body.events.some((entry) => entry.transport === "websocket" && entry.event === "connected"));
    assert.equal((await api(a, sa, "GET", `/relays/${randomUUID()}/transport-events`)).status, 404);

    const clusterX = await createClusterWith(a, sa, b, sb, "Home");
    const clusterY = await createClusterWith(a, sa, c, sc, "Work");
    const forX = a.projects.find((project) => project.name === "Internal Assistant")!;
    const forY = a.projects.find((project) => project.name === "Infra Scripts")!;
    const forNobody = a.projects.find((project) => project.name === "Joint Bob")!;
    assert.equal((await api(a, sa, "PUT", `/clusters/${clusterX}/sharing`, { projectIds: [forX.id], workspaceIds: [], confirmOwnedData: true })).status, 200);
    assert.equal((await api(a, sa, "PUT", `/clusters/${clusterY}/sharing`, { projectIds: [forY.id], workspaceIds: [], confirmOwnedData: true })).status, 200);

    await eventually(async () => {
      assert.ok((await projectIds(b, sb)).includes(forX.id), "cluster X receives its project through the relay");
      assert.ok((await projectIds(c, sc)).includes(forY.id), "cluster Y receives its project through the relay");
    });
    const onB = await projectIds(b, sb), onC = await projectIds(c, sc), onR = await projectIds(r, sr);
    assert.equal(onB.includes(forY.id), false, "cluster X never sees cluster Y's project");
    assert.equal(onC.includes(forX.id), false, "cluster Y never sees cluster X's project");
    assert.equal(onB.includes(forNobody.id) || onC.includes(forNobody.id), false, "an unselected project stays on its owner");
    assert.equal([forX.id, forY.id, forNobody.id].some((id) => onR.includes(id)), false, "the relay machine receives nothing it is not a member for");
    assert.deepEqual((await api<{ clusters: unknown[] }>(r, sr, "GET", "/clusters")).body.clusters, [], "the relay machine is in no cluster");
    for (const [node, session, own] of [[b, sb, clusterX], [c, sc, clusterY]] as const) {
      const listed = await api<{ clusters: Array<{ id: string; members: Array<{ nodeId: string }> }> }>(node, session, "GET", "/clusters");
      assert.deepEqual(listed.body.clusters.map((cluster) => cluster.id), [own], "each other node knows only its own cluster");
      assert.deepEqual(listed.body.clusters[0].members.map((member) => member.nodeId).sort(), [a.nodeId, node.nodeId].sort(), "B and C never learn about each other");
    }

    // The same authorization outcomes as with direct URLs: the relay changes the path, not the answer.
    const sessionsOf = async (projectId: string) => (await api<{ sessions: Array<{ id: string; harnessId: string }> }>(a, sa, "GET", `/projects/${projectId}/sessions`)).body.sessions;
    const [inX] = await sessionsOf(forX.id), [inY] = await sessionsOf(forY.id);
    const transcript = (projectId: string, session: { id: string; harnessId: string }) => "/api/cluster/v2/transcripts/file?" + new URLSearchParams({ projectId, engine: session.harnessId, sessionId: session.id });
    assert.equal((await signedNodeRequest(envB, b, a, "GET", transcript(forX.id, inX))).status, 200);
    assert.equal((await signedNodeRequest(envB, b, a, "GET", transcript(forY.id, inY))).status, 403);
    assert.equal((await signedNodeRequest(envC, c, a, "GET", transcript(forX.id, inX))).status, 403);
    const presence = (projectId: string) => "/api/cluster/v2/runtime/projects/presence?" + new URLSearchParams({ projectId });
    assert.equal((await signedNodeRequest(envB, b, c, "GET", presence(forY.id))).status, 401, "sharing a relay does not let B and C authenticate to each other");
    assert.equal((await signedNodeRequest(envR, r, a, "GET", presence(forX.id))).status, 401, "the relay machine cannot authenticate to its machines");

    // Live node-to-node calls through the relay: A sees each project's member online.
    for (const [project, member] of [[forX, b], [forY, c]] as const) {
      await eventually(async () => {
        const nodes = await api<{ nodes: Array<{ id: string; online: boolean }> }>(a, sa, "GET", `/projects/${project.id}/session-nodes`);
        assert.deepEqual(nodes.body.nodes.map((node) => node.id).sort(), [a.nodeId, member.nodeId].sort(), `${project.name} offers only its cluster's machines`);
        assert.equal(nodes.body.nodes.find((node) => node.id === member.nodeId)?.online, true, "the member answers through the relay");
      });
    }

    // Phone gateway: A's own UI by name, under A's own sign-in rules.
    const host = `${names.get(a.nodeId)}.localhost:${r.port}`;
    const status = await throughGateway(r.port, host, "GET", "/api/auth/status");
    assert.equal(status.status, 200, status.text);
    const login = await throughGateway(r.port, host, "POST", "/api/auth/login", { username: envA.username, password: envA.password });
    const wrong = await throughGateway(r.port, host, "POST", "/api/auth/login", { username: envA.username, password: "not-the-password" });
    assert.equal(wrong.status, 401, wrong.text);
    assert.equal(wrong.headers["set-cookie"], undefined);
    // Failed phone sign-ins never lock the owner out of direct sign-in.
    for (let attempt = 0; attempt < 6; attempt += 1) await throughGateway(r.port, host, "POST", "/api/auth/login", { username: envA.username, password: "not-the-password" });
    assert.equal((await signIn(envA, a)).cookie.length > 0, true);
    assert.equal(login.status, 200, login.text);
    const challenge = JSON.parse(login.text) as { mfaRequired: boolean; mfaSetupRequired: boolean; challenge: string };
    assert.equal(challenge.mfaSetupRequired, true, "phone sign-in starts MFA enrollment for an account without MFA");
    assert.equal(login.headers["set-cookie"], undefined, "password proof alone cannot open a session");
    const pending = await throughGateway(r.port, host, "POST", "/api/auth/login/mfa/setup", { challenge: challenge.challenge });
    assert.equal(pending.status, 200, pending.text);
    const secret = (JSON.parse(pending.text) as { secret: string }).secret;
    const invalid = await throughGateway(r.port, host, "POST", "/api/auth/login/mfa/confirm", { challenge: challenge.challenge, code: "00000" });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.headers["set-cookie"], undefined);
    const confirmed = await throughGateway(r.port, host, "POST", "/api/auth/login/mfa/confirm", { challenge: challenge.challenge, code: fixtureTotp(secret) });
    assert.equal(confirmed.status, 200, confirmed.text);
    const recoveryCodes = (JSON.parse(confirmed.text) as { recoveryCodes: string[] }).recoveryCodes;
    assert.equal(recoveryCodes.length, 10);
    assert.match(String(confirmed.headers["set-cookie"]), /__Host-/, "only verified MFA creates a gateway session");
    assert.equal((await throughGateway(r.port, host, "POST", "/api/auth/login/mfa/confirm", { challenge: challenge.challenge, code: fixtureTotp(secret) })).status, 401, "enrollment proof is single-use");
    const machineRoute = await throughGateway(r.port, host, "POST", "/api/cluster/v2/membership/redeem", {});
    assert.equal(machineRoute.status, 404, "machine endpoints are not reachable through the phone gateway");
    const unknown = await throughGateway(r.port, `nobody.localhost:${r.port}`, "GET", "/");
    assert.equal(unknown.status, 404);

    // Enrollment revoked the earlier local session. Sign in with MFA for further admin calls.
    const localPending = await fetch(`${a.url}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: envA.username, password: envA.password }) });
    const localChallenge = (await localPending.json() as { challenge: string }).challenge;
    const localCompleted = await fetch(`${a.url}/api/auth/login/mfa`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge: localChallenge, code: recoveryCodes[0] }) });
    assert.equal(localCompleted.status, 200);
    const localSession: SignedIn = { cookie: localCompleted.headers.get("set-cookie")!.split(";")[0], csrfToken: (await localCompleted.json() as { csrfToken: string }).csrfToken };
    // Turning phone sign-in off for A's relay closes its name.
    const relays = await api<{ relays: Array<{ id: string }> }>(a, localSession, "GET", "/relays");
    assert.equal((await api(a, localSession, "PATCH", `/relays/${relays.body.relays[0].id}`, { phoneSignIn: false })).status, 200);
    await eventually(async () => assert.equal((await throughGateway(r.port, host, "GET", "/api/auth/status")).status, 404));

    // Webhooks need no phone sign-in: the relay hands the call to A on a webhook-only channel.
    const hook = await api<{ webhook: { id: string }; secret: string; bases: Array<{ id: string; base: string }> }>(a, localSession, "POST", "/webhooks", {
      name: "Relay hook", target: { kind: "project", projectId: forX.id }, context: "Triage this.",
    });
    assert.equal(hook.status, 201, JSON.stringify(hook.body));
    assert.match(hook.body.secret, /^[A-Za-z0-9_-]{43}$/, "the secret is 256 random bits");
    assert.ok(hook.body.bases.some((base) => base.base === `http://localhost:${r.port}/hooks/${names.get(a.nodeId)}`), JSON.stringify(hook.body.bases));
    const hookPath = `/hooks/${names.get(a.nodeId)}/${hook.body.secret}`;
    const relayHost = `localhost:${r.port}`;
    await eventually(async () => {
      const call = await throughGateway(r.port, relayHost, "POST", hookPath, { action: "opened" });
      assert.equal(call.status, 202, call.text);
    });
    assert.equal((await throughGateway(r.port, relayHost, "GET", hookPath)).status, 405, "webhooks accept POST only");
    assert.equal((await throughGateway(r.port, relayHost, "POST", `/hooks/${names.get(a.nodeId)}/${hook.body.secret.slice(1)}x`, {})).status, 404, "a wrong secret finds nothing");
    assert.equal((await throughGateway(r.port, relayHost, "POST", `/hooks/nobody/${hook.body.secret}`, {})).status, 404, "an unknown machine finds nothing");
    await eventually(async () => {
      const deliveries = await api<{ deliveries: Array<{ status: string }> }>(a, localSession, "GET", `/webhooks/${hook.body.webhook.id}/deliveries`);
      assert.ok(deliveries.body.deliveries.length >= 1, "the call was recorded");
    });
    const regenerated = await api<{ secret: string }>(a, localSession, "POST", `/webhooks/${hook.body.webhook.id}/regenerate`, {});
    assert.equal((await throughGateway(r.port, relayHost, "POST", hookPath, {})).status, 404, "the old address stops working");
    assert.equal((await throughGateway(r.port, relayHost, "POST", `/hooks/${names.get(a.nodeId)}/${regenerated.body.secret}`, {})).status, 202);
    assert.equal((await api(a, localSession, "DELETE", `/webhooks/${hook.body.webhook.id}`)).status, 204);
    assert.equal((await throughGateway(r.port, relayHost, "POST", `/hooks/${names.get(a.nodeId)}/${regenerated.body.secret}`, {})).status, 404, "a deleted webhook finds nothing");
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
