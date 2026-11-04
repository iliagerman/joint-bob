import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, before } from "node:test";
import type { ChildProcess } from "node:child_process";
import { JOINT_BOB_TOOL_SERVER } from "../src/assistant-collaboration/bridge-tools.js";
import { addSharingMember, createSharingCluster, getSharingCluster, setResourceShares } from "../src/cluster-sharing-policy.js";
import { api, pairTwinNodes, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

// A ("Default") runs on node one and asks B ("Work"), which runs on node two, its twin.
// test/stub-ask-bootstrap.ts stands in for the asking turn's prompt on node one and B's agent on node two.
const ANSWER = "Two work meetings on Tuesday";
const ASKER_CONVERSATION = "canvas-picker-readability", HELPER_CONVERSATION = "terraform-state-locking";

let root: string, env: DevEnvironment, one: SeededNode, two: SeededNode;
const children: ChildProcess[] = [];
let helperEnv: Record<string, string>, helperLog: string, helperId: string, helperProjectId: string, token: string;

function database(node: SeededNode): DatabaseSync {
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  db.exec("PRAGMA busy_timeout=5000");
  return db;
}
function withDatabase<T>(node: SeededNode, read: (db: DatabaseSync) => T): T {
  const db = database(node);
  try { return read(db); } finally { db.close(); }
}
/** A transaction cannot start writing once the running node has written since it began. SQLite says so at once, whatever the busy timeout. */
function whileLocked<T>(write: () => T): T {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try { return write(); } catch (error) {
      if (!/database is locked/.test(String(error)) || Date.now() > deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
}
async function eventually<T>(check: () => T | undefined, limitMs: number): Promise<T> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const found = check();
    if (found !== undefined) return found;
    assert.ok(Date.now() < deadline, "timed out");
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}
const hasTable = (db: DatabaseSync, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(name));
async function loggedTurns(askId: string): Promise<number> {
  return (await readFile(helperLog, "utf8").catch(() => "")).split("\n").filter(line => line === askId).length;
}

/** One joint_bob tool call made by A's agent on node one. */
async function tool(name: string, args: Record<string, unknown>): Promise<{ ask?: string; status?: string; answer?: string; error?: string; refusal?: string }> {
  const response = await fetch(`${one.url}/api/mcp/agent`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ server: JOINT_BOB_TOOL_SERVER, action: "call", tool: name, arguments: args }) });
  assert.equal(response.status, 200);
  const body = await response.json() as { isError?: boolean; content: Array<{ text: string }> };
  return body.isError ? { refusal: body.content[0].text } : JSON.parse(body.content[0].text);
}

