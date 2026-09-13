import assert from "node:assert/strict";
import { test } from "node:test";
import http from "node:http";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { BrowserRuntime, type BrowserMonitorReadGrant } from "../../src/browser-runtime.js";
import { browserCheckerSchema, type BrowserChecker } from "../../src/browser-monitor-checkers.js";
import { BrowserMonitorCheckError } from "../../src/browser-monitor-scheduler.js";
import { BrowserMonitorStore } from "../../src/browser-monitors.js";

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

async function fixture(
  run: (context: { runtime: BrowserRuntime; grant: BrowserMonitorReadGrant; origin: string; definition: BrowserChecker }) => Promise<void>,
  requestHandler?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean,
) {
  const server = http.createServer((req, res) => {
    if (requestHandler?.(req, res)) return;
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><div id="ready">Ready</div><div id="account">monitor@example.test</div><div id="target" data-target-id="chat-1">Synthetic chat</div><div class="message incoming" data-message-id="m1" data-sender-id="other"><span class="text">same text</span></div><div class="message outgoing" data-message-id="m2" data-sender-id="monitor@example.test"><span class="text">own reply</span></div><div id="empty" hidden>Empty</div><div id="loading" hidden>Loading</div><div id="login" hidden>Login</div>`);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  const runtime = new BrowserRuntime();
  try {
    const projectId = randomUUID(), conversationId = randomUUID();
    const view = await runtime.create({ projectId, conversationId, engine: "pi", appNodeId: randomUUID(), url: origin });
    const grant = { sessionId: view.id, projectId, conversationId, profileId: view.profileId!, pageId: view.activePageId!, assertValid() {} };
    await run({ runtime, grant, origin, definition: checker(origin) });
  } finally { await runtime.close(); server.closeAllConnections(); server.close(); }
}

function health(error: unknown, expected: string) {
  assert.ok(error instanceof BrowserMonitorCheckError); assert.equal(error.health, expected); return true;
}

test("monitor extracts stable messages and enforces incomplete boundaries", { timeout: 60000 }, () => fixture(async ({ runtime, grant, origin, definition }) => {
  const input = { checker: definition, origin, accountId: "monitor@example.test", targetIds: ["chat-1"], checkpoint: {} };
  const first = await runtime.inspectMonitor(grant, input);
  assert.deepEqual(first.items.map(item => [item.externalId, item.direction, item.text]), [["m1", "incoming", "same text"], ["m2", "outgoing", "own reply"]]);
  assert.equal(first.complete, true); assert.equal(first.checkpoint["chat-1"], "m2");
  await runtime.execute(grant.sessionId, { action: "evaluate", expression: `[...document.querySelectorAll('.message')].at(-1).insertAdjacentHTML('afterend','<div class="message incoming" data-message-id="m3" data-sender-id="other"><span class="text">same text</span></div>')` }, agent);
  const next = await runtime.inspectMonitor(grant, { ...input, checkpoint: first.checkpoint });
  assert.equal(next.items.at(-1)?.externalId, "m3");
  const partial = await runtime.inspectMonitor(grant, { ...input, targetIds: ["chat-1", "chat-2"], checkpoint: { "chat-1": "missing" } });
  assert.equal(partial.complete, false); assert.deepEqual(partial.checkpoint, { "chat-1": "missing" });
}));

test("monitor rejects loading, missing readiness, account and grant mismatch", { timeout: 60000 }, () => fixture(async ({ runtime, grant, origin, definition }) => {
  const input = { checker: definition, origin, accountId: "monitor@example.test", targetIds: ["chat-1"], checkpoint: {} };
  await assert.rejects(runtime.inspectMonitor({ ...grant, projectId: randomUUID() }, input), error => health(error, "wrong-account"));
  await assert.rejects(runtime.inspectMonitor(grant, { ...input, accountId: "wrong@example.test" }), error => health(error, "wrong-account"));
  await runtime.execute(grant.sessionId, { action: "evaluate", expression: "document.querySelector('#loading').hidden=false" }, agent);
  await assert.rejects(runtime.inspectMonitor(grant, input), error => health(error, "incompatible"));
  await runtime.execute(grant.sessionId, { action: "evaluate", expression: "document.querySelector('#loading').hidden=true;document.querySelector('#ready').remove()" }, agent);
  await assert.rejects(runtime.inspectMonitor(grant, input), error => health(error, "incompatible"));
}));

test("monitor respects human takeover", { timeout: 60000 }, () => fixture(async ({ runtime, grant, origin, definition }) => {
  const input = { checker: definition, origin, accountId: "monitor@example.test", targetIds: ["chat-1"], checkpoint: {} };
  await runtime.execute(grant.sessionId, { action: "takeControl" }, human);
  await assert.rejects(runtime.inspectMonitor(grant, input), error => health(error, "paused-by-human"));
  await runtime.execute(grant.sessionId, { action: "resumeAgent" }, human);
  assert.equal((await runtime.inspectMonitor(grant, input)).items.length, 2);
  let calls = 0;
  await assert.rejects(runtime.inspectMonitor({ ...grant, assertValid() { if (++calls === 2) throw Error("revoked"); } }, input), /revoked/);
  assert.equal(calls, 2);
}));

test("checker declarations are strict and injection stays selector data", { timeout: 60000 }, () => fixture(async ({ runtime, grant, origin, definition }) => {
  assert.throws(() => browserCheckerSchema.parse({ ...definition, expression: "document.cookie" }));
  assert.throws(() => browserCheckerSchema.parse({ ...definition, account: { ...definition.account, attribute: "value" } }));
  assert.throws(() => browserCheckerSchema.parse({ ...definition, origins: [`${origin}/path`] }));
  const payload = "#account`;window.injected=true;//";
  await assert.rejects(runtime.inspectMonitor(grant, { checker: { ...definition, account: { ...definition.account, selector: payload } }, origin, accountId: "monitor@example.test", targetIds: ["chat-1"], checkpoint: {} }), error => health(error, "incompatible"));
  assert.equal(await runtime.execute(grant.sessionId, { action: "evaluate", expression: "window.injected" }, agent), undefined);
}));

