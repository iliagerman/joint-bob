import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { browserCapability } from "../../src/browser-runtime.js";
import type { BrowserChecker } from "../../src/browser-monitor-checkers.js";
import type { MonitorEvent, MonitorRecord, MonitorRun } from "../../src/browser-monitor-types.js";
import type { BrowserSessionView } from "../../src/browser-types.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "../dev-nodes.js";

type Message = { id: string; senderId: string; direction: "incoming" | "outgoing"; text: string };
type FixtureState = { accountId: string; messages: Message[] };
type History = { runs: MonitorRun[]; events: MonitorEvent[] };
type MonitorList = { monitors: MonitorRecord[]; nodes: Array<{ nodeId: string; runtime: { started: boolean; activeCount: number; error: string | null } }>; unavailableNodes: Array<{ nodeId: string; reason: string }> };

const fixtureScript = String.raw`const account=location.pathname.slice(1);const source=new EventSource('/events?account='+account);
source.onmessage=event=>{const state=JSON.parse(event.data),messages=document.querySelector('#messages');messages.replaceChildren();
document.querySelector('#account').setAttribute('data-account-id',state.accountId);document.querySelector('#account').textContent=state.accountId;
for(const item of state.messages){const row=document.createElement('div');row.className='message '+item.direction;row.setAttribute('data-message-id',item.id);row.setAttribute('data-sender-id',item.senderId);const body=document.createElement('span');body.className='body';body.textContent=item.text;row.append(body);messages.append(row);}
const empty=document.querySelector('#empty');empty.hidden=state.messages.length!==0;document.querySelector('#ready').hidden=false;};`;

function fixturePage(account: "right" | "wrong"): string {
  const label = account === "right" ? "Monitor account" : "Other account";
  return `<!doctype html><html><body><div id="account" data-account-id=""></div><div id="target" data-target-id="chat-1">Fixture chat</div><div id="ready" hidden>Ready</div><div id="messages"></div><div id="empty" hidden>Empty</div><div>${label}</div><script>${fixtureScript}</script></body></html>`;
}

