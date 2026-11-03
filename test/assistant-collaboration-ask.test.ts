import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { runAsAccount, type ActingAccount } from "../src/account-context.js";
import { failInterruptedAsks, setAskTurnRunner, waitForAsk } from "../src/assistant-collaboration/ask.js";
import { callJointBobTool, JOINT_BOB_TOOL_SERVER, promptStarted, reservedMcpServerName } from "../src/assistant-collaboration/bridge-tools.js";
import { asksForTurns, asksServedBy, getAsk, insertAsk, setAskSwitch } from "../src/assistant-collaboration/store.js";
import { getClusterNode } from "../src/cluster.js";
import { addSharingMember, createSharingCluster, getSharingCluster, registerOwnedResource, setResourceShares } from "../src/cluster-sharing-policy.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { ensureConversationRecord } from "../src/conversation-records.js";
import { kiroAgentProfile, kiroTrustedTools } from "../src/harnesses/kiro/resources.js";
import { managedMcpBridgeConfigs, managedMcpStore, mcpAgentEnvironment, type McpAgentIdentity } from "../src/mcp/agent.js";
import { addPersonalAssistantTopic, beginPersonalAssistantTurn, filterPersonalAssistantTools, finishPersonalAssistantTurn, savePersonalAssistant, type PersonalAssistant, type TurnOrigin } from "../src/personal-assistants.js";
import { getSettings } from "../src/settings.js";
import { addProject } from "../src/store.js";
import { seedDevEnvironment, signIn, api, startDevNode, stopDevNode } from "./dev-nodes.js";

const OWNER_ONLY = "Only your own chat and scheduled tasks can ask your other assistants.";
const ONE_HOP = "An assistant answering another assistant can't ask a third one.";

interface Seeded { assistant: PersonalAssistant; identity: McpAgentIdentity }
async function assistantInPrivateProject(owner: string, name: string): Promise<Seeded> {
  const folder = path.join(os.homedir(), `ask-${name}-${randomUUID()}`);
  await mkdir(folder, { recursive: true });
  const project = await addProject(name, folder, { writeInstructions: false });
  const local = (await getClusterNode()).id, sessionId = randomUUID();
  registerOwnedResource(await clusterV2Database(), { kind: "project", id: project.id, ownerNodeId: local }, local);
  const assistant = await savePersonalAssistant(owner, { projectId: project.id, engine: "pi", sessionId, name, instructions: `${name} steps only it should see` });
  await addPersonalAssistantTopic(owner, assistant.id, { projectId: project.id, engine: "pi", sessionId, source: true });
  await ensureConversationRecord(project.id, "pi", sessionId, local);
  const account: ActingAccount = { accountId: owner, username: owner, role: "admin", isRemoteLogin: false, homeNodeId: null };
  return { assistant, identity: { account, projectId: project.id, conversationId: sessionId, engine: "pi" } };
}
/** A turn of the assistant, and (as harness-chat does while it runs one) its prompt as the conversation's running prompt. */
async function startTurn({ assistant, identity }: Seeded, origin: TurnOrigin, running = true): Promise<string> {
  const requestId = randomUUID();
  await beginPersonalAssistantTurn(assistant.accountId, assistant.id, requestId, `pi:${assistant.sessionId}`, "What is on tomorrow?", origin);
  if (running) promptStarted(identity.projectId, identity.conversationId, requestId);
  return requestId;
}
function answer(result: CallToolResult): Record<string, any> {
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return JSON.parse((result.content[0] as { text: string }).text);
}
function refusal(result: CallToolResult): string {
  assert.equal(result.isError, true, JSON.stringify(result));
  return (result.content[0] as { text: string }).text;
}
function answersWith(response: string, asked: unknown[] = []): void {
  setAskTurnRunner(async (accountId, helperId, requestId, message, options) => {
    asked.push({ accountId, helperId, message, label: options.label, origin: options.origin });
    return { requestId, topicId: "pi:helper-topic", message, response, status: "completed", createdAt: new Date().toISOString() };
  });
}

