import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { browserAgentEnvironment, browserAgentIdentity, browserAgentInstructions } from "../src/browser-agent.js";
import { resolveDataDirectory } from "../src/data-directory.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { openChat, waitFor } from "./queued-prompt-harness.js";

test("browser tokens carry immutable project/engine/conversation identity and only hashes persist", async () => {
  const identities = [
    { projectId: "p", engine: "pi" as const, conversationId: "one" },
    { projectId: "q", engine: "pi" as const, conversationId: "one" },
    { projectId: "p", engine: "claude" as const, conversationId: "one" },
    { projectId: "p", engine: "pi" as const, conversationId: "two" },
  ];
  const tokens = new Set<string>();
  for (const identity of identities) {
    const env = browserAgentEnvironment(identity.projectId, identity.engine, identity.conversationId);
    const token = env.JOINT_BOB_BROWSER_TOKEN!;
    assert.match(token, /^[a-f0-9]{64}$/);
    tokens.add(token);
    assert.deepEqual(browserAgentIdentity(token), identity);
    assert.equal(env.JOINT_BOB_BROWSER_URL, `http://127.0.0.1:${process.env.PORT || 8790}/api/browser/agent`);
    assert.equal(env.JOINT_BOB_BROWSER_CLI, path.resolve("bin/joint-bob-browser.mjs"));
    await access(env.JOINT_BOB_BROWSER_CLI!);
    assert.ok(!browserAgentInstructions.includes(token));
  }
  assert.equal(tokens.size, identities.length);
  const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
  try {
    const rows = db.prepare("SELECT * FROM browser_agent_tokens").all();
    for (const token of tokens) {
      assert.ok(!JSON.stringify(rows).includes(token));
      assert.ok(JSON.stringify(rows).includes(createHash("sha256").update(token).digest("hex")));
    }
  } finally { db.close(); }
});

test("browser tokens expire at 30 days, reject malformed/unknown tokens, and clean expired rows", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const env = browserAgentEnvironment("expiry", "claude", "session");
  for (const token of ["", "bad", "a".repeat(64), `${env.JOINT_BOB_BROWSER_TOKEN}x`]) assert.equal(browserAgentIdentity(token), undefined);
  t.mock.timers.tick(30 * 24 * 60 * 60 * 1000 - 1);
  assert.equal(browserAgentIdentity(env.JOINT_BOB_BROWSER_TOKEN!)?.projectId, "expiry");
  t.mock.timers.tick(1);
  assert.equal(browserAgentIdentity(env.JOINT_BOB_BROWSER_TOKEN!), undefined);
  browserAgentEnvironment("fresh", "pi", "session");
  const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM browser_agent_tokens").get()!.n, 1); }
  finally { db.close(); t.mock.timers.reset(); }
});

