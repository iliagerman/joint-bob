// One node in two clusters shares a different project with each. Each cluster must
// receive only its own project — metadata, transcripts, credentials, and runtime
// access — and the two other nodes must never learn about each other.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import WebSocket from "ws";
import { claudeProjectDir } from "../src/session-paths.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

async function eventually(check: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { await check(); return; } catch (error) { if (Date.now() > deadline) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 200));
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
  const joined = await api(member, memberSession, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() });
  assert.equal(joined.status, 201, JSON.stringify(joined.body));
  return clusterId;
}

function socketEvent(socket: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Socket did not receive ${type}`)), 15_000);
    const finish = (error?: Error, event?: Record<string, unknown>): void => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("close", onClose);
      socket.off("error", onError);
      if (error) reject(error); else resolve(event!);
    };
    const onMessage = (raw: WebSocket.RawData): void => {
      const event = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (event.type === type) finish(undefined, event);
      else if (event.type === "error") finish(new Error(JSON.stringify(event)));
    };
    const onClose = (code: number, reason: Buffer): void => finish(new Error(`Socket closed ${code}: ${reason}`));
    const onError = (error: Error): void => finish(error);
    socket.on("message", onMessage);
    socket.once("close", onClose);
    socket.once("error", onError);
  });
}

function routedConversation(node: SeededNode, session: SignedIn, owner: SeededNode, projectId: string, sessionPath: string, sessionId?: string, worktreeId?: string): WebSocket {
  const url = new URL("/ws", node.url.replace(/^http/, "ws"));
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("sessionPath", sessionPath);
  url.searchParams.set("nodeId", owner.nodeId);
  if (sessionId) url.searchParams.set("sessionId", sessionId);
  if (worktreeId) url.searchParams.set("worktreeId", worktreeId);
  return new WebSocket(url, { headers: { Cookie: session.cookie, Origin: node.url } });
}

test("a node in two clusters shares each project only with the cluster it was selected for", { timeout: 150_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "multi-cluster-"));
  const environments: DevEnvironment[] = [];
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  const sockets: WebSocket[] = [];
  try {
    for (const key of ["a", "b", "c"]) environments.push(await seedDevEnvironment(path.join(root, key), 1));
    // Independently seeded nodes reuse demo conversation IDs; B and C start with no transcripts of their own.
    for (const environment of environments.slice(1)) {
      await rm(path.join(environment.home, ".pi", "sessions"), { recursive: true, force: true });
      await rm(path.join(environment.home, ".claude", "projects"), { recursive: true, force: true });
    }
    const [a, b, c] = environments.map((environment) => environment.nodes[0]);
    const [envA, envB, envC] = environments;
    const engineLog = path.join(root, "engine-runs.log");
    await writeFile(engineLog, "");
    for (const [environment, node] of [[envA, a], [envB, b], [envC, c]] as const) children.push(await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: engineLog, JOINT_BOB_WORKTREE_ROOT: path.join(environment.root, "worktrees") }));
    const [sa, sb, sc] = await Promise.all([signIn(envA, a), signIn(envB, b), signIn(envC, c)]);

    const clusterX = await createClusterWith(a, sa, b, sb, "Home");
    const clusterY = await createClusterWith(a, sa, c, sc, "Work");
    const forX = a.projects.find((project) => project.name === "Internal Assistant")!;
    const forY = a.projects.find((project) => project.name === "Infra Scripts")!;
    const forNobody = a.projects.find((project) => project.name === "Joint Bob")!;

    const account = await api<{ account: { id: string } }>(a, sa, "POST", "/secrets/accounts", { label: "Home credential", provider: "custom", replicate: true, variables: [{ name: "HOME_ONLY", kind: "value", value: "synthetic-home-value" }] });
    assert.equal(account.status, 201, JSON.stringify(account.body));
    assert.equal((await api(a, sa, "PUT", `/secrets/scopes/project/${forX.id}`, { accountIds: [account.body.account.id] })).status, 200);

    assert.equal((await api(a, sa, "PUT", `/clusters/${clusterX}/sharing`, { projectIds: [forX.id], workspaceIds: [], confirmOwnedData: true })).status, 200);
    assert.equal((await api(a, sa, "PUT", `/clusters/${clusterY}/sharing`, { projectIds: [forY.id], workspaceIds: [], confirmOwnedData: true })).status, 200);

    await eventually(async () => {
      const onB = await projectIds(b, sb);
      assert.ok(onB.includes(forX.id), "cluster X receives the project selected for it");
      const onC = await projectIds(c, sc);
      assert.ok(onC.includes(forY.id), "cluster Y receives the project selected for it");
    });
    const onB = await projectIds(b, sb), onC = await projectIds(c, sc);
    assert.equal(onB.includes(forY.id), false, "cluster X never sees cluster Y's project");
    assert.equal(onC.includes(forX.id), false, "cluster Y never sees cluster X's project");
    assert.equal(onB.includes(forNobody.id) || onC.includes(forNobody.id), false, "an unselected project stays on its owner");

    const clustersOnA = await api<{ clusters: Array<{ id: string }> }>(a, sa, "GET", "/clusters");
    assert.deepEqual(clustersOnA.body.clusters.map((cluster) => cluster.id).sort(), [clusterX, clusterY].sort(), "the shared node belongs to both clusters");
    for (const [node, session, own] of [[b, sb, clusterX], [c, sc, clusterY]] as const) {
      const listed = await api<{ clusters: Array<{ id: string; members: Array<{ nodeId: string }> }> }>(node, session, "GET", "/clusters");
      assert.deepEqual(listed.body.clusters.map((cluster) => cluster.id), [own], "each other node knows only its own cluster");
      const members = listed.body.clusters[0].members.map((member) => member.nodeId).sort();
      assert.deepEqual(members, [a.nodeId, node.nodeId].sort(), "B and C never learn about each other");
    }

    await eventually(async () => {
      const secretsOnB = await api<{ accounts: Array<{ id: string }> }>(b, sb, "GET", "/secrets");
      assert.ok(secretsOnB.body.accounts.some((candidate) => candidate.id === account.body.account.id), "the credential attached to X's project reaches X");
    });
    const secretsOnC = await api<{ accounts: Array<{ id: string }> }>(c, sc, "GET", "/secrets");
    assert.equal(secretsOnC.body.accounts.some((candidate) => candidate.id === account.body.account.id), false, "the credential never reaches Y");

    const sessionsOf = async (projectId: string) => (await api<{ sessions: Array<{ id: string; harnessId: string }> }>(a, sa, "GET", `/projects/${projectId}/sessions`)).body.sessions;
    const [inX] = await sessionsOf(forX.id), [inY] = await sessionsOf(forY.id);
    const transcript = (projectId: string, session: { id: string; harnessId: string }) => "/api/cluster/v2/transcripts/file?" + new URLSearchParams({ projectId, engine: session.harnessId, sessionId: session.id });
    assert.equal((await signedNodeRequest(envB, b, a, "GET", transcript(forX.id, inX))).status, 200, "X reads its own project's transcript");
    assert.equal((await signedNodeRequest(envB, b, a, "GET", transcript(forY.id, inY))).status, 403, "X cannot read Y's transcript");
    assert.equal((await signedNodeRequest(envC, c, a, "GET", transcript(forX.id, inX))).status, 403, "Y cannot read X's transcript");
    const presence = (projectId: string) => "/api/cluster/v2/runtime/projects/presence?" + new URLSearchParams({ projectId });
    assert.equal((await signedNodeRequest(envB, b, a, "GET", presence(forX.id))).status, 200);
    assert.equal((await signedNodeRequest(envB, b, a, "GET", presence(forY.id))).status, 403, "runtime calls into Y's project are refused for X");
    assert.equal((await signedNodeRequest(envC, c, a, "GET", presence(forNobody.id))).status, 403, "runtime calls into an unselected project are refused");
    assert.equal((await signedNodeRequest(envB, b, c, "GET", presence(forY.id))).status, 401, "nodes in different clusters cannot authenticate to each other");

    // A conversation's machine pickers offer only the machines of the project's own cluster.
    const machineIds = (nodes: Array<{ id: string }>) => nodes.map((node) => node.id).sort();
    for (const [project, member] of [[forX, b], [forY, c]] as const) {
      const sessionNodes = await api<{ nodes: Array<{ id: string }> }>(a, sa, "GET", `/projects/${project.id}/session-nodes`);
      assert.deepEqual(machineIds(sessionNodes.body.nodes), [a.nodeId, member.nodeId].sort(), `${project.name} offers only its cluster's execution machines`);
      const browserNodes = await api<{ nodes: Array<{ id: string }> }>(a, sa, "GET", `/browser/status?projectId=${project.id}`);
      assert.deepEqual(machineIds(browserNodes.body.nodes), [a.nodeId, member.nodeId].sort(), `${project.name} offers only its cluster's browser machines`);
    }
    // A cluster member that is not a twin may not be picked in Runs on until its owner allows it.
    const takeOwnership = "/api/cluster/v2/runtime/sessions/take-ownership";
    const offered = await api<{ nodes: Array<{ id: string; runner: boolean }> }>(b, sb, "GET", `/projects/${forX.id}/session-nodes`);
    assert.equal(offered.body.nodes.find((node) => node.id === a.nodeId)?.runner, false, "A does not accept runs from B by default");
    assert.equal(offered.body.nodes.find((node) => node.id === b.nodeId)?.runner, true, "a node always accepts its own runs");
    const refused = await signedNodeRequest(envB, b, a, "POST", takeOwnership, { projectId: forX.id });
    assert.deepEqual([refused.status, (await refused.json() as { error: string }).error], [403, "This node does not accept runs from other nodes"], "A refuses B's takeover");
    // Viewing history is not a run, even when the browser routes through a non-runner peer.
    const parentId = randomUUID();
    const directory = claudeProjectDir(forX.path, path.join(envA.home, ".claude", "projects"));
    const subagents = path.join(directory, parentId, "subagents");
    await mkdir(subagents, { recursive: true });
    const parentPath = path.join(directory, `${parentId}.jsonl`);
    const childPath = path.join(subagents, "agent-reader.jsonl");
    const worktreeId = randomUUID();
    const worktree = path.join(envA.root, "worktrees", forX.id, worktreeId);
    const metadata = path.join(worktree, ".joint-bob-worktree");
    await mkdir(path.join(metadata, "conversations"), { recursive: true });
    await writeFile(path.join(metadata, "worktree.json"), JSON.stringify({ version: 1, id: worktreeId, name: "Shared history", color: "teal",
      createdAt: new Date().toISOString(), createdByNodeId: a.nodeId, baselineDigest: "fixture", lastMergedAt: null }));
    await writeFile(path.join(metadata, "conversations", `claude--${parentId}.json`), JSON.stringify({ engine: "claude", sessionId: parentId }));
    await writeFile(path.join(forX.path, ".env"), "SYNTHETIC_WORKTREE_SETTING=fixture\n");
    await mkdir(path.join(forX.path, "node_modules"), { recursive: true });
    for (const [file, text] of [[parentPath, "Shared parent history"], [childPath, "Read-only child history"]]) {
      await writeFile(file, JSON.stringify({ type: "user", uuid: randomUUID(), sessionId: parentId, cwd: forX.path,
        timestamp: new Date().toISOString(), message: { role: "user", content: text } }) + "\n");
      const contents = await readFile(file, "utf8");
      const socket = routedConversation(b, sb, a, forX.id, `claude:${file}`, file === parentPath ? parentId : `${parentId}/agent-reader`);
      sockets.push(socket);
      const ready = await socketEvent(socket, "ready");
      assert.equal(ready.readOnly, true, "a node refusing runs still serves existing conversations read-only");
      assert.equal(ready.executionNodeId, a.nodeId);
      assert.ok((ready.messages as Array<{ text: string }>).some((message) => message.text === text), "the requested history reaches the viewing node");
      for (const command of [{ type: "prompt", message: "Must not run remotely" }, { type: "rename", name: "Must not change history" }]) {
        const rejected = socketEvent(socket, "error");
        socket.send(JSON.stringify(command));
        assert.equal((await rejected).error, "This conversation is read-only");
      }
      const pong = socketEvent(socket, "pong");
      socket.send(JSON.stringify({ type: "ping" }));
      await pong;
      assert.equal(await readFile(file, "utf8"), contents, "viewing and rejected writes leave the transcript unchanged");
      socket.close();
    }
    assert.equal(await readFile(engineLog, "utf8"), "", "viewing history must not start an agent turn");
    for (const file of [".env", "node_modules", ".joint-bob/worktree-local-files.json"]) {
      await assert.rejects(lstat(path.join(worktree, file)), { code: "ENOENT" }, "read-only opens must not provision worktree files");
    }
    const database = new DatabaseSync(path.join(a.dataDir, "node.db"));
    try {
      const draftId = randomUUID();
      const now = new Date().toISOString();
      database.prepare("INSERT INTO conversation_records (project_id, engine, session_id, created_at, updated_at, origin_node_id) VALUES (?, 'claude', ?, ?, ?, ?)")
        .run(forX.id, draftId, now, now, a.nodeId);
      const draftBefore = database.prepare("SELECT * FROM conversation_records WHERE session_id = ?").get(draftId);
      const draft = routedConversation(b, sb, a, forX.id, `draft:claude:${draftId}`, draftId, worktreeId);
      sockets.push(draft);
      assert.equal((await socketEvent(draft, "ready")).readOnly, true, "existing drafts remain viewable without starting them");
      assert.deepEqual(database.prepare("SELECT * FROM conversation_records WHERE session_id = ?").get(draftId), draftBefore,
        "viewing a draft must not change its conversation/worktree record");
      await assert.rejects(lstat(path.join(metadata, "conversations", `claude--${draftId}.json`)), { code: "ENOENT" }, "a viewer cannot attach a draft to a worktree");
      draft.close();
      assert.equal(database.prepare("SELECT owner_node_id FROM conversation_ownership WHERE engine = 'claude' AND session_id = ?").get(parentId), undefined,
        "viewing must not claim conversation ownership");
      assert.equal(database.prepare("SELECT worktree FROM conversation_records WHERE engine = 'claude' AND session_id = ?").get(parentId), undefined,
        "viewing must not create conversation/worktree records");
    } finally { database.close(); }
    const denied = routedConversation(b, sb, a, forX.id, "claude:new");
    sockets.push(denied);
    await assert.rejects(socketEvent(denied, "ready"), /1008: This node does not accept runs from other nodes/, "new runs remain forbidden");
    const privateSocket = routedConversation(b, sb, a, forY.id, `claude:${parentPath}`);
    sockets.push(privateSocket);
    await assert.rejects(socketEvent(privateSocket, "ready"), /Project not found|Project is not shared with this node/, "read-only opens cannot bypass project sharing");

    const settingsA = (await api<Record<string, unknown>>(a, sa, "GET", "/settings")).body;
    assert.equal((await api(a, sa, "PUT", "/settings", { ...settingsA, runnerAccess: { otherNodes: true } })).status, 200);
    const accepted = await signedNodeRequest(envB, b, a, "POST", takeOwnership, { projectId: forX.id });
    assert.notEqual((await accepted.json() as { error?: string }).error, "This node does not accept runs from other nodes", "A accepts B once allowed");
    const reoffered = await api<{ nodes: Array<{ id: string; runner: boolean }> }>(b, sb, "GET", `/projects/${forX.id}/session-nodes`);
    assert.equal(reoffered.body.nodes.find((node) => node.id === a.nodeId)?.runner, true);
    const writable = routedConversation(b, sb, a, forX.id, `claude:${parentPath}`, parentId);
    sockets.push(writable);
    assert.equal((await socketEvent(writable, "ready")).readOnly, false, "allowing runs still opens writable conversations");
    const unshared = await api<{ nodes: Array<{ id: string }> }>(a, sa, "GET", `/projects/${forNobody.id}/session-nodes`);
    assert.deepEqual(machineIds(unshared.body.nodes), [a.nodeId], "an unshared project runs only on its owner");
  } finally {
    for (const socket of sockets) socket.terminate();
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