async function waitFor<T>(label: string, timeout: number, read: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${label} timed out after ${timeout}ms`);
}

function eventIds(history: History): string[] {
  return history.events.map(event => event.externalId).sort();
}

// Real paired servers and the candidate's native browser runtime; no viewer, agent, or browser API substitute.
test("native browser monitor remains owner-authoritative across detection, replacement, takeover, stop, and outage", { timeout: 180000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-browser-monitor-cluster-"));
  const children = new Set<ChildProcess>();
  const streams = new Map<"right" | "wrong", Set<http.ServerResponse>>([["right", new Set()], ["wrong", new Set()]]);
  const states: Record<"right" | "wrong", FixtureState> = {
    right: { accountId: "monitor@example.test", messages: [{ id: "m1", senderId: "sender-1", direction: "incoming", text: "same text" }] },
    wrong: { accountId: "other@example.test", messages: [{ id: "w1", senderId: "sender-2", direction: "incoming", text: "wrong account" }] },
  };
  const fixture = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/events") {
      const account = url.searchParams.get("account") as "right" | "wrong";
      assert.ok(account === "right" || account === "wrong");
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      streams.get(account)!.add(response);
      response.write(`data: ${JSON.stringify(states[account])}\n\n`);
      response.on("close", () => streams.get(account)!.delete(response));
      return;
    }
    if (url.pathname === "/right" || url.pathname === "/wrong") {
      response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(fixturePage(url.pathname.slice(1) as "right" | "wrong")); return;
    }
    response.writeHead(404).end();
  });
  const publish = (account: "right" | "wrong") => {
    const payload = `data: ${JSON.stringify(states[account])}\n\n`;
    for (const response of streams.get(account)!) response.write(payload);
  };
  fixture.listen(0, "127.0.0.1"); await once(fixture, "listening");

  try {
    const capability = await browserCapability();
    assert.equal(capability.available, true, capability.reason ?? "Installed native browser required");
    assert.ok(capability.executable, "Installed native browser executable required");
    const environment = await seedDevEnvironment(root, 2);
    const [nodeA, nodeB] = environment.nodes;
    const serverA = await startDevNode(environment, nodeA, { JOINT_BOB_BROWSER_EXECUTABLE: "/browser-disabled-on-monitor-owner" }); children.add(serverA);
    const serverB = await startDevNode(environment, nodeB, { JOINT_BOB_BROWSER_EXECUTABLE: capability.executable }); children.add(serverB);
    const [authA, authB] = await Promise.all([signIn(environment, nodeA), signIn(environment, nodeB)]);
    const projectA = nodeA.projects.find(project => project.name === "Joint Bob")!;
    const projectB = nodeB.projects.find(project => project.name === projectA.name)!;
    assert.ok(projectA && projectB); assert.notEqual(projectA.id, projectB.id);
    const origin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
    const conversationId = randomUUID();

    const startSession = async (route: "right" | "wrong", profileName: string): Promise<BrowserSessionView> => {
      const response = await api<{ session: BrowserSessionView }>(nodeB, authB, "POST", `/browser/sessions?nodeId=${nodeB.nodeId}`, {
        projectId: projectB.id, engine: "pi", conversationId, appNodeId: nodeB.nodeId, url: `${origin}/${route}`, profileName,
      });
      assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.session;
    };
    const browserCommand = async (sessionId: string, action: "takeControl" | "resumeAgent" | "close") => {
      const response = await api(nodeB, authB, "POST", `/browser/sessions/${sessionId}/command?nodeId=${nodeB.nodeId}`, { action });
      assert.equal(response.status, 200, JSON.stringify(response.body));
    };
    const manage = <T>(command: unknown) => api<T>(nodeA, authA, "POST", "/browser/monitors", { nodeId: nodeA.nodeId, command });
    const list = (node: SeededNode, auth: SignedIn, projectId: string) => api<MonitorList>(node, auth, "GET", `/projects/${projectId}/browser-monitors`);
    const history = async (monitor: MonitorRecord): Promise<History> => {
      const response = await manage<History>({ action: "history", projectId: projectA.id, id: monitor.id });
      assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body;
    };
    const current = async (): Promise<MonitorRecord> => {
      const response = await list(nodeA, authA, projectA.id); assert.equal(response.status, 200, JSON.stringify(response.body));
      const currentMonitor = response.body.monitors.find(candidate => candidate.id === monitor.id);
      assert.ok(currentMonitor, `Monitor ${monitor.id} missing from owner list`);
      return currentMonitor;
    };
    const bindingFor = (session: BrowserSessionView) => {
      assert.ok(session.profileId, `Session ${session.id} missing profileId`);
      assert.ok(session.activePageId, `Session ${session.id} missing activePageId`);
      return { nodeId: nodeB.nodeId, sessionId: session.id, profileId: session.profileId, pageId: session.activePageId, engine: "pi" as const, conversationId };
    };

    const first = await startSession("right", `monitor-right-${randomUUID()}`);
    assert.ok(first.activePageId);
    const checker: BrowserChecker = {
      id: "native-fixture", version: 1, name: "Native fixture", origins: [origin], kind: "messages", readySelector: "#ready",
      loginSelector: null, loadingSelector: null, emptySelector: "#empty",
      account: { selector: "#account", attribute: "data-account-id", format: "text" }, target: { selector: "#target", attribute: "data-target-id", format: "text" },
      targetLabel: { selector: "#target", attribute: null, format: "text" }, itemsSelector: ".message",
      itemId: { selector: ":scope", attribute: "data-message-id", format: "text" }, sender: { selector: ":scope", attribute: "data-sender-id", format: "text" },
      text: { selector: ".body", attribute: null, format: "text" }, incomingSelector: ".incoming", outgoingSelector: ".outgoing",
    };
    let response = await manage({ action: "installChecker", projectId: projectA.id, definition: checker }); assert.equal(response.status, 200, JSON.stringify(response.body));
    const created = await manage<{ monitor: MonitorRecord }>({ action: "create", input: {
      projectId: projectA.id, name: "Native fixture monitor", checkerId: checker.id, checkerVersion: checker.version, origin,
      accountId: "monitor@example.test", targetIds: ["chat-1"], intervalSeconds: 10, binding: bindingFor(first), readAcknowledged: true,
    }});
    assert.equal(created.status, 200, JSON.stringify(created.body)); let monitor = created.body.monitor;
    assert.equal(monitor.enabled, false); assert.equal(monitor.health, "paused"); assert.equal(monitor.ownerNodeId, nodeA.nodeId); assert.equal(monitor.binding.nodeId, nodeB.nodeId);

    let previewFailure = "none";
    await waitFor("native preview readiness", 10_000, async () => {
      const preview = await manage<{ result?: { complete: boolean }; error?: string; health?: string }>({ action: "preview", projectId: projectA.id, id: monitor.id, generation: monitor.generation });
      if (preview.status === 200) { assert.equal(preview.body.result?.complete, true); return true; }
      previewFailure = JSON.stringify(preview.body);
      if (preview.status === 409 && preview.body.health === "incompatible") return undefined;
      throw new Error(`Unexpected preview failure: ${previewFailure}`);
    });
    assert.deepEqual(await history(monitor), { runs: [], events: [] }); assert.equal((await current()).baseline, false);
    let changed = await manage<{ monitor: MonitorRecord }>({ action: "enable", projectId: projectA.id, id: monitor.id, generation: monitor.generation, enabled: true });
    assert.equal(changed.status, 200, JSON.stringify(changed.body)); monitor = changed.body.monitor;
    monitor = await waitFor("10s monitor baseline", 12_000, async () => { const value = await current(); return value.baseline && value.health === "ready" ? value : undefined; });
    const aggregateA = await list(nodeA, authA, projectA.id); assert.equal(aggregateA.body.nodes.find(node => node.nodeId === nodeA.nodeId)?.runtime.started, true);
    const aggregateB = await list(nodeB, authB, projectB.id); assert.equal(aggregateB.body.monitors.some(value => value.ownerNodeId === nodeB.nodeId), false);

    states.right.messages.push({ id: "m2", senderId: "sender-1", direction: "incoming", text: "same text" }, { id: "own3", senderId: "monitor@example.test", direction: "outgoing", text: "sent" });
    const publishedAt = Date.now(); publish("right");
    let observed = await waitFor("autonomous m2 detection", 12_000, async () => { const value = await history(monitor); return value.events.some(event => event.externalId === "m2") ? value : undefined; });
    const m2 = observed.events.find(event => event.externalId === "m2")!;
    assert.ok(m2.observedAt - publishedAt <= 12_000, `m2 detection took ${m2.observedAt - publishedAt}ms`);
    assert.deepEqual(observed.events.filter(event => event.text === "same text").map(event => event.externalId).sort(), ["m1", "m2"]);
    assert.equal(observed.events.find(event => event.externalId === "own3")?.processed, true); assert.equal(m2.processed, false);
    const priorRunIds = new Set(observed.runs.map(run => run.id));
    response = await manage({ action: "check", projectId: projectA.id, id: monitor.id, generation: monitor.generation }); assert.equal(response.status, 200, JSON.stringify(response.body));
    observed = await waitFor("requested scan", 12_000, async () => { const value = await history(monitor); return value.runs.some(run => !priorRunIds.has(run.id) && run.status === "succeeded") ? value : undefined; });
    assert.equal(observed.events.filter(event => event.externalId === "m2").length, 1);

    await browserCommand(first.id, "takeControl");
    response = await manage({ action: "check", projectId: projectA.id, id: monitor.id, generation: monitor.generation }); assert.equal(response.status, 200, JSON.stringify(response.body));
    monitor = await waitFor("human takeover pause", 12_000, async () => { const value = await current(); return value.health === "paused-by-human" && !value.enabled ? value : undefined; });
    states.right.messages.push({ id: "m4", senderId: "sender-1", direction: "incoming", text: "after takeover" }); publish("right");
    await browserCommand(first.id, "resumeAgent");
    changed = await manage({ action: "enable", projectId: projectA.id, id: monitor.id, generation: monitor.generation, enabled: true }); assert.equal(changed.status, 200, JSON.stringify(changed.body)); monitor = changed.body.monitor;
    observed = await waitFor("m4 after explicit resume", 12_000, async () => { const value = await history(monitor); return value.events.some(event => event.externalId === "m4") ? value : undefined; });
    const retainedBeforeRebind = eventIds(observed); const checkpointBeforeRebind = structuredClone((await current()).checkpoint);

    const wrong = await startSession("wrong", `monitor-wrong-${randomUUID()}`);
    const oldBinding = structuredClone(monitor.binding); const failedGeneration = monitor.generation;
    const rejected = await manage<{ health?: string }>({ action: "rebind", projectId: projectA.id, id: monitor.id, generation: failedGeneration, binding: bindingFor(wrong) });
    assert.equal(rejected.status, 409, JSON.stringify(rejected.body)); assert.equal(rejected.body.health, "wrong-account");
    monitor = await current(); assert.equal(monitor.enabled, false); assert.deepEqual(monitor.binding, oldBinding); assert.deepEqual(monitor.checkpoint, checkpointBeforeRebind); assert.deepEqual(eventIds(await history(monitor)), retainedBeforeRebind);
    assert.ok(monitor.generation > failedGeneration);

    const replacement = await startSession("right", `monitor-replacement-${randomUUID()}`);
    const preRebindGeneration = monitor.generation;
    changed = await manage({ action: "rebind", projectId: projectA.id, id: monitor.id, generation: monitor.generation, binding: bindingFor(replacement) });
    assert.equal(changed.status, 200, JSON.stringify(changed.body)); monitor = changed.body.monitor;
    assert.equal(monitor.enabled, false); assert.equal(monitor.baseline, true); assert.equal(monitor.binding.sessionId, replacement.id); assert.deepEqual(monitor.checkpoint, checkpointBeforeRebind); assert.deepEqual(eventIds(await history(monitor)), retainedBeforeRebind);
    const stale = await manage({ action: "enable", projectId: projectA.id, id: monitor.id, generation: preRebindGeneration, enabled: true }); assert.equal(stale.status, 409);
    const beforeReplacementEnable = new Set((await history(monitor)).runs.filter(run => run.status === "succeeded").map(run => run.id));
    changed = await manage({ action: "enable", projectId: projectA.id, id: monitor.id, generation: monitor.generation, enabled: true }); assert.equal(changed.status, 200, JSON.stringify(changed.body)); monitor = changed.body.monitor;
    observed = await waitFor("replacement scan", 12_000, async () => { const value = await history(monitor); return value.runs.some(run => run.status === "succeeded" && !beforeReplacementEnable.has(run.id)) ? value : undefined; });
    assert.equal(observed.events.filter(event => event.externalId === "m2" || event.externalId === "m4").length, 2);

    changed = await manage({ action: "update", projectId: projectA.id, id: monitor.id, generation: (await current()).generation, patch: { intervalSeconds: 3600 } }); assert.equal(changed.status, 200, JSON.stringify(changed.body)); monitor = changed.body.monitor;
    const beforeStopEnable = new Set((await history(monitor)).runs.filter(run => run.status === "succeeded").map(run => run.id));
    changed = await manage({ action: "enable", projectId: projectA.id, id: monitor.id, generation: monitor.generation, enabled: true }); assert.equal(changed.status, 200, JSON.stringify(changed.body)); monitor = changed.body.monitor;
    monitor = await waitFor("pre-stop scan", 12_000, async () => { const value = await current(); const h = await history(value); return h.runs.some(run => run.status === "succeeded" && !beforeStopEnable.has(run.id)) && value.nextDueAt! > Date.now() + 5000 ? value : undefined; });
    const retainedAtStop = eventIds(await history(monitor)); const checkpointAtStop = structuredClone(monitor.checkpoint);
    await browserCommand(replacement.id, "takeControl"); await browserCommand(replacement.id, "close");
    response = await manage({ action: "check", projectId: projectA.id, id: monitor.id, generation: monitor.generation }); assert.equal(response.status, 200, JSON.stringify(response.body));
    monitor = await waitFor("explicit browser stop", 12_000, async () => { const value = await current(); return value.health === "browser-stopped" && !value.enabled ? value : undefined; });
    const sessions = await api<{ sessions: BrowserSessionView[] }>(nodeB, authB, "GET", `/browser/sessions?nodeId=${nodeB.nodeId}`);
    const stoppedSession = sessions.body.sessions.find(session => session.id === replacement.id)!;
    assert.equal(stoppedSession.state, "closed"); assert.equal(stoppedSession.restoreOnRestart, false);
    assert.equal(sessions.body.sessions.filter(session => session.state === "running").length, 2, "Stop must not launch a replacement session");
    assert.deepEqual(monitor.checkpoint, checkpointAtStop); assert.deepEqual(eventIds(await history(monitor)), retainedAtStop);

    await stopDevNode(serverA); children.delete(serverA);
    const unavailable = await list(nodeB, authB, projectB.id); assert.equal(unavailable.status, 200, JSON.stringify(unavailable.body));
    assert.ok(unavailable.body.unavailableNodes.some(node => node.nodeId === nodeA.nodeId)); assert.equal(unavailable.body.monitors.some(value => value.ownerNodeId === nodeB.nodeId), false);
    const restartedA = await startDevNode(environment, nodeA, { JOINT_BOB_BROWSER_EXECUTABLE: "/browser-disabled-on-monitor-owner" }); children.add(restartedA);
    const authRestartedA = await signIn(environment, nodeA);
    const persisted = await waitFor("stopped monitor after owner restart", 12_000, async () => {
      const result = await list(nodeA, authRestartedA, projectA.id); const value = result.body.monitors.find(candidate => candidate.id === monitor.id);
      return value?.health === "browser-stopped" && !value.enabled ? value : undefined;
    });
    assert.equal(persisted.binding.sessionId, replacement.id); assert.equal(persisted.baseline, true); assert.deepEqual(persisted.checkpoint, checkpointAtStop);
    const persistedHistory = await api<History>(nodeA, authRestartedA, "POST", "/browser/monitors", { nodeId: nodeA.nodeId, command: { action: "history", projectId: projectA.id, id: persisted.id } });
    assert.deepEqual(eventIds(persistedHistory.body), retainedAtStop);
  } finally {
    await Promise.all([...children].map(child => stopDevNode(child)));
    for (const responses of streams.values()) for (const response of responses) response.end();
    fixture.closeAllConnections(); await new Promise<void>(resolve => fixture.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