test("the owner's turn asks a local helper and gets its answer", async () => {
  const a = await assistantInPrivateProject("calendar-owner", "Default"), b = await assistantInPrivateProject("calendar-owner", "Work");
  const asked: unknown[] = [];
  answersWith("3 meetings tomorrow", asked);
  try {
    const turnId = await startTurn(a, "chat");
    const listed = answer(await callJointBobTool(a.identity, "list_assistants", {}));
    assert.deepEqual(listed.assistants.map((view: Record<string, unknown>) => [view.id, Object.keys(view)]), [[b.assistant.id, ["id", "name", "about", "has", "machine"]]], "no instructions");
    const started = answer(await callJointBobTool(a.identity, "ask_assistant", { assistant: b.assistant.id, message: "What work meetings do I have tomorrow?", purpose: "work calendar" }));
    const result = answer(await callJointBobTool(a.identity, "ask_result", { ask: started.ask }));
    assert.equal(result.status, "completed");
    assert.match(result.answer, /3 meetings/);
    assert.deepEqual(asked, [{ accountId: "calendar-owner", helperId: b.assistant.id, message: "What work meetings do I have tomorrow?", label: "Assistant", origin: "assistant" }]);
    const records = await asksForTurns(a.assistant.id, [turnId]);
    assert.deepEqual(records.map(record => [record.status, record.purpose, record.helperId, record.answer]), [["completed", "work calendar", b.assistant.id, "3 meetings tomorrow"]]);

    await setAskSwitch(a.assistant.id, b.assistant.id, false);
    assert.deepEqual(answer(await callJointBobTool(a.identity, "list_assistants", {})).assistants, [], "a switched-off helper isn't listed");
    assert.equal(refusal(await callJointBobTool(a.identity, "ask_assistant", { assistant: b.assistant.id, message: "Again?", purpose: "work calendar" })), "Turned off for this assistant.");
  } finally { setAskTurnRunner(undefined); }
});

test("only the prompt running now can ask, not another one in the same conversation", async () => {
  const a = await assistantInPrivateProject("prompt-owner", "Default"); await assistantInPrivateProject("prompt-owner", "Work");
  const turnId = await startTurn(a, "chat", false);
  assert.equal(refusal(await callJointBobTool(a.identity, "list_assistants", {})), OWNER_ONLY, "no prompt running");
  // A webhook prompt queued straight into the topic runs while the chat turn is still open.
  promptStarted(a.identity.projectId, a.identity.conversationId, randomUUID());
  assert.equal(refusal(await callJointBobTool(a.identity, "list_assistants", {})), OWNER_ONLY);
  promptStarted(a.identity.projectId, a.identity.conversationId, undefined);
  assert.equal(refusal(await callJointBobTool(a.identity, "list_assistants", {})), OWNER_ONLY, "a prompt without a request id");
  promptStarted(a.identity.projectId, a.identity.conversationId, turnId);
  assert.equal(answer(await callJointBobTool(a.identity, "list_assistants", {})).assistants.length, 1);
});

test("webhook and assistant turns can't ask", async () => {
  const a = await assistantInPrivateProject("origin-owner", "Default"), b = await assistantInPrivateProject("origin-owner", "Work");
  answersWith("never asked");
  try {
    const ask = () => callJointBobTool(a.identity, "ask_assistant", { assistant: b.assistant.id, message: "Tomorrow?", purpose: "work calendar" });
    assert.equal(refusal(await ask()), OWNER_ONLY, "no running turn");
    const webhook = await startTurn(a, "webhook");
    assert.equal(refusal(await ask()), OWNER_ONLY);
    await finishPersonalAssistantTurn(a.assistant.accountId, a.assistant.id, webhook, "done");
    await startTurn(a, "assistant");
    assert.equal(refusal(await ask()), ONE_HOP);
    assert.equal(refusal(await callJointBobTool(a.identity, "list_assistants", {})), ONE_HOP);
    assert.deepEqual(await asksServedBy(b.assistant.id), []);
  } finally { setAskTurnRunner(undefined); }
});

test("an assistant in a shared project can't list, ask or read answers", async () => {
  const a = await assistantInPrivateProject("shared-owner", "Default"); await assistantInPrivateProject("shared-owner", "Work");
  await startTurn(a, "chat");
  const db = await clusterV2Database(), local = (await getClusterNode()).id, cluster = randomUUID();
  createSharingCluster(db, { id: cluster, name: "Team" }, local);
  addSharingMember(db, cluster, local, randomUUID(), getSharingCluster(db, cluster).managerEpoch);
  setResourceShares(db, local, "project", a.identity.projectId, [{ clusterId: cluster, projectId: null }]);
  const reason = "Default is in a shared project, so it can't ask your other assistants.";
  assert.equal(refusal(await callJointBobTool(a.identity, "list_assistants", {})), reason);
  assert.equal(refusal(await callJointBobTool(a.identity, "ask_result", { ask: randomUUID() })), reason);
});

