import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { test } from "node:test";
import { BrowserRuntime, type BrowserMonitorReadGrant } from "../../src/browser-runtime.js";
import { browserCheckerSchema, type BrowserChecker } from "../../src/browser-monitor-checkers.js";
import { BrowserMonitorCheckError } from "../../src/browser-monitor-scheduler.js";

const agent = { kind: "agent" } as const;
const human = { kind: "human", id: "monitor-human" } as const;

function checker(origin: string): BrowserChecker {
  return browserCheckerSchema.parse({
    id: "fixture", version: 1, name: "Fixture", origins: [origin], kind: "messages",
    readySelector: "#ready", loginSelector: "#login", loadingSelector: "#loading", emptySelector: "#empty",
    account: { selector: "#account", attribute: null, format: "email" },
    target: { selector: "#target", attribute: "data-target-id", format: "text" },
    targetLabel: { selector: "#target", attribute: null, format: "text" }, itemsSelector: ".message",
    itemId: { selector: ":scope", attribute: "data-message-id", format: "text" },
    sender: { selector: ":scope", attribute: "data-sender-id", format: "text" },
    text: { selector: ".text", attribute: null, format: "text" }, incomingSelector: ".incoming", outgoingSelector: ".outgoing",
  });
}

async function fixture(run: (context: { runtime: BrowserRuntime; grant: BrowserMonitorReadGrant; input: ReturnType<typeof inputFor>; waitForHold: () => Promise<void>; releaseHold: () => void }) => Promise<void>) {
  let held: http.ServerResponse | undefined;
  let requestSeen!: () => void;
  const seen = new Promise<void>(resolve => { requestSeen = resolve; });
  const server = http.createServer((req, res) => {
    if (req.url === "/hold") { held = res; requestSeen(); return; }
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><div id="ready">Ready</div><div id="account">monitor@example.test</div><div id="target" data-target-id="chat-1">Synthetic chat</div><div class="message incoming" data-message-id="m1" data-sender-id="other"><span class="text">before</span></div><div id="empty" hidden>Empty</div><div id="loading" hidden>Loading</div><div id="login" hidden>Login</div>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const runtime = new BrowserRuntime();
  try {
    const projectId = randomUUID(), conversationId = randomUUID();
    const view = await runtime.create({ projectId, conversationId, engine: "pi", appNodeId: randomUUID(), url: origin });
    const grant = { sessionId: view.id, projectId, conversationId, profileId: view.profileId!, pageId: view.activePageId!, assertValid() {} };
    await run({ runtime, grant, input: inputFor(checker(origin), origin), waitForHold: () => seen, releaseHold: () => { held?.end("released"); held = undefined; } });
  } finally {
    held?.end("released");
    await runtime.close(); server.closeAllConnections(); server.close();
  }
}

function inputFor(definition: BrowserChecker, origin: string) {
  return { checker: definition, origin, accountId: "monitor@example.test", targetIds: ["chat-1"], checkpoint: {} };
}

function health(error: unknown, expected: string) {
  assert.ok(error instanceof BrowserMonitorCheckError); assert.equal(error.health, expected); return true;
}

function hold(runtime: BrowserRuntime, sessionId: string) {
  return runtime.execute(sessionId, { action: "evaluate", expression: "fetch('/hold').then(r=>r.text())" }, agent);
}

test("queued interactive work runs before a queued monitor read", { timeout: 60000 }, () => fixture(async ({ runtime, grant, input, waitForHold, releaseHold }) => {
  const prior = hold(runtime, grant.sessionId); await waitForHold();
  const calls: string[] = [];
  const read = runtime.inspectMonitor({ ...grant, assertValid() { calls.push("monitor"); } }, input);
  const change = runtime.execute(grant.sessionId, { action: "evaluate", expression: "document.querySelector('.text').innerText='after'" }, agent);
  releaseHold(); await Promise.all([prior, change]);
  const result = await read;
  assert.equal(result.items[0]?.text, "after");
  assert.deepEqual(calls, ["monitor", "monitor"]);
  assert.equal(result.accountId, "monitor@example.test");
}));

test("interactive tab selection invalidates an earlier queued monitor", { timeout: 60000 }, () => fixture(async ({ runtime, grant, input, waitForHold, releaseHold }) => {
  const created = await runtime.execute(grant.sessionId, { action: "newTab" }, agent) as { activePageId: string };
  const secondPageId = created.activePageId;
  assert.ok(secondPageId); await runtime.execute(grant.sessionId, { action: "selectTab", pageId: grant.pageId }, agent);
  const prior = hold(runtime, grant.sessionId); await waitForHold();
  const read = runtime.inspectMonitor(grant, input);
  const rejection = assert.rejects(read, error => health(error, "target-missing"));
  const select = runtime.execute(grant.sessionId, { action: "selectTab", pageId: secondPageId }, agent);
  releaseHold(); await Promise.all([prior, select, rejection]);
  assert.equal((await runtime.get(grant.sessionId)).activePageId, secondPageId);
}));

test("Stop immediately rejects queued monitor work", { timeout: 60000 }, () => fixture(async ({ runtime, grant, input, waitForHold }) => {
  const prior = hold(runtime, grant.sessionId); const priorSettled = prior.catch(() => undefined); await waitForHold();
  let calls = 0;
  const read = runtime.inspectMonitor({ ...grant, assertValid() { calls++; } }, input);
  const rejection = assert.rejects(read, /not running/i);
  const close = runtime.execute(grant.sessionId, { action: "close" }, agent);
  await Promise.all([close, rejection]);
  assert.equal(calls, 0);
  await priorSettled;
}));

test("human control remains immediate while a monitor is queued", { timeout: 60000 }, () => fixture(async ({ runtime, grant, input, waitForHold, releaseHold }) => {
  const prior = hold(runtime, grant.sessionId); await waitForHold();
  const read = runtime.inspectMonitor(grant, input);
  const rejection = assert.rejects(read, error => health(error, "paused-by-human"));
  const takeover = runtime.execute(grant.sessionId, { action: "takeControl" }, human);
  releaseHold(); await Promise.all([prior, takeover, rejection]);
  assert.equal((await runtime.get(grant.sessionId)).owner, "human");
}));
