import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { chromeExecutable } from "./launch-chrome.js";
import type { BrowserSessionView } from "../../src/browser-types.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";
import { waitForAssertion } from "../async-assertion.js";

const run = promisify(execFile);

type AgentEnvironment = Record<string, string>;
type AgentResponse = {
  ok?: boolean;
  result?: unknown;
  session?: { id: string; nodeId: string; profileId: string };
};

async function issueAgentEnvironment(
  home: string,
  dataDir: string,
  port: number,
  projectId: string,
  conversationId: string,
): Promise<AgentEnvironment> {
  const script = `import {websiteCredentialSnapshot} from './src/secrets.ts';import {browserAgentEnvironment} from './src/browser-agent.ts';console.log(JSON.stringify(browserAgentEnvironment(${JSON.stringify(projectId)},'pi',${JSON.stringify(conversationId)},websiteCredentialSnapshot(${JSON.stringify(projectId)},{engine:'pi',sessionId:${JSON.stringify(conversationId)}}))))`;
  const issued = await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, JOINT_BOB_DATA_DIR: dataDir, PORT: String(port) },
  });
  return JSON.parse(issued.stdout) as AgentEnvironment;
}

function requester(environment: AgentEnvironment) {
  return async (body: unknown, status = 200): Promise<AgentResponse> => {
    const response = await fetch(environment.JOINT_BOB_BROWSER_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${environment.JOINT_BOB_BROWSER_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const value: unknown = await response.json();
    assert.equal(response.status, status, JSON.stringify(value));
    assert.doesNotMatch(JSON.stringify(value), /synthetic-(user|password|tenant)/);
    assert.ok(value && typeof value === "object");
    return value as AgentResponse;
  };
}

test("origin-bound snapshot signs in on the designated browser node", { timeout: 180_000 }, async t => {
  const executable = await chromeExecutable();
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-website-login-"));
  const servers: ChildProcess[] = [];
  const received: string[] = [];
  const username = "synthetic-user", password = "synthetic-password", tenant = "synthetic-tenant";
  const website = http.createServer(async (request, response) => {
    if (request.url === "/controls") { response.setHeader("content-type", "text/html"); response.end('<input id="loose"><input id="username">'); return; }
    if (request.url === "/forged-login") { response.setHeader("content-type", "text/html"); response.end('<form><input id="forged-password" type="password"><button>Sign in</button></form>'); return; }
    if (request.url === "/mfa") { response.setHeader("content-type", "text/html"); response.end('<main><input id="otp" autocomplete="one-time-code"><button onclick="document.querySelector(\'main\').textContent=\'Account ready\'">Finish challenge</button></main>'); return; }
    if (request.method === "POST" && request.url === "/session") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      received.push(Buffer.concat(chunks).toString());
      response.setHeader("content-type", "text/html"); response.end('<h1 id="ready">Signed in</h1>'); return;
    }
    response.setHeader("content-type", "text/html");
    response.end(`<input id="loose"><input id="error"><form method="post" action="/session"><section id="first"><input id="username" name="username"><button id="next" type="button" onclick="first.hidden=true;second.hidden=false">Next</button></section><section id="second" hidden><input id="password" name="password" type="password"><input id="tenant" name="tenant"><input id="otp" autocomplete="one-time-code" hidden><input id="cross" form="cross-form"><button id="submit">Sign in</button></section></form><form id="cross-form" action="http://127.0.0.1:1/steal"></form>`);
  });
  website.listen(0, "127.0.0.1"); await once(website, "listening");
  try {
    const environment = await seedDevEnvironment(root, 2);
    const [source, executor] = environment.nodes;
    servers.push(await startDevNode(environment, source, { JOINT_BOB_BROWSER_EXECUTABLE: "/invalid/source-browser" }));
    servers.push(await startDevNode(environment, executor, { JOINT_BOB_BROWSER_EXECUTABLE: executable }));
    const auth = await signIn(environment, source);
    const projectId = source.projects[0].id, conversationId = randomUUID();
    const fixturePort = (website.address() as AddressInfo).port;
    const origin = `http://localhost:${fixturePort}`;
    const wrongOrigin = `http://127.0.0.1:${fixturePort}`;
    const created = await api<{ account: { id: string } }>(source, auth, "POST", "/secrets/accounts", { label: "Synthetic website", provider: "custom", websiteOrigin: origin, variables: [{ name: "USERNAME", kind: "value", value: username }, { name: "PASSWORD", kind: "value", value: password }, { name: "TENANT", kind: "value", value: tenant }] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const accountId = created.body.account.id;
    const attached = await api(source, auth, "PUT", `/secrets/scopes/project/${projectId}`, { accountIds: [accountId] });
    assert.equal(attached.status, 200, JSON.stringify(attached.body));
    const agentEnvironment = await issueAgentEnvironment(environment.home, source.dataDir, source.port, projectId, conversationId);
    const request = requester(agentEnvironment);
    const started = await request({ operation: "start", nodeId: executor.nodeId, url: origin });
    assert.equal(started.session?.nodeId, executor.nodeId);
    const sessionId = started.session!.id, profileId = started.session!.profileId;
    const command = (commandBody: unknown, selectedProfile = profileId) => request({ operation: "command", profileId: selectedProfile, command: commandBody });
    const fill = (selector: string, variable: string, expected = 200, selectedProfile = profileId, selectedAccount = accountId) => request({ operation: "loginFill", selector, accountId: selectedAccount, variable, profileId: selectedProfile }, expected);
    const empty = async (selectedRequest: ReturnType<typeof requester>, selectedProfile: string, selector = "#loose") => {
      const state = await selectedRequest({ operation: "command", profileId: selectedProfile, command: { action: "evaluate", expression: `document.querySelector(${JSON.stringify(selector)}).value` } });
      assert.equal(state.result, "");
    };

    assert.deepEqual(await fill("#username", "USERNAME"), { ok: true });
    await command({ action: "clickElement", selector: "#next" });
    await fill("#password", "PASSWORD"); await fill("#tenant", "TENANT");
    for (const selector of ["#otp", "#cross"]) { await fill(selector, "PASSWORD", 409); await empty(request, profileId, selector); }
    await command({ action: "clickElement", selector: "#submit" });
    const ready = await command({ action: "evaluate", expression: "document.querySelector('#ready')?.textContent" });
    assert.equal(ready.result, "Signed in");
    assert.match(received[0], /username=synthetic-user/); assert.match(received[0], /password=synthetic-password/); assert.match(received[0], /tenant=synthetic-tenant/);

    await command({ action: "navigate", url: origin });
    await empty(request, profileId);
    await command({ action: "navigate", url: `${wrongOrigin}/controls` });
    await fill("#loose", "PASSWORD", 409); await empty(request, profileId);
    await command({ action: "navigate", url: origin });

    const unattached = await api<{ account: { id: string } }>(source, auth, "POST", "/secrets/accounts", { label: "Unattached", provider: "custom", websiteOrigin: origin, variables: [{ name: "PASSWORD", kind: "value", value: password }] });
    assert.equal(unattached.status, 201, JSON.stringify(unattached.body));
    await fill("#loose", "PASSWORD", 409, profileId, unattached.body.account.id); await empty(request, profileId);
    await fill("#loose", "MISSING", 409); await empty(request, profileId);
    await request({ operation: "loginFill", selector: "#loose", accountId, variable: "PASSWORD", profileId, origin, text: password }, 400); await empty(request, profileId);

    const otherConversationEnvironment = await issueAgentEnvironment(environment.home, source.dataDir, source.port, projectId, randomUUID());
    const otherConversation = requester(otherConversationEnvironment);
    const otherStarted = await otherConversation({ operation: "start", nodeId: executor.nodeId, url: origin, profileName: "Other conversation" });
    const otherProfileId = otherStarted.session!.profileId;
    await otherConversation({ operation: "loginFill", selector: "#username", accountId, variable: "USERNAME", profileId: otherProfileId });
    await otherConversation({ operation: "command", profileId: otherProfileId, command: { action: "close" } });
    await otherConversation({ operation: "loginFill", selector: "#loose", accountId, variable: "PASSWORD", profileId }, 404);
    await empty(request, profileId);

    const otherProjectEnvironment = await issueAgentEnvironment(environment.home, source.dataDir, source.port, source.projects[1].id, randomUUID());
    const otherProject = requester(otherProjectEnvironment);
    const otherProjectStarted = await otherProject({ operation: "start", nodeId: executor.nodeId, url: `${origin}/controls`, profileName: "Other project" });
    const otherProjectProfileId = otherProjectStarted.session!.profileId;
    await otherProject({ operation: "loginFill", selector: "#loose", accountId, variable: "PASSWORD", profileId: otherProjectProfileId }, 409);
    await empty(otherProject, otherProjectProfileId);
    await otherProject({ operation: "loginFill", selector: "#loose", accountId, variable: "PASSWORD", profileId }, 404);
    await otherProject({ operation: "command", profileId: otherProjectProfileId, command: { action: "close" } });

    const forgedStarted = await otherProject({ operation: "start", nodeId: executor.nodeId, url: `${origin}/forged-login`, profileName: "Forged metadata", credentialOrigins: [origin], actor: { kind: "agent", credentialOrigins: [origin] } });
    const forgedSessionId = forgedStarted.session!.id;
    const forgedProfileId = forgedStarted.session!.profileId;
    const forgedDb = new DatabaseSync(path.join(executor.dataDir, "node.db"));
    try {
      const row = forgedDb.prepare("SELECT recovery FROM browser_sessions WHERE id = ?").get(forgedSessionId) as { recovery: string };
      const recovery = JSON.parse(row.recovery) as { credentialOrigins?: string[] };
      assert.ok(!recovery.credentialOrigins || recovery.credentialOrigins.length === 0, "client origin metadata must not become browser policy");
    } finally { forgedDb.close(); }
    const forgedSession = await waitForAssertion(async () => {
      const response = await api<{ session: BrowserSessionView }>(source, auth, "GET", `/browser/sessions/${forgedSessionId}?nodeId=${executor.nodeId}`);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.session.loginRequest?.automatic, true);
      return response.body.session;
    });
    assert.equal(forgedSession.loginRequest!.automatic, true);
    await otherProject({ operation: "command", profileId: forgedProfileId, command: { action: "snapshot" } }, 409);
    const forgedTakeover = await api(source, auth, "POST", `/browser/sessions/${forgedSessionId}/command?nodeId=${executor.nodeId}`, { action: "takeControl", loginRequestId: forgedSession.loginRequest!.id });
    assert.equal(forgedTakeover.status, 200, JSON.stringify(forgedTakeover.body));
    const forgedClose = await api(source, auth, "POST", `/browser/sessions/${forgedSessionId}/command?nodeId=${executor.nodeId}`, { action: "close" });
    assert.equal(forgedClose.status, 200, JSON.stringify(forgedClose.body));

    const secondStarted = await request({ operation: "start", nodeId: executor.nodeId, url: origin, profileName: "Second profile" });
    const secondProfileId = secondStarted.session!.profileId;
    await request({ operation: "loginFill", selector: "#loose", accountId, variable: "PASSWORD" }, 409);
    await empty(request, profileId); await empty(request, secondProfileId);
    await fill("#loose", "PASSWORD");
    const filled = await command({ action: "evaluate", expression: "Boolean(document.querySelector('#loose').value.length)" });
    assert.equal(filled.result, true);
    await command({ action: "navigate", url: origin });
    await request({ operation: "command", profileId: secondProfileId, command: { action: "close" } });

    await command({ action: "evaluate", expression: `Object.defineProperty(HTMLInputElement.prototype,"value",{configurable:true,get(){return ""},set(value){throw new Error(value)}})` });
    await fill("#error", "PASSWORD", 409); await empty(request, profileId, "#error");
    await command({ action: "navigate", url: origin });

    const executorDb = new DatabaseSync(path.join(executor.dataDir, "node.db"));
    try { assert.equal(executorDb.prepare("SELECT 1 FROM secret_accounts WHERE id = ?").get(accountId), undefined); } finally { executorDb.close(); }
    const takeover = await api(source, auth, "POST", `/browser/sessions/${sessionId}/command?nodeId=${executor.nodeId}`, { action: "takeControl" });
    assert.equal(takeover.status, 200, JSON.stringify(takeover.body));
    await fill("#loose", "PASSWORD", 409);
    const humanRead = await api<{ result: unknown }>(source, auth, "POST", `/browser/sessions/${sessionId}/command?nodeId=${executor.nodeId}`, { action: "evaluate", expression: "document.querySelector('#loose').value" });
    assert.equal(humanRead.status, 200, JSON.stringify(humanRead.body));
    assert.equal(humanRead.body.result, "");
    assert.doesNotMatch(JSON.stringify(humanRead.body), /synthetic-(user|password|tenant)/);

    const resumed = await api(source, auth, "POST", `/browser/sessions/${sessionId}/command?nodeId=${executor.nodeId}`, { action: "resumeAgent" });
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    await command({ action: "navigate", url: `${origin}/mfa` });
    const mfaSession = await waitForAssertion(async () => {
      const response = await api<{ session: BrowserSessionView }>(source, auth, "GET", `/browser/sessions/${sessionId}?nodeId=${executor.nodeId}`);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.session.loginRequest?.automatic, true);
      return response.body.session;
    });
    await fill("#otp", "PASSWORD", 409);
    await request({ operation: "command", profileId, command: { action: "snapshot" } }, 409);
    const mfaTakeover = await api(source, auth, "POST", `/browser/sessions/${sessionId}/command?nodeId=${executor.nodeId}`, { action: "takeControl", loginRequestId: mfaSession.loginRequest!.id });
    assert.equal(mfaTakeover.status, 200, JSON.stringify(mfaTakeover.body));
    const mfaClick = await api(source, auth, "POST", `/browser/sessions/${sessionId}/command?nodeId=${executor.nodeId}`, { action: "clickElement", selector: "text=Finish challenge" });
    assert.equal(mfaClick.status, 200, JSON.stringify(mfaClick.body));
    const mfaComplete = await api<{ session: BrowserSessionView }>(source, auth, "POST", `/browser/sessions/${sessionId}/command?nodeId=${executor.nodeId}`, { action: "completeLogin", requestId: mfaSession.loginRequest!.id, expectedPageId: mfaSession.activePageId! });
    assert.equal(mfaComplete.status, 200, JSON.stringify(mfaComplete.body));
    assert.equal(mfaComplete.body.session.owner, "agent");
    assert.equal(mfaComplete.body.session.loginRequest, null);

    // Done must nudge the paused conversation: the executor queues a hidden
    // system prompt that replicates to the conversation's node, so the agent
    // continues without a manual "go on" message.
    await waitForAssertion(async () => {
      const queueDb = new DatabaseSync(path.join(source.dataDir, "node.db"));
      try {
        const queued = queueDb.prepare("SELECT queue_key, prompt FROM queued_prompts").all() as Array<{ queue_key: string; prompt: string }>;
        const continuation = queued.find(row => (JSON.parse(row.prompt) as { systemEventId?: string }).systemEventId === mfaSession.loginRequest!.id);
        assert.ok(continuation, "completed login must queue a continuation prompt");
        assert.equal(continuation.queue_key, `${projectId}:${conversationId}`);
        assert.match((JSON.parse(continuation.prompt) as { promptText: string }).promptText, /sign-in/i);
      } finally { queueDb.close(); }
    }, 15000);
  } finally {
    await Promise.all(servers.map(stopDevNode)); website.closeAllConnections(); website.close(); await rm(root, { recursive: true, force: true });
  }
});
