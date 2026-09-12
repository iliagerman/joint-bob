import assert from "node:assert/strict";
import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SignedIn } from "../dev-nodes.js";
import type { BrowserSessionView } from "../../src/browser-types.js";

const browserEnv = process.env.CHROME_PATH ? { JOINT_BOB_BROWSER_EXECUTABLE: process.env.CHROME_PATH } : {};
type Reply = { session: BrowserSessionView; sessions: BrowserSessionView[]; result: unknown; error: string; unavailableNodes: Array<{ nodeId: string }> };

class Lifecycle {
  readonly conversationId = randomUUID();
  token = "";
  constructor(readonly environment: DevEnvironment, readonly auth: SignedIn, readonly origin: string) {}
  get a() { return this.environment.nodes[0]; }
  get b() { return this.environment.nodes[1]; }
  get identity() { return { projectId: this.a.projects[0].id, engine: "pi", conversationId: this.conversationId }; }
  human(method: string, endpoint: string, body?: unknown) { return api<Reply>(this.a, this.auth, method, endpoint, body); }
  async issueToken() {
    const code = `import { browserAgentEnvironment } from './src/browser-agent.ts'; console.log(JSON.stringify(browserAgentEnvironment(${JSON.stringify(this.identity.projectId)}, 'pi', ${JSON.stringify(this.conversationId)}).JOINT_BOB_BROWSER_TOKEN));`;
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: process.cwd(), env: { ...process.env, HOME: this.environment.home, JOINT_BOB_DATA_DIR: this.a.dataDir }, timeout: 15000,
    });
    this.token = JSON.parse(result.stdout);
  }
  async agent(body: unknown) {
    const response = await fetch(`${this.a.url}/api/browser/agent`, {
      method: "POST", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
    });
    return { status: response.status, body: await response.json() as Reply };
  }
  async command(session: BrowserSessionView, command: unknown) {
    const response = await this.agent({ operation: "command", profileId: session.profileId, command });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.result;
  }
  async control(session: BrowserSessionView, action: "takeControl" | "resumeAgent" | "close") {
    const response = await this.human("POST", `/browser/sessions/${session.id}/command?nodeId=${session.nodeId}`, { action });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  async start(profileName: string, nodeId?: string) {
    const response = await this.agent({ operation: "start", profileName, url: `${this.origin}/action?account=${profileName}`, ...(nodeId ? { nodeId } : {}) });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.session.appNodeId, this.a.nodeId);
    assert.equal(response.body.session.state, "running");
    assert.ok(response.body.session.profileId);
    return response.body.session;
  }
  async preference(nodeId: string) {
    const response = await this.human("PUT", `/browser/preferences?${new URLSearchParams(this.identity)}`, { nodeId });
    assert.equal(response.status, 200, JSON.stringify(response.body));
  }
  async default(nodeId: string) {
    const response = await fetch(`${this.a.url}/api/browser/config`, {
      method: "PUT", headers: { Cookie: this.auth.cookie, "x-csrf-token": this.auth.csrfToken, "Content-Type": "application/json" },
      body: JSON.stringify({ executorNodeId: nodeId }), signal: AbortSignal.timeout(30000),
    });
    assert.equal(response.status, 200, "Settings browser machine API must exist");
    assert.match(response.headers.get("content-type")!, /application\/json/, "Settings browser machine API must return JSON, not the HTML fallback");
    await response.json();
  }
  async inventory() {
    const response = await this.agent({ operation: "status" });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body;
  }
}