test("another assistant's ask is not found", async () => {
  const b = await assistantInPrivateProject("scoped-owner", "Work"), c = await assistantInPrivateProject("scoped-owner", "Shopping");
  const helper = await assistantInPrivateProject("scoped-owner", "Calendar");
  answersWith("Free at 10");
  try {
    await startTurn(b, "chat"); await startTurn(c, "chat");
    const asked = answer(await callJointBobTool(b.identity, "ask_assistant", { assistant: helper.assistant.id, message: "When am I free?", purpose: "free times" }));
    assert.equal(answer(await callJointBobTool(b.identity, "ask_result", { ask: asked.ask })).status, "completed");
    assert.equal(refusal(await callJointBobTool(c.identity, "ask_result", { ask: asked.ask })), "Ask not found.");
    assert.equal(refusal(await callJointBobTool(c.identity, "ask_result", { ask: randomUUID() })), "Ask not found.");
  } finally { setAskTurnRunner(undefined); }
});

test("an ask whose helper turn a restart cut off fails instead of running forever", async () => {
  const a = await assistantInPrivateProject("restart-owner", "Default"), b = await assistantInPrivateProject("restart-owner", "Work");
  const turnId = await startTurn(a, "chat"), id = randomUUID();
  // Written by the process before the restart: running, with no helper turn left in this one.
  await insertAsk({ id, accountId: "restart-owner", askerId: a.assistant.id, askerName: "Default", askerTurnRequestId: turnId, helperId: b.assistant.id, helperName: "Work", helperNodeId: (await getClusterNode()).id, purpose: "work calendar", question: "Tomorrow?", startedAt: new Date().toISOString() });
  const result = answer(await callJointBobTool(a.identity, "ask_result", { ask: id }));
  assert.deepEqual([result.status, result.error], ["failed", "Joint Bob restarted before Work answered. Ask again if you still need it."]);
  assert.equal((await asksForTurns(a.assistant.id, [turnId]))[0].status, "failed");
});

test("a restart ends the asks whose helper turn ran on this machine, and only those", async () => {
  const a = await assistantInPrivateProject("sweep-owner", "Default"), b = await assistantInPrivateProject("sweep-owner", "Work");
  // Before this process loaded the ask module.
  const local = (await getClusterNode()).id, earlier = "2026-01-01T00:00:00.000Z";
  const recorded = async (helperNodeId: string, askerTurnRequestId: string | null) => {
    const id = randomUUID();
    await insertAsk({ id, accountId: "sweep-owner", askerId: a.assistant.id, askerName: "Default", askerTurnRequestId, helperId: b.assistant.id, helperName: "Work", helperNodeId, purpose: "work calendar", question: "Tomorrow?", startedAt: earlier });
    return id;
  };
  // Written before the restart: one this machine served for a twin, one it answered for itself, one a twin was answering.
  const served = await recorded(local, null), ownAsk = await recorded(local, randomUUID()), elsewhere = await recorded(randomUUID(), randomUUID());
  setAskTurnRunner(() => new Promise(() => {}));
  try {
    await startTurn(a, "chat");
    const running = answer(await callJointBobTool(a.identity, "ask_assistant", { assistant: b.assistant.id, message: "Tomorrow?", purpose: "work calendar" }, AbortSignal.abort()));
    await failInterruptedAsks();
    const status = async (id: string) => { const record = (await getAsk(id))!; return [record.status, record.error]; };
    const restarted = ["failed", "Joint Bob restarted before Work answered. Ask again if you still need it."];
    assert.deepEqual([await status(served), await status(ownAsk)], [restarted, restarted]);
    assert.deepEqual(await status(elsewhere), ["running", null], "its helper's machine still has the answer");
    assert.deepEqual(await status(running.ask), ["running", null], "this process is still running that turn");
  } finally { setAskTurnRunner(undefined); }
});

