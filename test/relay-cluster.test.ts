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
    assert.equal(login.status, 401, login.text);
    assert.match(login.text, /two-factor authentication/, "a phone sign-in needs MFA");
    assert.equal(login.headers["set-cookie"], undefined, "no session is handed out without MFA");
    assert.deepEqual([wrong.status, wrong.text], [login.status, login.text], "a right password without MFA looks exactly like a wrong one");
    // Failed phone sign-ins never lock the owner out of direct sign-in.
    for (let attempt = 0; attempt < 6; attempt += 1) await throughGateway(r.port, host, "POST", "/api/auth/login", { username: envA.username, password: "not-the-password" });
    assert.equal((await signIn(envA, a)).cookie.length > 0, true);
    const machineRoute = await throughGateway(r.port, host, "POST", "/api/cluster/v2/membership/redeem", {});
    assert.equal(machineRoute.status, 404, "machine endpoints are not reachable through the phone gateway");
    const unknown = await throughGateway(r.port, `nobody.localhost:${r.port}`, "GET", "/");
    assert.equal(unknown.status, 404);

    // Turning phone sign-in off for A's relay closes its name.
    const relays = await api<{ relays: Array<{ id: string }> }>(a, sa, "GET", "/relays");
    assert.equal((await api(a, sa, "PATCH", `/relays/${relays.body.relays[0].id}`, { phoneSignIn: false })).status, 200);
    await eventually(async () => assert.equal((await throughGateway(r.port, host, "GET", "/api/auth/status")).status, 404));
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
