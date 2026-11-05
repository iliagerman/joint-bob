// Three real nodes: Alex's laptop and server (twins) and Maya's machine, in one cluster that shares one of Alex's projects.
// What Maya's Clusters tab and Bob's cluster summary are built from is what her node already holds, so this checks that data
// with real replication: Alex's running turns reach her node as leases, only for the project he shared.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";
import type { ClusterView } from "../src/control-center/clusters.js";

type Frame = Record<string, unknown>;

async function until(received: Frame[], type: string, timeout = 30_000): Promise<Frame> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = received.find((frame) => frame.type === type);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${type}: ${JSON.stringify(received.map(({ type: kind, error, reason }) => ({ kind, error, reason })))}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function eventually<T>(what: string, read: () => Promise<T | undefined>, timeout = 45_000): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** A browser on `node` starting a conversation that runs on `runsOn`, then sending its first message. The turn is held by the stub engine. */
async function startRunning(node: SeededNode, session: SignedIn, projectId: string, runsOn: SeededNode, sockets: WebSocket[]): Promise<string> {
  const url = new URL("/ws", node.url.replace(/^http/, "ws"));
  for (const [key, value] of Object.entries({ projectId, sessionPath: "claude:new", nodeId: runsOn.nodeId })) url.searchParams.set(key, value);
  const socket = new WebSocket(url, { headers: { Cookie: session.cookie, Origin: node.url } });
  sockets.push(socket);
  const received: Frame[] = [];
  socket.on("message", (raw) => received.push(JSON.parse(String(raw)) as Frame));
  const ready = await until(received, "ready");
  assert.equal(ready.executionNodeId, runsOn.nodeId, "the conversation runs where it was asked to");
  socket.send(JSON.stringify({ type: "prompt", message: "Look into the payment retries" }));
  await until(received, "userMessage");
  return String(ready.sessionId);
}