test("status reads that fail in separate waits are not one outage", async t => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (message: string) => { warnings.push(message); });
  const a = await assistantInPrivateProject("outage-owner", "Default");
  // Its helper's machine can't be reached: every status read fails.
  const id = randomUUID();
  await insertAsk({ id, accountId: "outage-owner", askerId: a.assistant.id, askerName: "Default", askerTurnRequestId: randomUUID(), helperId: randomUUID(), helperName: "Work", helperNodeId: randomUUID(), purpose: "work calendar", question: "Tomorrow?", startedAt: new Date().toISOString() });
  // The failure clock reads Date.now; the waits and pauses below run on real timers.
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  assert.equal((await waitForAsk(id, a.assistant.id, 100)).status, "running");
  // The poller finds nobody waiting after its 3 s pause and stops.
  await new Promise(resolve => setTimeout(resolve, 4_500));
  now += 220_000;
  assert.equal((await waitForAsk(id, a.assistant.id, 100)).status, "running", "one failed read 220 s after another");
  // Failures across one wait still end it once they span 60 s.
  const waiting = waitForAsk(id, a.assistant.id, 10_000);
  await new Promise(resolve => setTimeout(resolve, 1_000));
  now += 61_000;
  const ended = await waiting;
  assert.deepEqual([ended.status, ended.error], ["failed", "Couldn't reach Work on its machine."]);
  assert.ok(warnings.some(message => message.startsWith(`Reading asks from`)), JSON.stringify(warnings));
});

test("terminal off keeps the built-in tools", () => {
  assert.deepEqual(filterPersonalAssistantTools(["Bash", "mcp__joint_bob__ask_assistant"], { allowTerminal: false, allowBrowser: false, mcpServerNames: [] }), ["mcp__joint_bob__ask_assistant"]);
  // Only the exact built-in names are exempt; a server named joint_bob__x gets the normal rules.
  assert.deepEqual(filterPersonalAssistantTools(["mcp__joint_bob__ask_assistant", "mcp__joint_bob__x__exec_command"], { allowTerminal: false, allowBrowser: false, mcpServerNames: [] }), ["mcp__joint_bob__ask_assistant"]);
});

test("Joint Bob's server name is reserved however a harness spells it", () => {
  // Claude turns every character outside [a-zA-Z0-9_-] into "_", and Pi turns "-" into "_".
  for (const name of ["joint_bob", "joint-bob", "joint bob", "joint:bob", "joint/bob", "joint@bob", "Joint.Bob.X", "JOINT_BOB__x"]) assert.equal(reservedMcpServerName(name), true, name);
  for (const name of ["jointbob", "joint_bobby", "my_joint_bob", "fine"]) assert.equal(reservedMcpServerName(name), false, name);
});

test("a caller that already went away gets the ask back at once", async () => {
  const a = await assistantInPrivateProject("abort-owner", "Default"), b = await assistantInPrivateProject("abort-owner", "Work");
  setAskTurnRunner(() => new Promise(() => {}));
  try {
    await startTurn(a, "chat");
    const started = Date.now();
    const result = answer(await callJointBobTool(a.identity, "ask_assistant", { assistant: b.assistant.id, message: "Tomorrow?", purpose: "work calendar" }, AbortSignal.abort()));
    assert.equal(result.status, "running");
    assert.ok(Date.now() - started < 10_000, "no 85 s wait");
  } finally { setAskTurnRunner(undefined); }
});

test("the bridge always carries Joint Bob's tools and their server name is reserved", async () => {
  const account: ActingAccount = { accountId: "bridge-owner", username: "bridge", role: "admin", isRemoteLogin: false, homeNodeId: null };
  await runAsAccount(account, async () => {
    assert.deepEqual(Object.keys(managedMcpBridgeConfigs()), [JOINT_BOB_TOOL_SERVER], "no servers installed");
    assert.match(mcpAgentEnvironment("bridge-project", "pi", "bridge-conversation").JOINT_BOB_MCP_TOKEN ?? "", /^[a-f0-9]{64}$/);
    for (const name of ["joint_bob", "joint-bob", "Joint-Bob", "joint_bob_x", "joint-bob-x"]) {
      assert.throws(() => managedMcpStore(account.accountId).install({ [name]: { url: "https://fixture.invalid/mcp" } }), { message: `MCP server name "${name}" is reserved for Joint Bob's own tools. Rename it.` });
    }
    // A server stored under a reserved name before the name was reserved never reaches a harness.
    const store = managedMcpStore(account.accountId);
    await mkdir(store.directory, { recursive: true });
    await writeFile(path.join(store.directory, "servers.json"), JSON.stringify({ "joint-bob": { url: "https://fixture.invalid/old" }, fine: { url: "https://fixture.invalid/fine" } }));
    assert.deepEqual(Object.keys(managedMcpBridgeConfigs()), ["fine", JOINT_BOB_TOOL_SERVER]);
  });
});