test("checker JSON substitution preserves replacement metacharacters", { timeout: 60000 }, () => fixture(async ({ runtime, grant, origin, definition }) => {
  for (const title of ["$&", "$'", "$`", "$$"]) {
    await runtime.execute(grant.sessionId, { action: "evaluate", expression: `document.querySelector('#account').title=${JSON.stringify(title)}` }, agent);
    const selected = { ...definition, account: { selector: `[title=${JSON.stringify(title)}]`, attribute: "title", format: "text" } } as BrowserChecker;
    const result = await runtime.inspectMonitor(grant, { checker: selected, origin, accountId: title, targetIds: ["chat-1"], checkpoint: {} });
    assert.equal(result.accountId, title);
    assert.equal(result.items.length, 2);
    assert.equal(await runtime.execute(grant.sessionId, { action: "evaluate", expression: "window.injected" }, agent), undefined);
  }
}));

test("null login selector permits an ordinary ready read", { timeout: 60000 }, () => fixture(async ({ runtime, grant, origin, definition }) => {
  const nullable = browserCheckerSchema.parse({ ...definition, loginSelector: null });
  const result = await runtime.inspectMonitor(grant, { checker: nullable, origin, accountId: "monitor@example.test", targetIds: ["chat-1"], checkpoint: {} });
  assert.equal(result.items.length, 2);
}));

test("page-change revisions preserve A to B to A recurrence", { timeout: 60000 }, () => fixture(async ({ runtime, grant, origin, definition }) => {
  const pageChecker = browserCheckerSchema.parse({ ...definition, kind: "page-change", itemsSelector: "#target", text: { selector: ":scope", attribute: null, format: "text" }, itemId: null, sender: null, incomingSelector: null, outgoingSelector: null });
  const ownerNodeId = randomUUID(), store = new BrowserMonitorStore(new DatabaseSync(":memory:"));
  try {
    let monitor = store.create({ projectId: grant.projectId, name: "Page", checkerId: pageChecker.id, checkerVersion: pageChecker.version, origin, accountId: "monitor@example.test", targetIds: ["chat-1"], intervalSeconds: 10, binding: { nodeId: ownerNodeId, sessionId: grant.sessionId, profileId: grant.profileId, pageId: grant.pageId, engine: "pi", conversationId: grant.conversationId }, readAcknowledged: true }, ownerNodeId, 1);
    monitor = store.setEnabled(monitor.id, monitor.generation, true, 2);
    const emitted: number[] = [];
    for (const [index, text] of ["A", "B", "A", "A", "B"].entries()) {
      await runtime.execute(grant.sessionId, { action: "evaluate", expression: `document.querySelector('#target').innerText=${JSON.stringify(text)}` }, agent);
      if (index) monitor = store.requestCheck(monitor.id, monitor.generation, 3 + index);
      const run = store.claim(monitor.id, ownerNodeId, 3 + index)!;
      const result = await runtime.inspectMonitor(grant, { checker: pageChecker, origin, accountId: monitor.accountId, targetIds: monitor.targetIds, checkpoint: store.get(monitor.id).checkpoint });
      emitted.push(store.complete(run.id, result, 10 + index).length);
      monitor = store.get(monitor.id);
    }
    assert.deepEqual(emitted, [0, 1, 1, 0, 1]);
    const pending = store.pendingEvents(monitor.id);
    assert.equal(pending.length, 3); assert.equal(new Set(pending.map(event => event.externalId)).size, 3);
    assert.equal(store.events(monitor.id).some(event => event.text === "A" && event.observedAt === 10), true);
    assert.equal(pending.some(event => event.observedAt === 10), false);
  } finally { store.close(); }
}));