async function createAccounts(flow: Lifecycle) {
  await flow.default(flow.b.nodeId);
  await flow.issueToken();
  const personal = await flow.start("Personal");
  assert.equal(personal.nodeId, flow.b.nodeId, "Agent A must use Settings browser B");
  await flow.preference(flow.a.nodeId);
  const local = await flow.start("Local");
  assert.equal(local.nodeId, flow.a.nodeId, "Conversation A must override Settings B");
  const work = await flow.start("Work", flow.b.nodeId);
  assert.equal(work.nodeId, flow.b.nodeId, "Explicit new-session B must override conversation A");
  const accounts = [personal, local, work];
  assert.equal(new Set(accounts.map(session => session.profileId)).size, 3);
  for (const [index, session] of accounts.entries()) {
    assert.deepEqual(await flow.command(session, { action: "evaluate", expression: "({cookie:document.cookie,account:localStorage.getItem('account')})" }), { cookie: "", account: null });
    await flow.command(session, { action: "evaluate", expression: `document.cookie='account=fixture-${index}; Path=/; Max-Age=3600; SameSite=Lax'; localStorage.setItem('account','fixture-${index}'); 'saved'` });
  }
  await assertAccounts(flow, accounts);
  await flow.control(personal, "takeControl");
  const blocked = await flow.agent({ operation: "command", profileId: personal.profileId, command: { action: "evaluate", expression: "localStorage.clear()" } });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.match(blocked.body.error, /human|paused/i);
  return accounts;
}

async function assertAccounts(flow: Lifecycle, accounts: BrowserSessionView[]) {
  const states = [];
  for (const session of accounts) {
    states.push(await flow.command(session, { action: "evaluate", expression: "({cookie:document.cookie,account:localStorage.getItem('account')})" }));
  }
  assert.deepEqual(states, accounts.map((_, index) => ({ cookie: `account=fixture-${index}`, account: `fixture-${index}` })), "Independent durable accounts in Personal B / Local A / Work B order");
}

async function assertOffline(flow: Lifecycle, accounts: BrowserSessionView[]) {
  await flow.default(flow.a.nodeId);
  const partial = await flow.inventory();
  assert.deepEqual(partial.unavailableNodes.map(node => node.nodeId), [flow.b.nodeId]);
  const before = partial.sessions.map(session => session.id).sort();
  for (const body of [
    { operation: "command", profileId: accounts[2].profileId, command: { action: "evaluate", expression: "localStorage.setItem('account','wrong-machine')" } },
    { operation: "start", profileId: accounts[2].profileId, nodeId: flow.a.nodeId },
    { operation: "start", profileName: "Must not fall back", nodeId: flow.b.nodeId },
  ]) {
    const failed = await flow.agent(body);
    assert.equal(failed.status, 503, JSON.stringify(failed.body));
    assert.match(failed.body.error, /unavailable|unreachable|offline|discover/i);
  }
  assert.deepEqual((await flow.inventory()).sessions.map(session => session.id).sort(), before, "Offline target must not create a replacement on A");
  assert.deepEqual(await flow.command(accounts[1], { action: "evaluate", expression: "localStorage.getItem('account')" }), "fixture-1", "Known local account stays usable while B is offline");
}