test("Kiro with restricted tools still offers and trusts Joint Bob's own", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ask-kiro-"));
  const account: ActingAccount = { accountId: "kiro-owner", username: "kiro", role: "admin", isRemoteLogin: false, homeNodeId: null };
  const written = async (profile: string) => JSON.parse(await readFile(path.join(getSettings().runtimes.kiro.configPath, "agents", `${profile}.json`), "utf8"));
  try {
    const bare = await kiroAgentProfile({ cwd: root, projectId: "kiro-project", sessionId: "kirobare" }, "Synthetic credential context", ["read"]);
    assert.deepEqual([(await written(bare)).tools, kiroTrustedTools(bare, ["read"])], [["read"], ["read"]], "no account, no bridge, nothing to trust");
    await runAsAccount(account, async () => {
      // Kiro asks before an untrusted tool, and restricted sessions cancel every such request.
      const profile = await kiroAgentProfile({ cwd: root, projectId: "kiro-project", sessionId: "kirorestricted" }, "Synthetic credential context", ["read"]);
      assert.deepEqual((await written(profile)).tools, ["read", "@joint_bob"]);
      assert.deepEqual(kiroTrustedTools(profile, ["read"]), ["read", "@joint_bob/list_assistants", "@joint_bob/ask_assistant", "@joint_bob/ask_result"]);
    });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("the agent bridge offers Joint Bob's tools only in assistant topics", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assistant-ask-bridge-"));
  const environment = await seedDevEnvironment(root, 1), node = environment.nodes[0];
  const child = await startDevNode(environment, node);
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const session = await signIn(environment, node), projectId = node.projects[0].id;
    const conversation = (await api<{ sessions: Array<{ id: string; harnessId: string }> }>(node, session, "GET", `/projects/${projectId}/sessions`)).body.sessions[0];
    assert.equal((await api(node, session, "POST", "/personal-assistants", { projectId, engine: conversation.harnessId, sessionId: conversation.id, name: "Default", instructions: "" })).status, 201);
    const now = new Date().toISOString();
    db.prepare("INSERT OR IGNORE INTO conversation_records (project_id, engine, session_id, created_at, updated_at) VALUES (?,?,?,?,?)").run(projectId, conversation.harnessId, conversation.id, now, now);
    const user = db.prepare("SELECT id, username, account_id FROM users WHERE username=?").get(environment.username) as { id: string; username: string; account_id: string };
    db.exec("CREATE TABLE IF NOT EXISTS mcp_agent_tokens (hash TEXT PRIMARY KEY, identity TEXT NOT NULL, expires INTEGER NOT NULL)");
    const token = (conversationId: string) => {
      const value = randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
      const identity = { account: { accountId: user.account_id, userId: user.id, username: user.username, role: "admin", isRemoteLogin: false, homeNodeId: null }, projectId, conversationId, engine: conversation.harnessId };
      db.prepare("INSERT INTO mcp_agent_tokens VALUES (?,?,?)").run(createHash("sha256").update(value).digest("hex"), JSON.stringify(identity), Date.now() + 60_000);
      return value;
    };
    const call = async (bearer: string, body: unknown) => {
      const response = await fetch(`${node.url}/api/mcp/agent`, { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
      return await response.json() as { tools?: Array<{ name: string }>; isError?: boolean; content?: Array<{ text: string }> };
    };
    const topic = token(conversation.id), plain = token(randomUUID());
    assert.deepEqual((await call(topic, { server: JOINT_BOB_TOOL_SERVER, action: "tools" })).tools?.map(tool => tool.name), ["list_assistants", "ask_assistant", "ask_result"]);
    assert.deepEqual((await call(plain, { server: JOINT_BOB_TOOL_SERVER, action: "tools" })).tools, []);
    const refused = await call(topic, { server: JOINT_BOB_TOOL_SERVER, action: "call", tool: "ask_assistant", arguments: { assistant: "anyone", message: "Tomorrow?", purpose: "work calendar" } });
    assert.deepEqual([refused.isError, refused.content?.[0].text], [true, OWNER_ONLY], "no running turn in this topic");
  } finally { db.close(); await stopDevNode(child); await rm(root, { recursive: true, force: true }); }
});
