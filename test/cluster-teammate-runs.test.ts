// A team: one person's laptop and home server (twins), and a teammate's machine, in one cluster
// sharing one project. A conversation started on the laptop runs on the server. Once the server
// lets other machines run work on it, the teammate's messages in that conversation, and in her
// fork of it, must run there. They used to stay queued: the turn ran as the teammate, who has no
// subscription choice on the server and cannot make one, and failed before it started.
// Until the server allows it, the conversation opens read-only from her machine and says why.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";

type Frame = Record<string, unknown>;
interface SessionRow { id: string; path: string; executionNodeId?: string }

function frames(socket: WebSocket): Frame[] {
  const received: Frame[] = [];
  socket.on("message", (raw) => received.push(JSON.parse(String(raw)) as Frame));
  socket.on("close", (code, reason) => received.push({ type: "closed", code, reason: String(reason) }));
  return received;
}

async function until(received: Frame[], types: string[], timeout = 30_000): Promise<Frame> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = received.find((frame) => types.includes(String(frame.type)));
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${types.join("/")}: ${JSON.stringify(received.map(({ type, error, reason }) => ({ type, error, reason })))}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function eventually<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** A browser on `node` opening a conversation, the way the page does: with the machine it runs on. */
function openConversation(node: SeededNode, session: SignedIn, params: Record<string, string>): { socket: WebSocket; received: Frame[] } {
  const url = new URL("/ws", node.url.replace(/^http/, "ws"));
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const socket = new WebSocket(url, { headers: { Cookie: session.cookie, Origin: node.url } });
  return { socket, received: frames(socket) };
}

/** Sends one message and waits for its turn to end; the turn's own outcome, not just the queue. */
async function send(chat: { socket: WebSocket; received: Frame[] }, message: string): Promise<Frame> {
  const from = chat.received.length;
  chat.socket.send(JSON.stringify({ type: "prompt", message }));
  const deadline = Date.now() + 30_000;
  for (;;) {
    const outcome = chat.received.slice(from).find((frame) => ["promptCompleted", "promptFailed", "error"].includes(String(frame.type)));
    if (outcome) return outcome;
    if (Date.now() > deadline) throw new Error(`Turn never ended: ${JSON.stringify(chat.received.slice(from).map(({ type, error }) => ({ type, error })))}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("a teammate's messages run on the third machine that runs the conversation, once it allows other machines", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-teammate-runs-"));
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
    const engineLog = path.join(root, "engine-runs.log");
    await writeFile(engineLog, "");
    for (const node of alex.nodes) children.push(await startDevNode(alex, node, { JOINT_BOB_TEST_ENGINE_LOG: engineLog }));
    children.push(await startDevNode(team, maya, { JOINT_BOB_TEST_ENGINE_LOG: engineLog }));
    await pairTwinNodes(alex);
    const [onLaptop, onServer, onMaya] = await Promise.all([signIn(alex, laptop), signIn(alex, server), signIn(team, maya)]);
    const runs = async () => (await readFile(engineLog, "utf8")).split("\n").filter(Boolean);

    const created = await api<{ snapshot: { body: { clusterId: string } } }>(laptop, onLaptop, "POST", "/clusters", { name: "Team" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const clusterId = created.body.snapshot.body.clusterId;
    for (const [node, session] of [[server, onServer], [maya, onMaya]] as const) {
      const invitation = await api<{ link: string }>(laptop, onLaptop, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
      assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
      const joined = await api(node, session, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() });
      assert.equal(joined.status, 201, JSON.stringify(joined.body));
    }
    const project = laptop.projects.find((candidate) => candidate.name === "Internal Assistant")!;
    const shared = await api(laptop, onLaptop, "PUT", `/clusters/${clusterId}/sharing`, { projectIds: [project.id], workspaceIds: [], confirmOwnedData: true });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    await eventually(async () => (await api<{ projects: Array<{ id: string }> }>(maya, onMaya, "GET", "/projects?syncStatus=false")).body.projects?.some((candidate) => candidate.id === project.id) || undefined, "the teammate to receive the project");

    // Alex starts a Claude conversation on the laptop that runs on the server.
    const started = openConversation(laptop, onLaptop, { projectId: project.id, sessionPath: "claude:new", nodeId: server.nodeId });
    sockets.push(started.socket);
    const ready = await until(started.received, ["ready"]);
    assert.equal(ready.executionNodeId, server.nodeId, "the conversation runs on the server");
    assert.equal((await send(started, "Payment retries double-charge. Find the cause.")).type, "promptCompleted");
    assert.deepEqual(await runs(), [`claude:${server.nodeId}`]);
    const sessionId = String(ready.sessionId);

    const row = await eventually(async () => (await api<{ sessions?: SessionRow[] }>(maya, onMaya, "GET", `/projects/${project.id}/sessions`)).body.sessions?.find((candidate) => candidate.id === sessionId), "the teammate to list the conversation");
    assert.equal(row.executionNodeId, server.nodeId, "the teammate's machine knows where the conversation runs");
    const params = { projectId: project.id, sessionPath: row.path, sessionId: row.id, nodeId: server.nodeId };

    // The server does not let other machines run work on it yet: readable, and the page is told why.
    const refused = openConversation(maya, onMaya, params);
    sockets.push(refused.socket);
    const readOnly = await until(refused.received, ["ready"]);
    assert.equal(readOnly.readOnly, true);
    assert.equal(readOnly.readOnlyReason, "runnerAccess", "a refused runner is not reported as a Done ticket");
    assert.equal(readOnly.executionNodeName, server.name, "the page can name the machine whose setting decides");
    refused.socket.close();

    const allowed = await api(server, onServer, "PUT", "/settings", { runnerAccess: { otherNodes: true } });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));

    // Maya writes in the conversation itself.
    const joined = openConversation(maya, onMaya, params);
    sockets.push(joined.socket);
    const writable = await until(joined.received, ["ready"]);
    assert.equal(writable.readOnly, false);
    assert.equal(writable.readOnlyReason, null);
    const answered = await send(joined, "Nice! Can we add a metric for retried payments?");
    assert.equal(answered.type, "promptCompleted", `the teammate's message must run on the server: ${JSON.stringify(answered)}`);
    assert.deepEqual(await runs(), [`claude:${server.nodeId}`, `claude:${server.nodeId}`], "her turn ran on the server, and only there");
    const queued = joined.received.find((frame) => frame.type === "userMessage") as { author?: { username: string } } | undefined;
    assert.equal(queued?.author?.username, "maya", "the message stays hers");

    // And in her fork of it.
    const forked = await fetch(`${maya.url}/api/projects/${project.id}/sessions/fork`, {
      method: "POST", headers: { Cookie: onMaya.cookie, "x-csrf-token": onMaya.csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ engine: "claude", sessionId }),
    });
    assert.equal(forked.status, 201, await forked.clone().text());
    const { session: fork } = await forked.json() as { session: SessionRow };
    assert.equal(fork.executionNodeId, server.nodeId, "a fork is made where its source runs");
    const forkChat = openConversation(maya, onMaya, { projectId: project.id, sessionPath: fork.path, sessionId: fork.id, nodeId: server.nodeId });
    sockets.push(forkChat.socket);
    assert.equal((await until(forkChat.received, ["ready"])).readOnly, false);
    const forkAnswered = await send(forkChat, "What if we cap retries at three?");
    assert.equal(forkAnswered.type, "promptCompleted", `the teammate's fork must run: ${JSON.stringify(forkAnswered)}`);
    assert.equal((await runs()).length, 3);
  } finally {
    for (const socket of sockets) socket.terminate();
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