test("Clusters lists a teammate's running agents only through what is shared, never twins or the person's own, and the live board leaves them out", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-clusters-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  const sockets: WebSocket[] = [];
  try {
    const alex = await seedDevEnvironment(path.join(root, "alex"), 2);
    const team = await seedDevEnvironment(path.join(root, "maya"), 1, { username: "maya" });
    // Independently seeded nodes reuse the demo conversation ids; the teammate starts with none of her own.
    await rm(path.join(team.home, ".pi", "sessions"), { recursive: true, force: true });
    await rm(path.join(team.home, ".claude", "projects"), { recursive: true, force: true });
    const [laptop, server] = alex.nodes;
    const maya = team.nodes[0];
    const holds = path.join(root, "holds");
    await mkdir(holds);
    const engine = { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine-runs.log"), JOINT_BOB_TEST_ENGINE_HOLD_DIR: holds };
    await writeFile(engine.JOINT_BOB_TEST_ENGINE_LOG, "");
    for (const node of alex.nodes) children.push(await startDevNode(alex, node, engine));
    children.push(await startDevNode(team, maya, engine));
    await pairTwinNodes(alex);
    const [onLaptop, onServer, onMaya] = await Promise.all([signIn(alex, laptop), signIn(alex, server), signIn(team, maya)]);
    const view = async (node: SeededNode, session: SignedIn) => (await api<ClusterView>(node, session, "GET", "/control-center/clusters")).body;

    // Nodes are named by their people, the way a cluster lists them.
    for (const [node, session, name] of [[laptop, onLaptop, "Alex's Mac"], [server, onServer, "Alex's Server"], [maya, onMaya, "Maya's Mac"]] as const) {
      const renamed = await api(node, session, "PUT", "/cluster/node", { name, url: node.url });
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    }

    // Before any cluster exists there is nothing to show, and nothing breaks.
    assert.deepEqual(await view(maya, onMaya), { clusters: [], machines: [], projects: [] });
    assert.equal((await fetch(`${maya.url}/api/control-center/clusters`)).status, 401, "signed-in people only");

    const created = await api<{ snapshot: { body: { clusterId: string } } }>(laptop, onLaptop, "POST", "/clusters", { name: "Sela team" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const clusterId = created.body.snapshot.body.clusterId;
    for (const [node, session] of [[server, onServer], [maya, onMaya]] as const) {
      const invitation = await api<{ link: string }>(laptop, onLaptop, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
      assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
      const joined = await api(node, session, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() });
      assert.equal(joined.status, 201, JSON.stringify(joined.body));
    }

    // Alex shares one project with the cluster; his other projects stay his (and his twin's).
    const shared = laptop.projects.find((candidate) => candidate.name === "Internal Assistant")!;
    const kept = laptop.projects.find((candidate) => candidate.name === "Joint Bob")!;
    const sharing = await api(laptop, onLaptop, "PUT", `/clusters/${clusterId}/sharing`, { projectIds: [shared.id], workspaceIds: [], confirmOwnedData: true });
    assert.equal(sharing.status, 200, JSON.stringify(sharing.body));
    await eventually("Maya's node to receive the shared project", async () => (await api<{ projects: Array<{ id: string }> }>(maya, onMaya, "GET", "/projects?syncStatus=false")).body.projects.some((project) => project.id === shared.id) || undefined);
    const mayaProjects = (await api<{ projects: Array<{ id: string }> }>(maya, onMaya, "GET", "/projects?syncStatus=false")).body.projects;
    assert.equal(mayaProjects.some((project) => project.id === kept.id), false, "the project Alex did not share is not on her node");

    // Both of Alex's machines are in her cluster and nothing runs yet.
    const quiet = await eventually("Maya to see both of Alex's machines", async () => { const body = await view(maya, onMaya); return body.machines.length === 2 ? body : undefined; });
    assert.deepEqual(quiet.machines.map((machine) => [machine.name, machine.agents.length]).sort(), [["Alex's Mac", 0], ["Alex's Server", 0]]);
    assert.deepEqual(quiet.clusters, [{ id: clusterId, name: "Sela team", relay: false, machines: 2, running: 0 }]);
    // Alex sees Maya, and not his own twin.
    assert.deepEqual((await view(laptop, onLaptop)).machines.map((machine) => machine.name), ["Maya's Mac"]);

    // Alex runs three turns, held by the engine: on his laptop and on his server in the shared project, and one more in the project he kept.
    // The stub engine holds a turn for ten seconds at most, so they start together and the checks below follow without delay.
    const [onMac, onTwin, hidden] = await Promise.all([
      startRunning(laptop, onLaptop, shared.id, laptop, sockets),
      startRunning(laptop, onLaptop, shared.id, server, sockets),
      startRunning(laptop, onLaptop, kept.id, laptop, sockets),
    ]);

    const running = await eventually("Maya to see Alex's two running agents", async () => { const body = await view(maya, onMaya); return body.machines.flatMap((machine) => machine.agents).length === 2 ? body : undefined; });
    assert.deepEqual(running.machines.map((machine) => [machine.name, machine.agents.map((agent) => agent.sessionId)]).sort(), [["Alex's Mac", [onMac]], ["Alex's Server", [onTwin]]]);
    for (const machine of running.machines) {
      const [agent] = machine.agents;
      assert.deepEqual({ project: agent.projectName, state: agent.state, node: agent.nodeId, clusters: agent.clusterIds, agent: agent.agentLabel }, { project: "Internal Assistant", state: "running", node: machine.nodeId, clusters: [clusterId], agent: "Claude" });
    }
    assert.deepEqual(running.projects, [{ id: shared.id, name: "Internal Assistant" }], "the kept project is nowhere in her view");
    assert.equal(running.clusters[0].running, 2);

    // Alex's own board shows his three turns (his twin's included); his Clusters tab shows none of them.
    const alexBoard = await eventually("Alex's board to show his three turns", async () => { const board = (await api<{ cards: Array<{ sessionId: string; column: string }> }>(laptop, onLaptop, "GET", "/control-center/board")).body; return board.cards.filter((card) => card.column === "running").length === 3 ? board : undefined; });
    assert.ok([onMac, onTwin].every((id) => alexBoard.cards.some((card) => card.sessionId === id)));
    assert.deepEqual((await view(laptop, onLaptop)).machines.flatMap((machine) => machine.agents), []);

    // Maya's live board is hers: Alex's agents are read-only and have their own tab, so the board has nothing to act on.
    const mayaBoard = (await api<{ cards: Array<{ sessionId: string }> }>(maya, onMaya, "GET", "/control-center/board")).body;
    assert.deepEqual(mayaBoard.cards.filter((card) => [onMac, onTwin, hidden].includes(card.sessionId)), []);
    // The same conversations are still in her ordinary conversation list, where the existing rules for opening them hold.
    const listed = (await api<{ sessions: Array<{ id: string; executionNodeId?: string; running?: boolean }> }>(maya, onMaya, "GET", `/projects/${shared.id}/sessions`)).body.sessions;
    assert.equal(listed.find((session) => session.id === onTwin)?.executionNodeId, server.nodeId);

    // When the turns end they leave her view.
    await writeFile(path.join(holds, "claude.release"), "release");
    await eventually("Maya's view to empty", async () => (await view(maya, onMaya)).machines.every((machine) => !machine.agents.length) || undefined);
    assert.equal((await view(maya, onMaya)).clusters[0].running, 0);

    // Bob, on Maya's node: a message about the team is answered knowing what Alex shares and has running; any other message is not.
    // With no decision model set up the small explicit rule decides, and the line under the reply says so.
    await rm(path.join(holds, "claude.release"), { force: true });
    const again = await startRunning(laptop, onLaptop, shared.id, laptop, sockets);
    await eventually("Maya to see Alex's agent again", async () => (await view(maya, onMaya)).machines.some((machine) => machine.agents.some((agent) => agent.sessionId === again)) || undefined);
    // Bob's own agent is the test node's stub engine, not the default helper agent, which this fixture has no model for.
    // The held turns are the claude stub's; Bob answers with the pi stub, which is not held.
    const models = (await api<{ models: Array<{ harnessId: string; provider: string; id: string; thinkingLevels: string[] }> }>(maya, onMaya, "GET", "/models")).body.models;
    const pi = models.find((model) => model.harnessId === "pi");
    assert.ok(pi, "the test node offers a pi model");
    assert.equal((await api(maya, onMaya, "PUT", "/control-center/bob/settings", { harnessId: "pi", provider: pi.provider, modelId: pi.id, thinkingLevel: pi.thinkingLevels[0] ?? "" })).status, 200);
    await writeFile(path.join(holds, "pi.release"), "release");
    const about = await api<{ reply: { via: string } }>(maya, onMaya, "POST", "/control-center/bob/message", { message: "what is the team doing?" });
    assert.equal(about.status, 200, JSON.stringify(about.body));
    assert.match(about.body.reply.via, /Cluster agents: 1 running \(rule\)/);
    const unrelated = await api<{ reply: { via: string } }>(maya, onMaya, "POST", "/control-center/bob/message", { message: "what is running in Internal Assistant?" });
    assert.equal(unrelated.status, 200, JSON.stringify(unrelated.body));
    assert.doesNotMatch(unrelated.body.reply.via, /Cluster agents/);
    await writeFile(path.join(holds, "claude.release"), "release");
  } finally {
    for (const socket of sockets) socket.terminate();
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