test("Pi new and resumed sessions receive browser instructions and one stable merged bash environment", async () => {
  const { createPiSession } = await import("../src/pi-service.js");
  const { addProject } = await import("../src/store.js");
  const { saveSecretAccount, setScopeSecretAccounts } = await import("../src/secrets.js");
  const cwd = path.join(os.homedir(), "browser-agent-project");
  await mkdir(cwd, { recursive: true });
  const project = await addProject("Browser agent test", cwd, { writeInstructions: false });
  const account = await saveSecretAccount({ label: "Fixture", provider: "custom", variables: [{ name: "BRIDGE_FIXTURE", kind: "value", value: "first" }] });
  await setScopeSecretAccounts("project", project.id, [account.id]);
  const resumed = path.join(cwd, "resumed.jsonl");
  await writeFile(resumed, JSON.stringify({ type: "session", version: 3, id: "existing-browser-conversation", timestamp: new Date().toISOString(), cwd }) + "\n");
  const { ensureConversationRecord } = await import("../src/conversation-records.js");
  const { getClusterNode } = await import("../src/cluster.js");
  await ensureConversationRecord(project.id, "pi", "existing-browser-conversation", (await getClusterNode()).id, undefined, { conversationId: "canonical-browser-conversation", segmentIndex: 1 });
  for (const sessionPath of [undefined, resumed]) {
    const handle = await createPiSession({ cwd, projectId: project.id, sessionPath });
    try {
      assert.ok(handle.session.agent.state.systemPrompt.includes(browserAgentInstructions));
      const bash = handle.session.agent.state.tools.find((tool) => tool.name === "bash")!;
      const execute = async () => {
        const result = await bash.execute("bridge-test", { command: `node -e 'console.log(JSON.stringify({token:process.env.JOINT_BOB_BROWSER_TOKEN,secret:process.env.BRIDGE_FIXTURE}))'` });
        return JSON.parse(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
      };
      const first = await execute();
      assert.deepEqual(browserAgentIdentity(first.token), { projectId: project.id, engine: "pi", conversationId: sessionPath ? "canonical-browser-conversation" : handle.session.sessionManager.getSessionId() });
      await saveSecretAccount({ id: account.id, label: "Fixture", provider: "custom", variables: [{ name: "BRIDGE_FIXTURE", kind: "value", value: "changed" }] });
      assert.deepEqual(await execute(), first, "bash spawns must not refresh token or attached secrets");
      assert.ok(!handle.session.agent.state.systemPrompt.includes(first.token));
    } finally { handle.dispose(); }
  }
});

test("Claude new and resumed spawns receive browser identity and keep attached environment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-claude-"));
  let child: Awaited<ReturnType<typeof startDevNode>> | undefined;
  const sockets: ReturnType<typeof openChat>["socket"][] = [];
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const project = node.projects[0];
    const capture = path.join(root, "capture.jsonl");
    const executable = path.join(root, "claude-fixture.mjs");
    await writeFile(executable, `#!/usr/bin/env node
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
if (process.argv[2] === 'auth') { console.log(JSON.stringify({loggedIn:true})); process.exit(0); }
let prompt = ''; for await (const chunk of process.stdin) prompt += chunk;
const args = process.argv.slice(2);
const sessionId = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
await appendFile(${JSON.stringify(capture)}, JSON.stringify({ sessionId, prompt, token: process.env.JOINT_BOB_BROWSER_TOKEN, url: process.env.JOINT_BOB_BROWSER_URL, cli: process.env.JOINT_BOB_BROWSER_CLI, secret: process.env.CLAUDE_BRIDGE_FIXTURE }) + '\\n');
const directory = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME, '.claude'), 'projects', process.cwd().replace(/[^a-zA-Z0-9-]/g, '-'));
await mkdir(directory, {recursive:true});
await appendFile(path.join(directory, sessionId + '.jsonl'), JSON.stringify({type:'user', sessionId, cwd:process.cwd(), timestamp:new Date().toISOString(), message:{role:'user',content:prompt}}) + '\\n');
console.log(JSON.stringify({type:'system',subtype:'init',session_id:sessionId}));
console.log(JSON.stringify({type:'result',is_error:false}));
`);
    await chmod(executable, 0o755);
    const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
    try { db.prepare("UPDATE node_settings SET value = ? WHERE key = 'claude.executable'").run(executable); }
    finally { db.close(); }
    child = await startDevNode(environment, node);
    const auth = await signIn(environment, node);
    const saved = await api<{ account: { id: string } }>(node, auth, "POST", "/secrets/accounts", { label: "Browser fixture", provider: "custom", variables: [{ name: "CLAUDE_BRIDGE_FIXTURE", kind: "value", value: "dummy-attached-value" }] });
    assert.equal(saved.status, 201);
    assert.equal((await api(node, auth, "PUT", `/secrets/scopes/project/${project.id}`, { accountIds: [saved.body.account.id] })).status, 200);
    const chat = openChat(node.url, auth.cookie, project.id, "claude:new");
    sockets.push(chat.socket);
    await waitFor(chat.messages, () => chat.messages.some((frame) => frame.type === "ready"));
    for (const message of ["first browser turn", "resumed browser turn"]) {
      chat.socket.send(JSON.stringify({ type: "prompt", message }));
      const count = message.startsWith("first") ? 1 : 2;
      await waitFor(chat.messages, () => chat.messages.filter((frame) => frame.type === "agent_end").length === count);
    }
    const runs = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(runs.length, 2);
    assert.equal(runs[0].sessionId, runs[1].sessionId);
    assert.notEqual(runs[0].token, runs[1].token, "Claude gets a new environment each spawn");
    const tokens = new DatabaseSync(path.join(node.dataDir, "node.db"));
    try {
      for (const run of runs) {
        assert.match(run.token, /^[a-f0-9]{64}$/);
        assert.equal(run.url, `${node.url}/api/browser/agent`);
        assert.equal(run.cli, path.resolve("bin/joint-bob-browser.mjs"));
        assert.equal(run.secret, "dummy-attached-value");
        assert.ok(!run.prompt.includes(run.token));
        const row = tokens.prepare("SELECT project_id, engine, conversation_id FROM browser_agent_tokens WHERE token_hash = ?").get(createHash("sha256").update(run.token).digest("hex"))!;
        assert.deepEqual({ ...row }, { project_id: project.id, engine: "claude", conversation_id: run.sessionId });
      }
    } finally { tokens.close(); }
  } finally {
    for (const socket of sockets) socket.terminate();
    if (child) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});
