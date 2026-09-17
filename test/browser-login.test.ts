import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { chromium } from "playwright-core";
import { BrowserRuntime } from "../src/browser-runtime.js";
import { BrowserStore } from "../src/browser-store.js";
import { resolveDataDirectory } from "../src/data-directory.js";
import type { MonitorReadInput } from "../src/browser-monitor-checkers.js";
import { browserLoginDetectionScript } from "../src/browser-login-detection.js";
import { waitForAssertion } from "./async-assertion.js";

const agent = { kind: "agent" } as const;
const human = (id: string) => ({ kind: "human" as const, id });
const deferred = <T = void>() => { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

type MockPage = EventEmitter & {
  url(): string; title(): Promise<string>; mainFrame(): object; goto(url: string): Promise<void>;
  keyboard: { insertText(text: string): Promise<void>; press(key: string): Promise<void> };
  mouse: { click(): Promise<void>; wheel(): Promise<void> }; locator(selector: string): any;
  evaluate(expression: string): Promise<unknown>; close(): Promise<void>;
  setUrl(url: string, emit?: boolean): void; visible: Map<string, boolean>; calls: Record<string, number>;
  detectionResult: "credentials" | "challenge" | null;
  detectionGate: null | { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
  visibilityGate: null | { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
  evaluateGate: null | { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> };
};

function fixture(t: TestContext) {
  const pages: MockPage[] = [];
  const contexts: EventEmitter[] = [];
  const makePage = (): MockPage => {
    let url = "about:blank";
    const frame = {};
    const visible = new Map<string, boolean>();
    const calls: Record<string, number> = { goto: 0, text: 0, key: 0, evaluate: 0, close: 0 };
    const page = Object.assign(new EventEmitter(), {
      url: () => url, title: async () => "", mainFrame: () => frame, visible, calls, detectionResult: null as MockPage["detectionResult"],
      detectionGate: null as MockPage["detectionGate"], visibilityGate: null as MockPage["visibilityGate"], evaluateGate: null as MockPage["evaluateGate"],
      setUrl(next: string, emit = true) { url = next; if (emit) page.emit("framenavigated", frame); },
      async goto(next: string) { calls.goto++; page.setUrl(next); },
      keyboard: { async insertText(_text: string) { calls.text++; }, async press(_key: string) { calls.key++; } },
      mouse: { async click() {}, async wheel() {} },
      locator(selector: string) {
        const item = { async isVisible() { if (page.visibilityGate) { page.visibilityGate.entered.resolve(); await page.visibilityGate.release.promise; } return visible.get(selector) ?? false; } };
        return { filter: () => ({ first: () => item }), first: () => item, ariaSnapshot: async () => "", waitFor: async () => {} };
      },
      async evaluate(expression: string) { if (expression === browserLoginDetectionScript) { const result = page.detectionResult; if (page.detectionGate) { page.detectionGate.entered.resolve(); await page.detectionGate.release.promise; } return result; } calls.evaluate++; if (page.evaluateGate) { page.evaluateGate.entered.resolve(); await page.evaluateGate.release.promise; } return true; },
      async close() { calls.close++; page.emit("close"); },
      bringToFront: async () => {}, waitForFunction: async () => true, screenshot: async () => Buffer.from(""),
    });
    pages.push(page);
    return page;
  };
  t.mock.method(chromium, "launchPersistentContext", async () => {
    const context = Object.assign(new EventEmitter(), {
      setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, pages: () => [],
      async newPage() { const page = makePage(); context.emit("page", page); return page; },
      async close() { context.emit("close"); }, setStorageState: async () => {},
    });
    contexts.push(context);
    return context as never;
  });
  const runtime = () => new BrowserRuntime({ capability: async () => ({ supported: true, available: true, executable: process.execPath, reason: null }) });
  return { runtime, pages, contexts };
}

const start = (name = randomUUID()) => ({ projectId: `login-${name}`, engine: "pi" as const, conversationId: randomUUID(), appNodeId: randomUUID(), profileName: name, url: "https://mail.google.com" });
const request = { action: "requestLogin" as const, expectedOrigin: "https://mail.google.com", readySelector: "#ready", loginSelector: "#login", label: "Mail login" };

async function controlledPending(runtime: BrowserRuntime, page: MockPage, id: string) {
  const pending = await runtime.execute(id, request, agent) as any;
  await runtime.execute(id, { action: "takeControl", force: true }, human("owner"));
  page.setUrl("https://mail.google.com/inbox");
  return pending.loginRequest as { id: string };
}

async function cleanup(runtime: BrowserRuntime, id: string, owner = "owner") {
  try { await runtime.execute(id, { action: "takeControl", force: true }, human(owner)); await runtime.execute(id, { action: "close" }, human(owner)); } catch {}
  await runtime.close();
}

test("Gmail sign-in navigation automatically persists and pauses login", async t => {
  const f = fixture(t), runtime = f.runtime();
  const session = await runtime.create(start());
  try {
    f.pages.at(-1)!.setUrl("https://accounts.google.com/v3/signin");
    const paused = await runtime.get(session.id);
    assert.equal(paused.loginRequest?.expectedOrigin, "https://mail.google.com");
    await assert.rejects(runtime.execute(session.id, { action: "snapshot" }, agent), /login required|paused/i);
  } finally { await cleanup(runtime, session.id, "cleanup"); }
});

test("automatic login labels are bounded while preserving the exact origin", async t => {
  const f = fixture(t), runtime = f.runtime(); const session = await runtime.create(start()); const page = f.pages.at(-1)!;
  const hostname = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.example`;
  const origin = `https://${hostname}`;
  try {
    page.detectionResult = "credentials"; page.setUrl(`${origin}/login`);
    const paused = await waitForAssertion(async () => { const view = await runtime.get(session.id); assert.ok(view.loginRequest); return view; });
    assert.equal(paused.loginRequest!.expectedOrigin, origin);
    assert.equal(paused.loginRequest!.label.length, 80);
  } finally { await cleanup(runtime, session.id, "cleanup"); }
});

test("stale automatic login detection is discarded after a silent URL change", async t => {
  const f = fixture(t), runtime = f.runtime(); const session = await runtime.create({ ...start(), url: "https://login.example.test" }); const page = f.pages.at(-1)!;
  const gate = { entered: deferred(), release: deferred() }; let probe: Promise<void> | undefined;
  try {
    page.detectionResult = "credentials"; page.detectionGate = gate; page.setUrl("https://login.example.test/sign-in");
    void runtime.get(session.id); await gate.entered.promise;
    probe = (runtime as unknown as { sessions: Map<string, { loginDetection?: Promise<void> }> }).sessions.get(session.id)!.loginDetection!;
    page.setUrl("https://login.example.test/elsewhere", false); page.detectionResult = null; gate.release.resolve(); await probe;
    assert.equal((await runtime.get(session.id)).loginRequest, null);
  } finally { gate.release.resolve(); await probe?.catch(() => {}); await cleanup(runtime, session.id, "cleanup"); }
});

test("stale automatic login detection is discarded after same-URL navigation", async t => {
  const f = fixture(t), runtime = f.runtime(); const session = await runtime.create({ ...start(), url: "https://login.example.test" }); const page = f.pages.at(-1)!;
  const gate = { entered: deferred(), release: deferred() }; let probe: Promise<void> | undefined;
  try {
    page.detectionResult = "credentials"; page.detectionGate = gate; page.setUrl("https://login.example.test/sign-in");
    void runtime.get(session.id); await gate.entered.promise;
    probe = (runtime as unknown as { sessions: Map<string, { loginDetection?: Promise<void> }> }).sessions.get(session.id)!.loginDetection!;
    page.setUrl("https://login.example.test/sign-in"); page.detectionResult = null; gate.release.resolve(); await probe;
    assert.equal((await runtime.get(session.id)).loginRequest, null);
  } finally { gate.release.resolve(); await probe?.catch(() => {}); await cleanup(runtime, session.id, "cleanup"); }
});

test("stale automatic login detection is discarded after credential policy changes", async t => {
  const f = fixture(t), runtime = f.runtime(); const session = await runtime.create({ ...start(), url: "https://login.example.test" }); const page = f.pages.at(-1)!;
  const gate = { entered: deferred(), release: deferred() }; let probe: Promise<void> | undefined;
  try {
    page.detectionResult = "credentials"; page.detectionGate = gate; page.setUrl("https://login.example.test/sign-in");
    void runtime.get(session.id); await gate.entered.promise;
    probe = (runtime as unknown as { sessions: Map<string, { loginDetection?: Promise<void> }> }).sessions.get(session.id)!.loginDetection!;
    await runtime.execute(session.id, { action: "snapshot" }, { kind: "agent", credentialOrigins: ["https://login.example.test"] });
    page.detectionResult = null; gate.release.resolve(); await probe;
    assert.equal((await runtime.get(session.id)).loginRequest, null);
  } finally { gate.release.resolve(); await probe?.catch(() => {}); await cleanup(runtime, session.id, "cleanup"); }
});

test("stale automatic login detection cannot interrupt human ownership", async t => {
  const f = fixture(t), runtime = f.runtime(); const session = await runtime.create({ ...start(), url: "https://login.example.test" }); const page = f.pages.at(-1)!;
  const gate = { entered: deferred(), release: deferred() }; let probe: Promise<void> | undefined;
  try {
    page.detectionResult = "credentials"; page.detectionGate = gate; page.setUrl("https://login.example.test/sign-in");
    void runtime.get(session.id); await gate.entered.promise;
    probe = (runtime as unknown as { sessions: Map<string, { loginDetection?: Promise<void> }> }).sessions.get(session.id)!.loginDetection!;
    await runtime.execute(session.id, { action: "takeControl" }, human("owner"));
    page.detectionResult = null; gate.release.resolve(); await probe;
    const view = await runtime.get(session.id); assert.equal(view.loginRequest, null); assert.equal(view.owner, "human");
  } finally { gate.release.resolve(); await probe?.catch(() => {}); await cleanup(runtime, session.id); }
});

test("controlling human can navigate and type while login is pending", async t => {
  const f = fixture(t), runtime = f.runtime(); const session = await runtime.create(start()); const page = f.pages.at(-1)!;
  try {
    await controlledPending(runtime, page, session.id);
    await runtime.execute(session.id, { action: "text", text: "person@example.test" }, human("owner"));
    await runtime.execute(session.id, { action: "key", key: "Tab" }, human("owner"));
    await runtime.execute(session.id, { action: "navigate", url: "https://mail.google.com/signin" }, human("owner"));
    assert.deepEqual([page.calls.text, page.calls.key, page.calls.goto], [1, 1, 2]);
  } finally { await cleanup(runtime, session.id); }
});

test("lookalike Google hosts do not trigger automatic login", async t => {
  const f = fixture(t), runtime = f.runtime(); const session = await runtime.create(start());
  try { f.pages.at(-1)!.setUrl("https://accounts.google.com.evil.example/signin"); assert.equal((await runtime.get(session.id)).loginRequest, null); }
  finally { await cleanup(runtime, session.id, "cleanup"); }
});

test("login requests default, remain idempotent, and reject conflicts and invalid origins", async t => {
  const f = fixture(t), runtime = f.runtime(); const session = await runtime.create(start());
  try {
    const minimal = { action: "requestLogin" as const, expectedOrigin: "https://mail.google.com", readySelector: "#ready" };
    const first = await runtime.execute(session.id, minimal, agent) as any;
    const second = await runtime.execute(session.id, minimal, agent) as any;
    assert.equal(first.loginRequest.id, second.loginRequest.id); assert.equal(first.loginRequest.label, "Sign in"); assert.equal(first.loginRequest.loginSelector, null);
    for (const changed of [{ ...minimal, expectedOrigin: "https://example.com" }, { ...minimal, readySelector: "#other" }, { ...minimal, label: "Other" }]) await assert.rejects(runtime.execute(session.id, changed, agent), /different.*pending/i);
    await assert.rejects(runtime.execute(session.id, { ...minimal, expectedOrigin: "https://mail.google.com/path" }, agent));
    const store = new BrowserStore();
    try { assert.throws(() => store.loginRequest(randomUUID()), /not found/i); assert.throws(() => store.setLoginRequest(randomUUID(), null), /not found/i); } finally { store.close(); }
  } finally { await cleanup(runtime, session.id, "cleanup"); }
});

test("automatic takeover is bound to the exact pending login request", async t => {
  const f = fixture(t), runtime = f.runtime(); const session = await runtime.create(start()); const page = f.pages.at(-1)!;
  try {
    const pending = await runtime.execute(session.id, request, agent) as any;
    await assert.rejects(runtime.execute(session.id, { action: "takeControl", loginRequestId: randomUUID() } as any, human("owner")), /login request changed/i);
    assert.equal((await runtime.get(session.id)).owner, "agent");
    await runtime.execute(session.id, { action: "takeControl", loginRequestId: pending.loginRequest.id } as any, human("owner"));
    assert.equal((await runtime.get(session.id)).owner, "human");
    page.setUrl("https://mail.google.com/inbox"); page.visible.set("#ready", true); page.visible.set("#login", false);
    await runtime.execute(session.id, { action: "completeLogin", requestId: pending.loginRequest.id, expectedPageId: session.activePageId! }, human("owner"));
    await assert.rejects(runtime.execute(session.id, { action: "takeControl", loginRequestId: pending.loginRequest.id } as any, human("owner")), /login request changed/i);
    assert.equal((await runtime.get(session.id)).owner, "agent");
    await runtime.execute(session.id, { action: "takeControl" }, human("owner"));
    await assert.rejects(runtime.execute(session.id, { action: "takeControl", loginRequestId: pending.loginRequest.id } as any, human("other")), /another human/);
    assert.equal((await runtime.get(session.id)).owner, "human");
  } finally { await cleanup(runtime, session.id); }
});

test("manual takeover without a login request remains available", async t => {
  const f = fixture(t), runtime = f.runtime(); const session = await runtime.create(start());
  try {
    await runtime.execute(session.id, { action: "takeControl" }, human("owner"));
    assert.equal((await runtime.get(session.id)).owner, "human");
  } finally { await cleanup(runtime, session.id); }
});

test("delayed title view reads a login request after the title resolves", async t => {
  const f = fixture(t), runtime = f.runtime(); const session = await runtime.create(start()); const page = f.pages.at(-1)!;
  const gate = { entered: deferred(), release: deferred() };
  const normalTitle = page.title.bind(page); let titleCalls = 0; let delayed: Promise<any> | undefined;
  page.title = async () => { if (titleCalls++ === 0) { gate.entered.resolve(); await gate.release.promise; } return normalTitle(); };
  try {
    delayed = runtime.get(session.id); await gate.entered.promise;
    const fresh = await runtime.execute(session.id, request, agent) as any;
    gate.release.resolve();
    assert.equal((await delayed).loginRequest?.id, fresh.loginRequest.id);
  } finally { gate.release.resolve(); await delayed?.catch(() => {}); await cleanup(runtime, session.id, "cleanup"); }
});

test("delayed title view reads cleared login state after completion", async t => {
  const f = fixture(t), runtime = f.runtime(); const session = await runtime.create(start()); const page = f.pages.at(-1)!;
  const pending = await controlledPending(runtime, page, session.id); const pageId = session.activePageId!;
  page.visible.set("#ready", true); page.visible.set("#login", false);
  const gate = { entered: deferred(), release: deferred() };
  const normalTitle = page.title.bind(page); let titleCalls = 0; let delayed: Promise<any> | undefined;
  page.title = async () => { if (titleCalls++ === 0) { gate.entered.resolve(); await gate.release.promise; } return normalTitle(); };
  try {
    delayed = runtime.get(session.id); await gate.entered.promise;
    const fresh = await runtime.execute(session.id, { action: "completeLogin", requestId: pending.id, expectedPageId: pageId }, human("owner")) as any;
    assert.equal(fresh.loginRequest, null); assert.equal(fresh.owner, "agent");
    gate.release.resolve();
    const stale = await delayed; assert.equal(stale.loginRequest, null); assert.equal(stale.owner, "agent");
  } finally { gate.release.resolve(); await delayed?.catch(() => {}); await cleanup(runtime, session.id, "cleanup"); }
});

test("pending login blocks every agent operation but permits only the controlling human", async t => {
  const f = fixture(t), runtime = f.runtime(); const session = await runtime.create(start()); const page = f.pages.at(-1)!;
  try {
    const pending = await controlledPending(runtime, page, session.id);
    const commands: any[] = [{ action: "evaluate", expression: "1" }, { action: "navigate", url: "https://mail.google.com/x" }, { action: "snapshot" }, { action: "wait", selector: "body" }, { action: "close" }, { action: "completeLogin", requestId: pending.id, expectedPageId: session.activePageId }, { action: "resumeAgent" }];
    for (const command of commands) await assert.rejects(runtime.execute(session.id, command, agent), /login required|paused/i);
    assert.equal(page.calls.evaluate, 0); assert.equal(page.calls.close, 0);
    await runtime.execute(session.id, { action: "text", text: "x" }, human("owner"));
    await assert.rejects(runtime.execute(session.id, { action: "key", key: "A" }, human("other")), /another human/);
    await assert.rejects(runtime.execute(session.id, { action: "completeLogin", requestId: pending.id, expectedPageId: session.activePageId! }, human("other")), /controlling human/);
    await assert.rejects(runtime.execute(session.id, request, agent), /human control/i);
    await assert.rejects(runtime.execute(session.id, { action: "resumeAgent" }, human("owner")), /login required|paused/i);
  } finally { await cleanup(runtime, session.id); }
});

test("pending login rejects admission immediately and fences work queued before the pause", async t => {
  const f = fixture(t), runtime = f.runtime(); const session = await runtime.create(start()); const page = f.pages.at(-1)!;
  const firstGate = { entered: deferred(), release: deferred() };
  try {
    page.evaluateGate = firstGate;
    const first = runtime.execute(session.id, { action: "evaluate", expression: "first" }, agent); await firstGate.entered.promise;
    const second = runtime.execute(session.id, { action: "evaluate", expression: "second" }, agent);
    void second.catch(() => {});
    await runtime.execute(session.id, request, agent);
    const immediate = runtime.execute(session.id, { action: "navigate", url: "https://mail.google.com/no" }, agent);
    let outcome: "pending" | "rejected" | "resolved" = "pending";
    void immediate.then(() => { outcome = "resolved"; }, () => { outcome = "rejected"; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(outcome, "rejected", "pending login admission must reject before queued native work is released");
      await assert.rejects(immediate, /login required|paused/i);
    } finally { firstGate.release.resolve(); }
    await first;
    await assert.rejects(second, /login required|paused/i); assert.equal(page.calls.evaluate, 1);
  } finally { firstGate.release.resolve(); await cleanup(runtime, session.id, "cleanup"); }
});

test("completion validates request, page, origin, readiness and clears only on verified success", async t => {
  const f = fixture(t), runtime = f.runtime(); const session = await runtime.create(start()); const page = f.pages.at(-1)!;
  try {
    const pending = await controlledPending(runtime, page, session.id); const pageId = (await runtime.get(session.id)).activePageId!;
    const done = (rid = pending.id, pid = pageId) => runtime.execute(session.id, { action: "completeLogin", requestId: rid, expectedPageId: pid }, human("owner"));
    const assertPending = async () => { const state = await runtime.get(session.id); assert.equal(state.loginRequest?.id, pending.id); assert.equal(state.owner, "human"); };
    page.visible.set("#ready", true); page.visible.set("#login", false); page.setUrl("https://example.com");
    await assert.rejects(done(), /could not be verified/); await assertPending();
    page.setUrl("https://mail.google.com/inbox"); page.visible.set("#ready", false);
    await assert.rejects(done(), /could not be verified/); await assertPending();
    page.visible.set("#ready", true); page.visible.set("#login", true);
    await assert.rejects(done(), /could not be verified/); await assertPending();
    page.visible.set("#login", false);
    await assert.rejects(done(randomUUID()), /could not be verified/); await assertPending();
    await assert.rejects(done(pending.id, randomUUID()), /could not be verified/); await assertPending();
    await done(); assert.equal((await runtime.get(session.id)).loginRequest, null); assert.equal((await runtime.get(session.id)).owner, "agent");
    await runtime.execute(session.id, { action: "evaluate", expression: "after" }, agent); assert.equal(page.calls.evaluate, 1);
  } finally { await cleanup(runtime, session.id, "cleanup"); }
});

test("delayed completion is fenced by navigation, silent URL changes, and control ABA", async t => {
  for (const mutation of ["navigation", "silent-url", "control-aba"] as const) {
    const f = fixture(t), runtime = f.runtime(); const session = await runtime.create(start()); const page = f.pages.at(-1)!;
    const gate = { entered: deferred(), release: deferred() };
    try {
      const pending = await controlledPending(runtime, page, session.id); const pageId = (await runtime.get(session.id)).activePageId!;
      page.visible.set("#ready", true); page.visible.set("#login", false);
      page.visibilityGate = gate;
      const completing = runtime.execute(session.id, { action: "completeLogin", requestId: pending.id, expectedPageId: pageId }, human("owner")); await gate.entered.promise;
      try {
        if (mutation === "navigation") { page.setUrl("https://mail.google.com/other"); page.setUrl("https://mail.google.com/inbox"); }
        if (mutation === "silent-url") page.setUrl("https://mail.google.com/other", false);
        if (mutation === "control-aba") { await runtime.execute(session.id, { action: "takeControl", force: true }, human("B")); await runtime.execute(session.id, { action: "takeControl", force: true }, human("owner")); }
      } finally { gate.release.resolve(); }
      await assert.rejects(completing, /could not be verified/); assert.equal((await runtime.get(session.id)).loginRequest?.id, pending.id);
    } finally { gate?.release.resolve(); await cleanup(runtime, session.id); }
  }
});

const monitorInput: MonitorReadInput = { origin: "https://mail.google.com", accountId: "a@example.test", targetIds: ["target"], checkpoint: {}, checker: { id: "mail", version: 1, name: "Mail", origins: ["https://mail.google.com"], kind: "messages", readySelector: "#ready", loginSelector: "#login", loadingSelector: null, emptySelector: "#empty", account: { selector: "#account", attribute: null, format: "email" }, target: { selector: "#target", attribute: null, format: "text" }, targetLabel: { selector: "#label", attribute: null, format: "text" }, itemsSelector: ".item", itemId: { selector: ":scope", attribute: "data-message-id", format: "text" }, sender: { selector: ".sender", attribute: null, format: "email" }, text: { selector: ".text", attribute: null, format: "text" }, incomingSelector: ".incoming", outgoingSelector: ".outgoing" } };

test("monitor reads fail needs-login before native evaluation", async t => {
  const f = fixture(t), runtime = f.runtime(); const session = await runtime.create(start()); const page = f.pages.at(-1)!;
  try {
    await runtime.execute(session.id, request, agent); const view = await runtime.get(session.id);
    const grant = { sessionId: session.id, projectId: session.projectId, conversationId: session.conversationId, profileId: session.profileId!, pageId: view.activePageId!, assertValid: () => {} };
    await assert.rejects(runtime.inspectMonitor(grant, monitorInput), (error: any) => error.health === "needs-login"); assert.equal(page.calls.evaluate, 0);
  } finally { await cleanup(runtime, session.id, "cleanup"); }
});

test("login request is shared, survives checkpoints, and corrupt storage fails closed", async t => {
  const f = fixture(t), runtime = f.runtime(); const session = await runtime.create(start()); const page = f.pages.at(-1)!;
  const store = new BrowserStore();
  try {
    const pending = await runtime.execute(session.id, request, agent) as any; assert.equal(store.loginRequest(session.id)?.id, pending.loginRequest.id);
    page.setUrl("https://mail.google.com/next"); assert.equal(store.loginRequest(session.id)?.id, pending.loginRequest.id);
    const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db")); try { db.prepare("UPDATE browser_sessions SET loginRequest = ? WHERE id = ?").run("{bad", session.id); } finally { db.close(); }
    assert.throws(() => store.loginRequest(session.id), /Invalid browser login request/); await assert.rejects(runtime.execute(session.id, { action: "snapshot" }, agent), /Invalid browser login request/);
    store.setLoginRequest(session.id, pending.loginRequest);
  } finally { store.close(); await cleanup(runtime, session.id, "cleanup"); }
});

test("runtime restart restores pending login with fresh page identity until owner verifies", async t => {
  const f = fixture(t); let runtime = f.runtime(); const session = await runtime.create(start()); const firstPageId = (await runtime.get(session.id)).activePageId!;
  await runtime.execute(session.id, request, agent); await runtime.close();
  runtime = f.runtime(); await runtime.ready();
  try {
    const restored = await runtime.get(session.id); assert.equal(restored.loginRequest?.expectedOrigin, request.expectedOrigin); assert.notEqual(restored.activePageId, firstPageId);
    await assert.rejects(runtime.execute(session.id, { action: "snapshot" }, agent), /login required|paused/i);
    await runtime.execute(session.id, { action: "takeControl", force: true }, human("owner")); const page = f.pages.at(-1)!; page.setUrl("https://mail.google.com/inbox"); page.visible.set("#ready", true); page.visible.set("#login", false);
    await assert.rejects(runtime.execute(session.id, { action: "completeLogin", requestId: restored.loginRequest!.id, expectedPageId: firstPageId }, human("owner")), /could not be verified/);
    await runtime.execute(session.id, { action: "completeLogin", requestId: restored.loginRequest!.id, expectedPageId: restored.activePageId! }, human("owner"));
  } finally { await cleanup(runtime, session.id, "cleanup"); }
});