async function createAssistant(node: SeededNode, projectId: string, sessionId: string, name: string): Promise<string> {
  const session = await signIn(env, node);
  const created = await api<{ assistant: { id: string } }>(node, session, "POST", "/personal-assistants", { projectId, engine: "pi", sessionId, name, instructions: `${name} helps` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.assistant.id;
}

/** A's chat turn, running now, and an agent token for its conversation, as harness-chat and the agent bridge set them up. */
function askingTurn(askerId: string, askerProjectId: string, requestId: string): string {
  return withDatabase(one, db => {
    const now = new Date().toISOString();
    db.prepare("INSERT OR IGNORE INTO conversation_records (project_id, engine, session_id, created_at, updated_at) VALUES (?,?,?,?,?)").run(askerProjectId, "pi", ASKER_CONVERSATION, now, now);
    db.prepare("INSERT INTO personal_assistant_turns (assistant_id,request_id,turn_index,topic_id,message,response,status,created_at,origin) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(askerId, requestId, 0, `pi:${ASKER_CONVERSATION}`, "What is on this week?", null, "running", now, "chat");
    const user = db.prepare("SELECT id, username, account_id FROM users WHERE username=?").get(env.username) as { id: string; username: string; account_id: string };
    db.exec("CREATE TABLE IF NOT EXISTS mcp_agent_tokens (hash TEXT PRIMARY KEY, identity TEXT NOT NULL, expires INTEGER NOT NULL)");
    const value = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
    const identity = { account: { accountId: user.account_id, userId: user.id, username: user.username, role: "admin", isRemoteLogin: false, homeNodeId: null }, projectId: askerProjectId, conversationId: ASKER_CONVERSATION, engine: "pi" };
    db.prepare("INSERT INTO mcp_agent_tokens VALUES (?,?,?)").run(createHash("sha256").update(value).digest("hex"), JSON.stringify(identity), Date.now() + 3_600_000);
    return value;
  });
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "assistant-ask-twins-"));
  env = await seedDevEnvironment(root, 2);
  [one, two] = env.nodes;
  const askerProjectId = projectNamed(one, "Joint Bob").id, requestId = randomUUID();
  helperProjectId = projectNamed(two, "Infra Scripts").id;
  helperLog = path.join(root, "helper-turns.log");
  helperEnv = { JOINT_BOB_TEST_MULTI_USER_READY: "1", JOINT_BOB_TEST_ASK_LOG: helperLog, JOINT_BOB_TEST_ASK_ANSWER: ANSWER };
  children.push(await startDevNode(env, one, { JOINT_BOB_TEST_MULTI_USER_READY: "1", JOINT_BOB_TEST_ASK_LOG: path.join(root, "asker-turns.log"), JOINT_BOB_TEST_ASK_PROMPT: JSON.stringify({ projectId: askerProjectId, conversationId: ASKER_CONVERSATION, requestId }) }));
  children.push(await startDevNode(env, two, helperEnv));
  await pairTwinNodes(env);
  const askerId = await createAssistant(one, askerProjectId, ASKER_CONVERSATION, "Default");
  helperId = await createAssistant(two, helperProjectId, HELPER_CONVERSATION, "Work");
  // B's machine announces it; node one learns of it only from that.
  await eventually(() => withDatabase(one, db => hasTable(db, "assistant_twin_summaries") && db.prepare("SELECT 1 FROM assistant_twin_summaries WHERE assistant_id=?").get(helperId) ? true : undefined), 30_000);
  token = askingTurn(askerId, askerProjectId, requestId);
}, { timeout: 300_000 });

after(async () => {
  await Promise.all(children.map(stopDevNode));
  await rm(root, { recursive: true, force: true });
});

test("an assistant on one machine asks a helper on the twin", { timeout: 120_000 }, async () => {
  const asked = await tool("ask_assistant", { assistant: helperId, message: "What work meetings do I have this week?", purpose: "work calendar" });
  assert.deepEqual([asked.status, asked.answer], ["completed", ANSWER], JSON.stringify(asked));
  const result = await tool("ask_result", { ask: asked.ask });
  assert.deepEqual([result.status, result.answer], ["completed", ANSWER]);
  const served = withDatabase(two, db => db.prepare("SELECT id, asker_name askerName, status, answer FROM assistant_asks WHERE helper_id=?").all(helperId));
  assert.deepEqual(served.map(row => ({ ...row })), [{ id: asked.ask, askerName: "Default", status: "completed", answer: ANSWER }]);
  assert.equal(await loggedTurns(asked.ask!), 1);

  // The same start arriving again is acknowledged and never runs a second turn.
  const accountId = withDatabase(one, db => (db.prepare("SELECT account_id FROM users WHERE username=?").get(env.username) as { account_id: string }).account_id);
  const askerId = withDatabase(two, db => (db.prepare("SELECT asker_id FROM assistant_asks WHERE id=?").get(asked.ask!) as { asker_id: string }).asker_id);
  const again = await signedNodeRequest(env, one, two, "POST", "/api/cluster/v2/assistants/ask", { askId: asked.ask, accountId, askerId, askerName: "Default", helperId, message: "What work meetings do I have this week?", purpose: "work calendar" });
  assert.deepEqual([again.status, await again.json()], [202, { askId: asked.ask }]);
  assert.equal(await loggedTurns(asked.ask!), 1);
  const status = (askId: string, asker: string) => signedNodeRequest(env, one, two, "POST", "/api/cluster/v2/assistants/ask-status", { askId, askerId: asker });
  assert.deepEqual(await (await status(asked.ask!, askerId)).json(), { status: "completed", answer: ANSWER });
  assert.equal((await status(randomUUID(), askerId)).status, 404);
  assert.equal((await status(asked.ask!, "another-assistant")).status, 404, "only the asker reads it");

  // The helper's machine checks the ask again before it records anything.
  const start = (body: Record<string, unknown>) => signedNodeRequest(env, one, two, "POST", "/api/cluster/v2/assistants/ask", { askId: randomUUID(), accountId, askerId, askerName: "Default", helperId, message: "Tomorrow?", purpose: "work calendar", ...body });
  const [stranger, unknown] = [randomUUID(), randomUUID()];
  assert.equal((await start({ askId: stranger, accountId: "someone-else" })).status, 403, "only the owner's own account");
  const missing = await start({ askId: unknown, helperId: randomUUID() });
  assert.deepEqual([missing.status, await missing.json()], [409, { error: "That assistant isn't on this machine anymore." }]);
  assert.equal(withDatabase(two, db => db.prepare("SELECT COUNT(*) n FROM assistant_asks WHERE id IN (?,?)").get(stranger, unknown) as { n: number }).n, 0);
  assert.equal((await loggedTurns(stranger)) + (await loggedTurns(unknown)), 0);
});

