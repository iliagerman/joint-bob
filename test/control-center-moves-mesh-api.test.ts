import assert from "node:assert/strict";
import { execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

interface Entry { title: string; status: string; detail: string | null; stopped: boolean; continued: boolean | null }
interface Message { id: string; role: string; text: string; via: string | null; importance: string; actions: Array<{ id: string; label: string }> }
interface Job { id: string; mode: string; finishedAt: string | null; entries: Entry[] }

const CONTINUE = (from: string, to: string) => `Continue where you stopped: you were moved from ${from} to ${to}. Check what was half done before repeating anything.`;

async function until<T>(what: string, read: () => Promise<T | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** A stand-in decision model, asked the way the real one is: it reads the machines named after "from" and "to" in the message. */
async function decisionModel(): Promise<{ server: Server; url: string }> {
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { state: string; questions: Record<string, { criteria: Record<string, string> }> };
      const message = (JSON.parse(parsed.state) as { user_message: string }).user_message;
      const after = (word: string) => new RegExp(`${word} (Dev node [AB])`).exec(message)?.[1];
      const named = (criteria: Record<string, string>, name: string | undefined) => Object.entries(criteria).find(([, text]) => text === name)?.[0];
      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(parsed.questions)) {
        const choice = id === "moves" ? (message.includes("move") ? "move" : "other")
          : id === "target" ? named(question.criteria, after("to")) ?? "none"
          : id === "from" ? named(question.criteria, after("from")) ?? "any"
          : id === "which" ? "all" : Object.keys(question.criteria)[0];
        answers[id] = { type: "choice", choice, confidence: 0.97 };
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ answers }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/systemone` };
}

/** A browser-less page open on a conversation of one node, signed by that node as a routed node session. */
function openConversation(environment: DevEnvironment, node: SeededNode, projectId: string, sessionPath: string): Promise<WebSocket> {
  const url = new URL("/ws", node.url.replace(/^http/, "ws"));
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("sessionPath", sessionPath);
  url.searchParams.set("nodeSession", "1");
  const authorization = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import {DatabaseSync} from 'node:sqlite';
    import {signClusterRequest} from './src/cluster-protocol.ts';
    const db=new DatabaseSync(process.env.JOINT_BOB_DATA_DIR+'/node.db');
    process.stdout.write(signClusterRequest(db,${JSON.stringify(node.nodeId)},${JSON.stringify(node.nodeId)},'GET',${JSON.stringify(url.pathname + url.search)},Buffer.alloc(0)));db.close();
  `], { env: { ...process.env, HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir }, encoding: "utf8" });
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Authorization: authorization } });
    const timeout = setTimeout(() => reject(new Error("WebSocket ready timed out")), 10_000);
    socket.on("message", (raw) => {
      if ((JSON.parse(raw.toString()) as { type?: string }).type !== "ready") return;
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

test("two real servers move a conversation: now, after its turn, and by stopping the turn and telling it to continue", { timeout: 300_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-moves-mesh-"));
  const classifier = await decisionModel();
  const children: ChildProcess[] = [];
  const sockets: WebSocket[] = [];
  try {
    const environment = await seedDevEnvironment(root, 2);
    const [a, b] = environment.nodes;
    const project = a.projects[0];
    const sessionRoot = path.join(environment.home, ".pi", "sessions");
    const transcript = path.join(sessionRoot, "mesh-session.jsonl");
    const log = path.join(root, "invocations.log");
    const holds = path.join(root, "holds");
    const stubs = path.join(root, "stubs");
    await Promise.all([mkdir(sessionRoot, { recursive: true }), mkdir(holds, { recursive: true }), mkdir(stubs, { recursive: true })]);
    await writeFile(transcript, `${JSON.stringify({ type: "session", version: 3, id: "mesh-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: project.path })}\n${JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Continue this conversation" }] } })}\n`);
    for (const node of [a, b]) children.push(await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: log, JOINT_BOB_TEST_ENGINE_HOLD_DIR: holds, JOINT_BOB_TYPESAFE_ENDPOINT: classifier.url, JOINT_BOB_TEST_AUTOMATION_DIR: stubs }));
    await pairTwinNodes(environment);
    const signed = new Map<SeededNode, SignedIn>([[a, await signIn(environment, a)], [b, await signIn(environment, b)]]);
    const call = <T>(node: SeededNode, method: string, endpoint: string, body?: unknown) => api<T>(node, signed.get(node)!, method, endpoint, body);
    const ref = { projectId: project.id, conversationId: "mesh-session" };
    const runs = async (node: SeededNode) => (await readFile(log, "utf8").catch(() => "")).split("\n").filter((line) => line === `pi:${node.nodeId}`).length;
    const owner = async () => {
      const reply = await signedNodeRequest(environment, a, b, "GET", "/api/cluster/v2/runtime/sessions/ownership?engine=pi&sessionId=mesh-session");
      return (await reply.json() as { ownership: { ownerNodeId: string; epoch: number } }).ownership;
    };
    const start = async (node: SeededNode, target: SeededNode, mode: "after-turn" | "now") => {
      const started = await call<{ job: Job }>(node, "POST", "/control-center/moves", { target: target.nodeId, mode, conversations: [ref] });
      assert.equal(started.status, 202, JSON.stringify(started.body));
      return started.body.job.id;
    };
    const follow = async (node: SeededNode, id: string) => (await call<{ job: Job }>(node, "GET", `/control-center/moves/${id}`)).body.job;
    const finished = (node: SeededNode, id: string) => until("the batch to finish", async () => { const job = await follow(node, id); return job.finishedAt ? job : undefined; });

    // The conversation starts on A. A is asked about moving it to B: B answers the check as itself.
    const claimed = await call<{ ownership: { ownerNodeId: string; epoch: number } }>(a, "POST", `/projects/${project.id}/sessions/take-ownership`, { peerId: a.nodeId, sessionId: "mesh-session", sessionPath: transcript });
    assert.equal(claimed.body.ownership.ownerNodeId, a.nodeId);
    const machines = await call<{ nodes: Array<{ id: string; name: string; local: boolean; online: boolean }> }>(a, "GET", "/control-center/moves/nodes");
    assert.deepEqual(machines.body.nodes.map((node) => [node.id, node.local, node.online]), [[a.nodeId, true, true], [b.nodeId, false, true]]);
    const plan = await call<{ entries: Array<{ verdict: string; from: string; reasons: string[] }> }>(a, "POST", "/control-center/moves/plan", { target: b.nodeId, conversations: [ref] });
    assert.deepEqual(plan.body.entries.map((entry) => [entry.verdict, entry.from, entry.reasons]), [["ready", a.name, []]]);

    // 1. Idle conversation, moved through the real ownership transfer to another machine.
    const first = await finished(a, await start(a, b, "after-turn"));
    assert.deepEqual(first.entries.map((entry) => [entry.status, entry.stopped, entry.continued]), [["moved", false, null]]);
    assert.deepEqual(await owner(), { engine: "pi", sessionId: "mesh-session", ownerNodeId: b.nodeId, epoch: 2, status: "owned", transferToNodeId: null });
    const already = await call<{ entries: Array<{ verdict: string }> }>(a, "POST", "/control-center/moves/plan", { target: b.nodeId, conversations: [ref] });
    assert.deepEqual(already.body.entries.map((entry) => entry.verdict), ["there"]);

    // 2. A turn is running on B; moving it back "after the current turn" waits, then moves, and sends nothing.
    sockets.push(await openConversation(environment, b, project.id, transcript));
    sockets[0].send(JSON.stringify({ type: "prompt", message: "a long turn on B", requestId: randomUUID() }));
    await until("the turn to start on B", async () => (await runs(b)) === 1);
    const waiting = await start(a, a, "after-turn");
    await until("the conversation to wait", async () => (await follow(a, waiting)).entries[0].status === "waiting");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.equal((await owner()).ownerNodeId, b.nodeId, "it stays where it runs while its turn does");
    await writeFile(path.join(holds, "pi.release"), "release");
    const second = await finished(a, waiting);
    assert.deepEqual(second.entries.map((entry) => [entry.status, entry.stopped, entry.continued]), [["moved", false, null]]);
    assert.deepEqual([(await owner()).ownerNodeId, (await owner()).epoch], [a.nodeId, 3]);
    assert.equal(await runs(b), 1, "nothing was sent to the conversation");

    // 3. A turn is running on A; "stop and move now" stops it, moves it to B and tells it to continue there.
    await rm(path.join(holds, "pi.release"));
    sockets.push(await openConversation(environment, a, project.id, transcript));
    sockets[1].send(JSON.stringify({ type: "prompt", message: "a long turn on A", requestId: randomUUID() }));
    await until("the turn to start on A", async () => (await runs(a)) === 1);
    const now = await start(a, b, "now");
    await until("the running turn to be stopped", async () => ["stopping"].includes((await follow(a, now)).entries[0].status));
    // The stubbed engine cannot be interrupted, so the test lets its turn end where a real stop would.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await writeFile(path.join(holds, "pi.release"), "release");
    const third = await finished(a, now);
    assert.deepEqual(third.entries.map((entry) => [entry.status, entry.stopped, entry.continued]), [["moved", true, true]], JSON.stringify(third));
    assert.deepEqual([(await owner()).ownerNodeId, (await owner()).epoch], [b.nodeId, 4]);
    await until("the continue message to run on B", async () => (await runs(b)) === 2);
    await until("the continue message in the transcript", async () => (await readFile(transcript, "utf8")).includes(CONTINUE(a.name, b.name)));
    assert.equal((await readFile(transcript, "utf8")).split(CONTINUE(a.name, b.name)).length - 1, 1, "it was sent once");

    // 4. Said to Bob: he lists what moves and asks once; the button moves it after its turn and Bob reports.
    const account = await call<{ account: { id: string } }>(a, "POST", "/secrets/accounts", { label: "decision", provider: "custom", variables: [{ name: "TYPESAFE_AI_API_KEY", kind: "value", value: "test-key" }] });
    assert.equal((await call(a, "PUT", `/secrets/scopes/project/${project.id}`, { accountIds: [account.body.account.id] })).status, 200);
    await rm(path.join(holds, "pi.release"));
    sockets.push(await openConversation(environment, b, project.id, transcript));
    sockets[2].send(JSON.stringify({ type: "prompt", message: "a long turn on B again", requestId: randomUUID() }));
    await until("the turn to start on B again", async () => (await runs(b)) === 3);
    await until("A to see the turn running on B", async () => (await call<{ cards: Array<{ conversationId: string; column: string }> }>(a, "GET", "/control-center/board")).body.cards.some((card) => card.conversationId === "mesh-session" && card.column === "running"));
    // A's board shows the summary B keeps for the conversation it runs: A asks B for it.
    const onB = new DatabaseSync(path.join(b.dataDir, "node.db"));
    try {
      onB.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS transcript_summaries(kind TEXT NOT NULL, file TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind, file))");
      onB.prepare("INSERT OR REPLACE INTO transcript_summaries VALUES ('conversation-digest', ?, ?)").run(`${project.id}:mesh-session`, JSON.stringify({ summary: "**Goal** — Check the mesh, kept on B.", turns: 1, updatedAt: new Date().toISOString() }));
    } finally { onB.close(); }
    await until("A's card to show B's summary", async () => (await call<{ cards: Array<{ conversationId: string; summary: string | null }> }>(a, "GET", "/control-center/board")).body.cards.find((card) => card.conversationId === "mesh-session")?.summary === "**Goal** — Check the mesh, kept on B.");
    // Asked on A to write it, Bob has B, which runs it, write it there: A's chat gets it, and A's card shows it.
    const meshCard = (await call<{ cards: Array<{ conversationId: string; title: string }> }>(a, "GET", "/control-center/board")).body.cards.find((card) => card.conversationId === "mesh-session")!;
    await writeFile(path.join(stubs, "organize.json"), JSON.stringify({ intent: "summarize-conversations", conversations: [`conversation-titled:${meshCard.title}`] }));
    const summarizing = await call<{ reply: Message }>(a, "POST", "/control-center/bob/message", { message: "write the summary of that conversation" });
    assert.equal(summarizing.body.reply?.text, `Writing the summary of "${meshCard.title}". I'll post it here when it is written.`, JSON.stringify(summarizing.body));
    const written = await until("A's chat to get the summary B wrote", async () => (await call<{ messages: Message[] }>(a, "GET", "/control-center/bob/messages")).body.messages.find((message) => message.text.startsWith(`"${meshCard.title}": summary`)));
    const summary = written.text.split("\n\n").slice(1).join("\n\n");
    assert.match(summary, /^\*\*Goal\*\* — Continue this conversation/, "B wrote a new one from its transcript");
    await until("A's card to show the summary B wrote", async () => (await call<{ cards: Array<{ conversationId: string; summary: string | null }> }>(a, "GET", "/control-center/board")).body.cards.find((card) => card.conversationId === "mesh-session")?.summary === summary);
    const asked = await call<{ action: string; reply: Message }>(a, "POST", "/control-center/bob/message", { message: `move all my running jobs from ${b.name} to ${a.name}` });
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const proposal = asked.body.reply;
    assert.match(proposal.via ?? "", /^Move jobs · Dev node B → Dev node A · decision model 97%/);
    assert.equal(proposal.importance, "needs-you", proposal.text);
    assert.match(proposal.text, /^Move 1 job from Dev node B to Dev node A\?\n- Continue this conversation \(.+\): moves when its current turn ends/);
    assert.deepEqual(proposal.actions.map((action) => action.id), ["moves.after-turn", "moves.now", "moves.cancel"]);
    assert.deepEqual(proposal.actions.map((action) => action.label), ["Move 1", "Stop and move all now", "Cancel"]);
    const pressed = await call<{ messages: Message[] }>(a, "POST", "/control-center/bob/action", { messageId: proposal.id, actionId: "moves.after-turn" });
    assert.equal(pressed.status, 200, JSON.stringify(pressed.body));
    assert.match(pressed.body.messages[0].text, /^Moving 1 job to Dev node A: each moves when its current turn ends\./);
    const again = await call(a, "POST", "/control-center/bob/action", { messageId: proposal.id, actionId: "moves.now" });
    assert.equal(again.status, 404, "one answer for the whole batch: the buttons are gone");
    assert.equal((await owner()).ownerNodeId, b.nodeId, "it waits for its turn");
    await writeFile(path.join(holds, "pi.release"), "release");
    const report = await until("Bob's report", async () => (await call<{ messages: Message[] }>(a, "GET", "/control-center/bob/messages")).body.messages.find((message) => message.text.startsWith("Moved 1 of 1 to Dev node A.")));
    assert.deepEqual([report.role, report.importance, report.via], ["bob", "done", "Move jobs · finished"]);
    assert.deepEqual([(await owner()).ownerNodeId, (await owner()).epoch], [a.nodeId, 5]);
  } finally {
    classifier.server.close();
    for (const socket of sockets) socket.terminate();
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