test("async monitor grants are awaited before DOM access", { timeout: 60000 }, () => fixture(async ({ runtime, grant, origin, definition }) => {
  const input = { checker: definition, origin, accountId: "monitor@example.test", targetIds: ["chat-1"], checkpoint: {} };
  await runtime.execute(grant.sessionId, { action: "evaluate", expression: "window.monitorReads=0;const account=document.querySelector('#account');Object.defineProperty(account,'innerText',{get(){window.monitorReads++;return 'monitor@example.test'}})" }, agent);
  let signalEntered!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { signalEntered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  const read = runtime.inspectMonitor({ ...grant, async assertValid() { signalEntered(); await pending; } }, input);
  await entered;
  await runtime.execute(grant.sessionId, { action: "takeControl" }, human);
  release();
  await assert.rejects(read, error => health(error, "paused-by-human"));
  await runtime.execute(grant.sessionId, { action: "resumeAgent" }, human);
  assert.equal(await runtime.execute(grant.sessionId, { action: "evaluate", expression: "window.monitorReads" }, agent), 0);
}));

test("queued monitor grant revocation is checked after prior work", { timeout: 60000 }, async () => {
  let held: http.ServerResponse | undefined, requestSeen!: () => void;
  const seen = new Promise<void>(resolve => { requestSeen = resolve; });
  try {
    await fixture(async ({ runtime, grant, origin, definition }) => {
      const prior = runtime.execute(grant.sessionId, { action: "evaluate", expression: "fetch('/hold').then(r=>r.text())" }, agent);
      await seen;
      let calls = 0, revoked = false;
      const read = runtime.inspectMonitor({ ...grant, assertValid() { calls++; if (revoked) throw Error("queued grant revoked"); } }, { checker: definition, origin, accountId: "monitor@example.test", targetIds: ["chat-1"], checkpoint: {} });
      const rejection = assert.rejects(read, /queued grant revoked/);
      await new Promise<void>(resolve => setImmediate(resolve));
      const callsBeforeRelease = calls;
      revoked = true; held!.end("released"); held = undefined;
      await rejection; await prior;
      assert.equal(callsBeforeRelease, 0);
      assert.equal(calls, 1);
    }, (req, res) => { if (req.url !== "/hold") return false; held = res; requestSeen(); return true; });
  } finally { held?.end("released"); }
});

test("monitor credential fields reject direct and wrapped secret reads", { timeout: 60000 }, () => fixture(async ({ runtime, grant, origin, definition }) => {
  const sentinel = "synthetic-secret-sentinel";
  await runtime.execute(grant.sessionId, { action: "evaluate", expression: `window.secretReads=0;for(const html of ['<input id="password" type="password">','<textarea id="textarea"></textarea>','<div id="editable" contenteditable="true"></div>','<div id="wrapper"><textarea></textarea></div>'])document.body.insertAdjacentHTML('beforeend',html);for(const element of document.querySelectorAll('#password,#textarea,#editable,#wrapper,#wrapper textarea'))Object.defineProperty(element,'innerText',{get(){window.secretReads++;return ${JSON.stringify(sentinel)}}})` }, agent);
  for (const selector of ["#password", "#textarea", "#editable", "#wrapper"]) {
    const selected = { ...definition, account: { selector, attribute: null, format: "text" } } as BrowserChecker;
    await assert.rejects(runtime.inspectMonitor(grant, { checker: selected, origin, accountId: sentinel, targetIds: ["chat-1"], checkpoint: {} }), error => {
      assert.ok(error instanceof BrowserMonitorCheckError); assert.equal(error.health, "incompatible"); assert.equal(error.message.includes(sentinel), false);
      if (selector === "#wrapper") assert.match(error.message, /Text field contains a forbidden element/); return true;
    });
  }
  assert.equal(await runtime.execute(grant.sessionId, { action: "evaluate", expression: "window.secretReads" }, agent), 0);
}));

test("monitor hidden and ambiguous identity is incompatible", { timeout: 60000 }, () => fixture(async ({ runtime, grant, origin, definition }) => {
  const input = { checker: definition, origin, accountId: "monitor@example.test", targetIds: ["chat-1"], checkpoint: {} };
  await runtime.execute(grant.sessionId, { action: "evaluate", expression: "document.querySelector('#account').hidden=true" }, agent);
  await assert.rejects(runtime.inspectMonitor(grant, input), error => health(error, "incompatible"));
  await runtime.execute(grant.sessionId, { action: "evaluate", expression: "document.querySelector('#account').hidden=false;document.querySelector('#account').insertAdjacentHTML('afterend','<div id=account>monitor@example.test</div>')" }, agent);
  await assert.rejects(runtime.inspectMonitor(grant, input), error => health(error, "incompatible"));
}));

test("monitor source and binding identity errors are classified", { timeout: 60000 }, () => fixture(async ({ runtime, grant, origin, definition }) => {
  const input = { checker: definition, origin, accountId: "monitor@example.test", targetIds: ["chat-1"], checkpoint: {} };
  const otherOrigin = "http://127.0.0.1:1";
  await assert.rejects(runtime.inspectMonitor(grant, { ...input, origin: otherOrigin, checker: { ...definition, origins: [origin, otherOrigin] } }), error => health(error, "wrong-account"));
  await assert.rejects(runtime.inspectMonitor({ ...grant, profileId: randomUUID() }, input), error => health(error, "wrong-account"));
  await assert.rejects(runtime.inspectMonitor({ ...grant, conversationId: randomUUID() }, input), error => health(error, "wrong-account"));
  await assert.rejects(runtime.inspectMonitor({ ...grant, pageId: randomUUID() }, input), error => health(error, "target-missing"));
  await runtime.execute(grant.sessionId, { action: "close" }, agent);
  await assert.rejects(runtime.inspectMonitor(grant, input), error => health(error, "browser-stopped"));
}));

test("monitor empty and partial coverage requires visible evidence", { timeout: 60000 }, () => fixture(async ({ runtime, grant, origin, definition }) => {
  const input = { checker: definition, origin, accountId: "monitor@example.test", targetIds: ["chat-1"], checkpoint: {} };
  await runtime.execute(grant.sessionId, { action: "evaluate", expression: "document.querySelectorAll('.message').forEach(row=>row.remove())" }, agent);
  await assert.rejects(runtime.inspectMonitor(grant, input), error => health(error, "incompatible"));
  await runtime.execute(grant.sessionId, { action: "evaluate", expression: "document.querySelector('#empty').hidden=false" }, agent);
  const empty = await runtime.inspectMonitor(grant, input);
  assert.equal(empty.complete, true); assert.deepEqual(empty.items, []);
  const checkpoint = { "chat-1": "m1" };
  const missing = await runtime.inspectMonitor(grant, { ...input, checkpoint });
  assert.equal(missing.complete, false); assert.deepEqual(missing.checkpoint, checkpoint);
  await runtime.execute(grant.sessionId, { action: "evaluate", expression: "document.querySelector('#loading').hidden=false" }, agent);
  await assert.rejects(runtime.inspectMonitor(grant, input), error => health(error, "incompatible"));
  await runtime.execute(grant.sessionId, { action: "evaluate", expression: "document.querySelector('#loading').hidden=true" }, agent);
  assert.equal((await runtime.inspectMonitor(grant, { ...input, targetIds: [] })).complete, false);
  assert.equal((await runtime.inspectMonitor(grant, { ...input, targetIds: ["chat-1", "chat-2"] })).complete, false);
}));