test("a helper whose project became shared refuses on its own machine", { timeout: 120_000 }, async () => {
  // Node one owns the mirrored projects, so the share is made as node one, into a cluster node two manages with node one in it.
  const cluster = randomUUID();
  withDatabase(two, db => {
    assert.equal((db.prepare("SELECT owner_node_id owner FROM sharing_resource_owners WHERE kind='project' AND resource_id=?").get(helperProjectId) as { owner: string }).owner, one.nodeId);
    whileLocked(() => createSharingCluster(db, { id: cluster, name: "Team" }, two.nodeId));
    whileLocked(() => addSharingMember(db, cluster, two.nodeId, one.nodeId, getSharingCluster(db, cluster).managerEpoch));
    whileLocked(() => setResourceShares(db, one.nodeId, "project", helperProjectId, [{ clusterId: cluster, projectId: null }]));
  });
  try {
    const cached = withDatabase(one, db => JSON.parse((db.prepare("SELECT summary FROM assistant_twin_summaries WHERE assistant_id=?").get(helperId) as { summary: string }).summary) as { private: boolean });
    assert.equal(cached.private, true, "node one still thinks Work is private");
    const asked = await tool("ask_assistant", { assistant: helperId, message: "What work meetings do I have this week?", purpose: "work calendar" });
    assert.deepEqual([asked.status, asked.error], ["failed", "Work is in a shared project, so other assistants can't ask it."], JSON.stringify(asked));
    assert.equal(await loggedTurns(asked.ask!), 0);
    assert.equal(withDatabase(two, db => db.prepare("SELECT 1 FROM assistant_asks WHERE id=?").get(asked.ask!)), undefined);
  } finally {
    // Private again, as the other tests expect it.
    withDatabase(two, db => whileLocked(() => setResourceShares(db, one.nodeId, "project", helperProjectId, [])));
  }
});

test("a stopped twin fails the ask without retrying", { timeout: 360_000 }, async () => {
  const asked = await tool("ask_assistant", { assistant: helperId, message: "[hold] Which meetings move next week?", purpose: "work calendar" });
  assert.equal(asked.status, "running", JSON.stringify(asked));
  await stopDevNode(children[1]);
  const stopped = Date.now();
  const result = await tool("ask_result", { ask: asked.ask });
  assert.deepEqual([result.status, result.error], ["failed", "Couldn't reach Work on Dev node B."], JSON.stringify(result));
  assert.ok(Date.now() - stopped < 70_000, `failed after ${Date.now() - stopped} ms`);

  children[1] = await startDevNode(env, two, helperEnv);
  // At startup node two ends the ask its lost turn was answering, without running it again.
  const served = await eventually(() => withDatabase(two, db => {
    const row = db.prepare("SELECT status, error FROM assistant_asks WHERE id=?").get(asked.ask!) as { status: string; error: string | null };
    return row.status === "running" ? undefined : { ...row };
  }), 30_000);
  assert.deepEqual(served, { status: "failed", error: "Joint Bob restarted before Work answered. Ask again if you still need it." });
  // Anything that would send the ask again has had time to: node one sees node two return.
  await new Promise(resolve => setTimeout(resolve, 5_000));
  assert.equal((await tool("ask_result", { ask: asked.ask })).status, "failed");
  assert.equal(await loggedTurns(asked.ask!), 1, "no second turn on the helper's machine");
  assert.equal(withDatabase(two, db => db.prepare("SELECT COUNT(*) n FROM assistant_asks WHERE id=?").get(asked.ask!) as { n: number }).n, 1);
});