async function waitForRecovery(flow: Lifecycle, accounts: BrowserSessionView[]) {
  for (const session of accounts.filter(session => session.nodeId === flow.b.nodeId)) {
    const deadline = Date.now() + 30000;
    let response;
    do {
      response = await flow.agent({ operation: "command", profileId: session.profileId, command: { action: "snapshot" } });
      if (response.status === 200 || (response.status === 409 && /human control/i.test(response.body.error))) break;
      assert.match(response.body.error, /still restoring|No running browser for this profile/i, JSON.stringify(response.body));
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.ok(response.status === 200 || (response.status === 409 && /human control/i.test(response.body.error)), `Recovery did not finish: ${JSON.stringify(response)}`);
  }
}

async function assertRestored(flow: Lifecycle, accounts: BrowserSessionView[], requests: string[]) {
  await waitForRecovery(flow, accounts);
  const inventory = await flow.inventory();
  assert.deepEqual(inventory.unavailableNodes, []);
  assert.deepEqual(inventory.sessions.map(session => session.id).sort(), accounts.map(session => session.id).sort(), "Server restart preserves session IDs without duplicates");
  for (const original of accounts) {
    const restored = inventory.sessions.find(session => session.id === original.id)!;
    assert.equal(restored.profileId, original.profileId);
    assert.equal(restored.nodeId, original.nodeId);
    assert.equal(restored.state, "running", JSON.stringify(restored));
    if (original.nodeId === flow.b.nodeId) {
      assert.notEqual(restored.activePageId, original.activePageId, "B restart creates new native pages, not an unchanged runtime");
      assert.ok(restored.tabs.length > 0);
      assert.ok(restored.tabs.every(tab => tab.url === `${flow.origin}/`), JSON.stringify(restored.tabs));
    }
  }
  assert.equal(inventory.sessions.find(session => session.id === accounts[0].id)!.owner, "human");
  const blocked = await flow.agent({ operation: "command", profileId: accounts[0].profileId, command: { action: "evaluate", expression: "localStorage.clear()" } });
  assert.equal(blocked.status, 409, JSON.stringify(blocked.body));
  assert.match(blocked.body.error, /human|paused/i);
  await flow.control(accounts[0], "resumeAgent");
  assert.equal(requests.some(url => url.includes("action") || url.includes("?")), false, `Restart replayed action path/query: ${JSON.stringify(requests)}`);
  const reopened = await flow.agent({ operation: "start", profileId: accounts[2].profileId });
  assert.equal(reopened.status, 200, JSON.stringify(reopened.body));
  assert.equal(reopened.body.session.id, accounts[2].id);
  assert.equal(reopened.body.session.nodeId, flow.b.nodeId, "Known account ignores changed default A and conversation A");
  await assertAccounts(flow, accounts);
}

test("native browser machines preserve independent accounts and human pause through a real B server restart without replay or fallback", { timeout: 240000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-machine-lifecycle-"));
  const servers: ChildProcess[] = [];
  const requests: string[] = [];
  const fixture = http.createServer((request, response) => {
    requests.push(request.url!);
    response.setHeader("Content-Type", "text/html");
    response.end("<title>Synthetic lifecycle account</title><h1>Loopback fixture only</h1>");
  });
  let flow: Lifecycle | undefined;
  let accounts: BrowserSessionView[] = [];
  try {
    fixture.listen(0, "127.0.0.1");
    await once(fixture, "listening");
    const address = fixture.address();
    assert.ok(address && typeof address !== "string");
    const environment = await seedDevEnvironment(root, 2);
    for (const node of environment.nodes) servers.push(await startDevNode(environment, node, browserEnv));
    flow = new Lifecycle(environment, await signIn(environment, environment.nodes[0]), `http://127.0.0.1:${address.port}`);
    accounts = await createAccounts(flow);
    t.diagnostic(`Native accounts created on A/B/B: ${JSON.stringify(accounts.map(({ id, profileId, nodeId }) => ({ id, profileId, nodeId })))}`);
    assert.equal(requests.filter(url => url.startsWith("/action?")).length, 3, "Replay assertion requires actual initial action URL visits");
    const oldPid = servers[1].pid;
    await stopDevNode(servers[1]);
    assert.ok(servers[1].exitCode !== null || servers[1].signalCode !== null);
    assert.notEqual(servers[1].signalCode, "SIGKILL", "B must shut down gracefully and flush native profiles");
    t.diagnostic(`Stopped B server PID ${oldPid}`);
    await assertOffline(flow, accounts);
    requests.length = 0;
    servers[1] = await startDevNode(environment, environment.nodes[1], browserEnv);
    assert.notEqual(servers[1].pid, oldPid);
    t.diagnostic(`Restarted B server PID ${servers[1].pid}`);
    await assertRestored(flow, accounts, requests);
    t.diagnostic("Verified durable IDs, independent cookies/localStorage, human pause, origin-only recovery, pinned routing and offline refusal");
  } finally {
    await Promise.all(servers.map(stopDevNode));
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
