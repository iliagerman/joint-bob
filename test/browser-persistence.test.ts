import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { readFile, stat, access, rm, writeFile, mkdir } from "node:fs/promises";
import type { WebSocket } from "ws";
import path from "node:path";
import { chromium } from "playwright-core";
import { BrowserRuntime } from "../src/browser-runtime.js";
import { BrowserStore } from "../src/browser-store.js";
import { resolveDataDirectory } from "../src/data-directory.js";

function mockChrome(t: TestContext, failures: { launch?: (directory: string) => boolean; import?: boolean; startupPage?: boolean } = {}) {
  const previous = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = path.join(resolveDataDirectory(), randomUUID());
  const directory = process.env.PI_WEB_DATA_DIR;
  t.after(async () => { process.env.PI_WEB_DATA_DIR = previous; await rm(directory, { recursive: true, force: true }); });
  const launches: Array<{ directory: string; options: any; context: any; imports: unknown[] }> = [];
  t.mock.method(chromium, "launch", async () => { throw new Error("Ephemeral launch forbidden"); });
  t.mock.method(chromium, "launchPersistentContext", async (directory: string, options: any) => {
    if (failures.launch?.(directory)) throw new Error("Simulated profile lock failure");
    const pages: any[] = [];
    const imports: unknown[] = [];
    let closed = false;
    const context = Object.assign(new EventEmitter(), {
      setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, pages: () => pages,
      newCDPSession: async () => Object.assign(new EventEmitter(), { detach: async () => {}, send: async () => {} }),
      setStorageState: async (state: unknown) => { if (failures.import) throw new Error("Simulated import failure: sensitive-storage-fixture"); imports.push(state); },
      newPage: async () => {
        if (closed) throw new Error("Persistent context closed after last page");
        let url = "about:blank";
        const page = Object.assign(new EventEmitter(), {
          url: () => url, title: async () => url, bringToFront: async () => {},
          mainFrame: () => page,
          goto: async (next: string) => { url = next; page.emit("framenavigated", page); },
          close: async () => {
            pages.splice(pages.indexOf(page), 1); page.emit("close");
            if (failures.startupPage && !pages.length) { closed = true; context.emit("close"); }
          },
        });
        pages.push(page); context.emit("page", page); return page;
      },
      close: async () => { for (const page of [...pages]) await page.close(); context.emit("close"); },
    });
    if (failures.startupPage) await context.newPage();
    launches.push({ directory, options, context, imports });
    return context;
  });
  return launches;
}
const capability = async () => ({ supported: true, available: true, executable: process.execPath, reason: null });
const identity = () => ({ projectId: randomUUID(), conversationId: randomUUID(), appNodeId: randomUUID(), engine: "pi" as const });
const agent = { kind: "agent" as const };

test("native profiles isolate accounts, enforce leases, rename in place and delete only ended profile", async t => {
  const launches = mockChrome(t);
  const runtime = new BrowserRuntime({ capability });
  const start = identity();
  try {
    const first = await runtime.create({ ...start, profileName: " Personal " });
    const second = await runtime.create({ ...start, profileName: "Work" });
    assert.notEqual(first.profileId, second.profileId);
    assert.equal(first.profileLabel, "Personal");
    assert.equal((await runtime.list(start)).filter(row => row.state === "running").length, 2);
    await assert.rejects(runtime.create(start), /explicit.*profile|multiple/i);
    await assert.rejects(runtime.create({ ...start, profileName: "Work" }), /label|name|exists/i);
    await assert.rejects(runtime.create({ ...start, conversationId: randomUUID(), profileId: first.profileId }), /use|lease|running/i);
    assert.equal((await runtime.create({ ...start, engine: "claude", profileId: first.profileId })).id, first.id);
    const renamed: any = await runtime.execute(first.id, { action: "saveProfile", label: "Private" }, agent);
    assert.equal(renamed.id, first.profileId);
    assert.equal(renamed.persistent, true);
    assert.equal(launches.length, 2);
    assert.equal(launches[0].options.proxy, undefined);
    assert.equal((await stat(launches[0].directory)).mode & 0o777, 0o700);
    const preferences = JSON.parse(await readFile(path.join(launches[0].directory, "Default", "Preferences"), "utf8"));
    assert.equal(preferences.credentials_enable_service, false);
    assert.equal(preferences.profile.password_manager_enabled, false);
    await assert.rejects(runtime.deleteProfile(first.profileId!, start.projectId), /running|pending|use/i);
    await runtime.execute(first.id, { action: "close" }, agent);
    await runtime.deleteProfile(first.profileId!, start.projectId);
    await assert.rejects(access(launches[0].directory));
    await access(launches[1].directory);
    await runtime.execute(second.id, { action: "close" }, agent);
  } finally { await runtime.close(); }
});

test("restart retains IDs, origins, tab selection and human pause but discards pending requests", async t => {
  const launches = mockChrome(t);
  const start = identity();
  let runtime = new BrowserRuntime({ capability });
  try {
    const first = await runtime.create({ ...start, url: "https://example.com/logout?token=dummy#callback" });
    await runtime.execute(first.id, { action: "newTab", url: "https://other.example/transaction?execute=true" }, agent);
    await runtime.execute(first.id, { action: "selectTab", pageId: first.activePageId! }, agent);
    await runtime.execute(first.id, { action: "takeControl" }, { kind: "human", id: "human-one" });
    launches[0].context.pages()[0].emit("filechooser", {});
    await runtime.close();
    const store = new BrowserStore();
    assert.equal(store.get(first.id).restoreOnRestart, true);
    assert.throws(() => store.deleteProfile(first.profileId!, start.projectId), /running|pending|use/i);
    store.close();
    runtime = new BrowserRuntime({ capability });
    await runtime.ready();
    const restored = await runtime.get(first.id);
    assert.equal(restored.state, "running");
    assert.deepEqual(restored.tabs.map(tab => tab.url), ["https://example.com", "https://other.example"]);
    assert.equal(restored.activePageId, restored.tabs[0].id);
    assert.notEqual(restored.activePageId, first.activePageId);
    assert.equal(restored.owner, "human");
    assert.equal(restored.fileChooserRequest, null);
    assert.equal(restored.dialog, null);
    assert.equal(launches[1].directory, launches[0].directory);
    await assert.rejects(runtime.execute(first.id, { action: "navigate", url: "https://example.com" }, agent), /human control/);
    await runtime.execute(first.id, { action: "close" }, { kind: "human", id: "human-one" });
    await runtime.close();
    runtime = new BrowserRuntime({ capability });
    await runtime.ready();
    assert.equal((await runtime.get(first.id)).restoreOnRestart, false);
    assert.equal(launches.length, 2);
  } finally { await runtime.close(); }
});

test("legacy encrypted snapshot imports once and fresh native auth is never overwritten", async t => {
  const launches = mockChrome(t);
  const start = identity();
  const store = new BrowserStore();
  const state = { cookies: [], origins: [{ origin: "https://example.com", localStorage: [{ name: "auth", value: "dummy" }] }] };
  const profile = store.saveProfile(start.projectId, "Legacy", state);
  store.close();
  let runtime = new BrowserRuntime({ capability });
  try {
    const session = await runtime.create({ ...start, profileId: profile.id });
    assert.deepEqual(launches[0].imports, [state]);
    assert.equal((await runtime.profiles(start.projectId))[0].persistent, true);
    await runtime.close();
    runtime = new BrowserRuntime({ capability });
    await runtime.ready();
    assert.deepEqual(launches[1].imports, []);
    await runtime.execute(session.id, { action: "close" }, agent);
  } finally { await runtime.close(); }
});

test("failed restore stays visible without retry loops or blocking another account", async t => {
  let failedProfile: string | undefined;
  const launches = mockChrome(t, { launch: directory => path.basename(directory) === failedProfile });
  const start = identity();
  let runtime = new BrowserRuntime({ capability });
  try {
    const a = await runtime.create({ ...start, profileName: "A" });
    const b = await runtime.create({ ...start, profileName: "B" });
    await runtime.close();
    failedProfile = a.profileId;
    runtime = new BrowserRuntime({ capability });
    await runtime.ready();
    const [first, second] = await Promise.all([runtime.get(a.id), runtime.get(b.id)]);
    assert.equal(first.state, "interrupted");
    assert.match(first.error!, /restore failed.*Simulated profile lock failure/);
    assert.equal(first.restoreOnRestart, true);
    assert.equal(second.state, "running");
    await runtime.list(start); await runtime.ready();
    assert.equal(launches.length, 3, "Repeated reads must not retry failed recovery");
    failedProfile = undefined;
    assert.equal((await runtime.create({ ...start, profileId: a.profileId })).id, a.id, "Explicit start retries the failed session");
    await runtime.execute(a.id, { action: "close" }, agent);
    await runtime.execute(b.id, { action: "close" }, agent);
  } finally { await runtime.close(); }
});

test("initialized runtime captures implicit pending request before a synchronous replacement", async t => {
  const launches = mockChrome(t);
  const runtime = new BrowserRuntime({ capability });
  try {
    const view = await runtime.create(identity());
    const page = launches[0].context.pages()[0];
    let accepted = 0;
    const dialog = () => ({ type: () => "confirm", message: () => "fixture", defaultValue: () => "", accept: async () => { accepted++; } });
    page.emit("dialog", dialog());
    const response = runtime.execute(view.id, { action: "dialog", accept: true }, agent);
    page.emit("dialog", dialog());
    await response;
    assert.equal(accepted, 1);
    assert.notEqual((await runtime.get(view.id)).dialog, null, "Replacement dialog must remain pending, never receive prior approval");
    await runtime.execute(view.id, { action: "close" }, agent);
  } finally { await runtime.close(); }
});

test("staging cleanup failure releases a closed native profile without hiding the error", async t => {
  mockChrome(t);
  const runtime = new BrowserRuntime({ capability });
  const start = identity();
  let blocker: string | undefined;
  try {
    const session = await runtime.create({ ...start, profileName: "Cleanup" });
    blocker = path.join(resolveDataDirectory(), "browser", session.id);
    await writeFile(blocker, "not a directory");
    await assert.rejects(runtime.execute(session.id, { action: "close" }, agent), /ENOTDIR/);
    assert.equal((await runtime.get(session.id)).state, "closed");
    await rm(blocker); blocker = undefined;
    const reopened = await runtime.create({ ...start, profileId: session.profileId });
    assert.notEqual(reopened.id, session.id, "Closed profile must not retain a poisoned runtime lease");
    await runtime.execute(reopened.id, { action: "close" }, agent);
    await runtime.deleteProfile(session.profileId!, start.projectId);
  } finally {
    if (blocker) await rm(blocker);
    try { await runtime.close(); }
    catch (error) { assert.match(String(error), /ENOTDIR/, "Only the injected cleanup fault may escape teardown"); }
  }
});

test("runtime shutdown reports cleanup faults only after the other profiles close", async t => {
  const launches = mockChrome(t);
  const runtime = new BrowserRuntime({ capability });
  const start = identity();
  const first = await runtime.create({ ...start, profileName: "Faulty cleanup" });
  await runtime.create({ ...start, profileName: "Other account" });
  const blocker = path.join(resolveDataDirectory(), "browser", first.id);
  await writeFile(blocker, "not a directory");
  const close = launches[1].context.close;
  launches[1].context.close = async () => { await new Promise(resolve => setTimeout(resolve, 50)); await close(); };
  try {
    await assert.rejects(runtime.close(), (error: unknown) => {
      assert.equal(launches[1].context.pages().length, 0, "Other account must finish shutdown before returning a failure");
      assert.ok(error instanceof AggregateError);
      assert.match(String(error.errors[0]), /ENOTDIR/);
      return true;
    });
  } finally {
    const sessions = (runtime as unknown as { sessions: Map<string, { stopping?: Promise<void> }> }).sessions;
    await Promise.allSettled([...sessions.values()].map(session => session.stopping));
    await close();
    await rm(blocker);
  }
});

test("SQLite lease covers launch and context shutdown, not only running pages", async t => {
  const launches = mockChrome(t);
  const start = identity();
  const store = new BrowserStore();
  const profile = store.createProfile(start.projectId, "Lease");
  let releaseLaunch!: () => void;
  let enteredLaunch!: () => void;
  const entered = new Promise<void>(resolve => { enteredLaunch = resolve; });
  const blocked = new Promise<void>(resolve => { releaseLaunch = resolve; });
  const runtime = new BrowserRuntime({ capability: async () => { enteredLaunch(); await blocked; return capability(); } });
  try {
    const starting = runtime.create({ ...start, profileId: profile.id });
    await entered;
    assert.throws(() => store.assertProfileUnused(profile.id, start.projectId), /use/, "SQLite must lease before native launch can yield");
    releaseLaunch();
    const view = await starting;
    let releaseClose!: () => void;
    let enteredClose!: () => void;
    const closingEntered = new Promise<void>(resolve => { enteredClose = resolve; });
    const closingBlocked = new Promise<void>(resolve => { releaseClose = resolve; });
    const close = launches[0].context.close;
    launches[0].context.close = async () => { enteredClose(); await closingBlocked; await close(); };
    const ending = runtime.execute(view.id, { action: "close" }, agent);
    await closingEntered;
    try {
      assert.equal(store.get(view.id).restoreOnRestart, false, "Explicit End clears intent immediately");
      assert.throws(() => store.assertProfileUnused(profile.id, start.projectId), /use/, "SQLite lease must last until Chrome closes");
    } finally { releaseClose(); await ending; }
    store.assertProfileUnused(profile.id, start.projectId);
  } finally { releaseLaunch(); await runtime.close(); store.close(); }
});

test("failed legacy import retains encrypted snapshot for explicit retry", async t => {
  const failures = { import: true };
  mockChrome(t, failures);
  const start = identity();
  const store = new BrowserStore();
  const state = { cookies: [], origins: [] };
  const profile = store.saveProfile(start.projectId, "Legacy failed", state);
  const runtime = new BrowserRuntime({ capability });
  try {
    await assert.rejects(runtime.create({ ...start, profileId: profile.id }), { message: "Browser start failed on this node: Browser profile import failed" });
    assert.equal(store.list(start)[0].error, "Browser profile import failed");
    assert.equal(store.profile(profile.id, start.projectId).persistent, false);
    assert.deepEqual(store.profileState(profile.id, start.projectId), state);
    failures.import = false;
    const view = await runtime.create({ ...start, profileId: profile.id });
    assert.equal(store.profile(profile.id, start.projectId).persistent, true);
    await runtime.execute(view.id, { action: "close" }, agent);
  } finally { await runtime.close(); store.close(); }
});


test("closing the last tab explicitly ends recovery but retains the login profile", async t => {
  const launches = mockChrome(t, { startupPage: true });
  let runtime = new BrowserRuntime({ capability });
  const start = identity();
  try {
    const session = await runtime.create(start);
    await runtime.execute(session.id, { action: "closeTab", pageId: session.activePageId! }, agent);
    assert.equal((await runtime.get(session.id)).state, "closed");
    assert.equal((await runtime.get(session.id)).restoreOnRestart, false);
    await runtime.close(); runtime = new BrowserRuntime({ capability });
    await runtime.ready();
    assert.equal(launches.length, 1, "Last-tab closure must not reopen a browser on restart");
    assert.equal((await runtime.profiles(start.projectId)).length, 1, "Closing tabs must not delete login data");
  } finally { await runtime.close(); }
});

test("unexpected context close preserves recovery intent and safe origins", async t => {
  const launches = mockChrome(t);
  let runtime = new BrowserRuntime({ capability });
  try {
    const first = await runtime.create({ ...identity(), url: "https://example.com/callback?code=fixture" });
    await runtime.execute(first.id, { action: "newTab", url: "https://work.example/inbox" }, agent);
    await runtime.execute(first.id, { action: "selectTab", pageId: first.activePageId! }, agent);
    await launches[0].context.close();
    await runtime.close();
    const store = new BrowserStore();
    try {
      assert.equal(store.get(first.id).restoreOnRestart, true);
      assert.deepEqual(store.recovery(first.id).origins, ["https://example.com", "https://work.example"]);
    } finally { store.close(); }
    runtime = new BrowserRuntime({ capability });
    await runtime.ready();
    const restored = await runtime.get(first.id);
    assert.deepEqual(restored.tabs.map(tab => tab.url), ["https://example.com", "https://work.example"]);
    assert.equal(restored.activePageId, restored.tabs[0].id);
    await runtime.execute(first.id, { action: "close" }, agent);
  } finally { await runtime.close(); }
});

test("persistent startup never passes through zero tabs", async t => {
  const launches = mockChrome(t, { startupPage: true });
  let runtime = new BrowserRuntime({ capability });
  try {
    const first = await runtime.create({ ...identity(), url: "https://example.com/transaction?fixture=1" });
    assert.equal(first.tabs.length, 1);
    await runtime.close();
    runtime = new BrowserRuntime({ capability });
    await runtime.ready();
    assert.deepEqual((await runtime.get(first.id)).tabs.map(tab => tab.url), ["https://example.com"]);
    assert.equal(launches.length, 2);
    await runtime.execute(first.id, { action: "close" }, agent);
  } finally { await runtime.close(); }
});

test("failed recovery can be ended by agent unless paused, or by authenticated human without takeover", async t => {
  let fail = false;
  const launches = mockChrome(t, { launch: () => fail });
  const start = identity();
  let runtime = new BrowserRuntime({ capability });
  try {
    const a = await runtime.create({ ...start, profileName: "Agent" });
    const h = await runtime.create({ ...start, profileName: "Human" });
    await runtime.execute(h.id, { action: "takeControl" }, { kind: "human", id: "old-human" });
    await assert.rejects(runtime.execute(h.id, { action: "close" }, { kind: "human", id: "new-human" }), /another human/);
    await assert.rejects(runtime.execute(h.id, { action: "close" }, agent), /human control/);
    await runtime.close(); fail = true;
    runtime = new BrowserRuntime({ capability });
    await runtime.ready();
    assert.equal((await runtime.get(h.id)).owner, "human", "Inactive recovery must report persisted human ownership");
    await assert.rejects(runtime.execute(h.id, { action: "close" }, agent), /human control/);
    await assert.rejects(runtime.execute(h.id, { action: "close" }, { kind: "human", id: "" }), /human|authenticated/i);
    await runtime.execute(a.id, { action: "close" }, agent);
    await runtime.execute(h.id, { action: "close" }, { kind: "human", id: "new-human" });
    for (const view of [a, h]) {
      assert.equal((await runtime.get(view.id)).restoreOnRestart, false);
      assert.equal((await runtime.get(view.id)).state, "closed");
      await runtime.deleteProfile(view.profileId!, start.projectId);
    }
    assert.equal(launches.length, 2);
  } finally { await runtime.close(); }
});

test("corrupt persisted recovery never reaches native navigation and human can discard it", async t => {
  const launches = mockChrome(t);
  let runtime = new BrowserRuntime({ capability });
  try {
    const first = await runtime.create(identity());
    await runtime.close();
    const db = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
    try {
      db.prepare("UPDATE browser_sessions SET recovery = ? WHERE id = ?").run(JSON.stringify({ origins: ["https://example.com/callback?code=sensitive-fixture"], activeIndex: 0, human: "quarantined-owner" }), first.id);
    } finally { db.close(); }
    runtime = new BrowserRuntime({ capability });
    const restored = await runtime.get(first.id);
    assert.equal(restored.state, "interrupted");
    assert.equal(restored.error, "Browser restore failed: Invalid browser recovery state");
    assert.equal(restored.owner, "human", "Invalid tab URLs must not conceal persisted human control");
    assert.equal(launches.length, 1, "Invalid recovery must be rejected before launching or navigating");
    await runtime.execute(first.id, { action: "close" }, { kind: "human", id: "authenticated" });
    await runtime.deleteProfile(first.profileId!, first.projectId);
  } finally { await runtime.close(); }
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function settles<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} blocked behind recovery`)), 300);
    })]);
  } finally { clearTimeout(timer!); }
}

for (const action of ["metadata", "end", "shutdown"] as const) {
  test(`stalled recovery does not block ${action}`, async t => {
    const launches = mockChrome(t);
    const start = identity();
    const store = new BrowserStore();
    let runtime = new BrowserRuntime({ capability });
    const navigation = gate();
    const entered = gate();
    const nativeClose = gate();
    const closeEntered = gate();
    const healthyReady = gate();
    let ready: Promise<void> | undefined;
    try {
      const slow = await runtime.create({ ...start, profileName: "Slow", url: "https://slow.example" });
      const healthy = await runtime.create({ ...start, profileName: "Healthy" });
      await runtime.execute(slow.id, { action: "takeControl" }, { kind: "human", id: "controller" });
      await runtime.close();
      const launch = chromium.launchPersistentContext;
      t.mock.method(chromium, "launchPersistentContext", async (...args: Parameters<typeof launch>) => {
        const context = await launch(...args);
        if (path.basename(args[0]) === slow.profileId) {
          const newPage = context.newPage.bind(context);
          context.newPage = async () => {
            const page = await newPage();
            page.goto = async () => { entered.resolve(); await navigation.promise; return null; };
            return page;
          };
          const close = context.close.bind(context);
          context.close = async () => { closeEntered.resolve(); await nativeClose.promise; await close(); };
        } else {
          const newPage = context.newPage.bind(context);
          context.newPage = async () => {
            const page = await newPage();
            page.title = async () => { healthyReady.resolve(); return page.url(); };
            return page;
          };
        }
        return context;
      });
      runtime = new BrowserRuntime({ capability });
      ready = runtime.ready();
      await entered.promise;
      if (action === "metadata") {
        await settles(healthyReady.promise, "healthy restoration");
        assert.equal((await settles(runtime.get(slow.id), "get")).owner, "human");
        await assert.rejects(runtime.execute(slow.id, { action: "newTab" }, { kind: "human", id: "controller" }), /still restoring/, "Page mutations must not race the same profile's restoration");
        assert.equal((await settles(runtime.list(start), "list")).length, 2);
        assert.equal((await settles(runtime.profiles(start.projectId), "profiles")).length, 2);
        assert.equal((await settles(runtime.create({ ...start, profileId: healthy.profileId }), "healthy start")).id, healthy.id);
        await settles(runtime.execute(healthy.id, { action: "saveProfile", label: "Still usable" }, agent), "healthy command");
        const page = launches.findLast(item => path.basename(item.directory) === healthy.profileId)!.context.pages()[0];
        let accepted = 0;
        const dialog = () => ({ type: () => "confirm", message: () => "fixture", defaultValue: () => "", accept: async () => { accepted++; } });
        page.emit("dialog", dialog());
        const response = runtime.execute(healthy.id, { action: "dialog", accept: true }, agent);
        page.emit("dialog", dialog());
        await settles(response, "dialog admission");
        assert.equal(accepted, 1);
        assert.notEqual((await runtime.get(healthy.id)).dialog, null);
        const messages: any[] = [];
        const viewer = Object.assign(new EventEmitter(), { readyState: 1, bufferedAmount: 0, send: (value: string) => messages.push(JSON.parse(value)), close: () => {} });
        await settles(runtime.attachViewer(healthy.id, viewer as unknown as WebSocket, agent), "viewer attachment");
        assert.equal(messages.find(item => item.type === "browserState").session.id, healthy.id);
        const downloadId = randomUUID();
        const directory = path.join(resolveDataDirectory(), "browser", healthy.id, "downloads");
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, downloadId), "download fixture");
        store.saveDownload(healthy.id, { id: downloadId, name: "fixture.txt", ready: true });
        assert.deepEqual(await settles(runtime.download(healthy.id, downloadId), "download"), { path: path.join(directory, downloadId), name: "fixture.txt" });
      } else if (action === "end") {
        await assert.rejects(settles(runtime.execute(slow.id, { action: "close" }, agent), "agent End"), /human control/);
        const ending = runtime.execute(slow.id, { action: "close" }, { kind: "human", id: "controller" });
        await settles(closeEntered.promise, "native close");
        assert.equal(store.get(slow.id).restoreOnRestart, false);
        assert.throws(() => store.assertProfileUnused(slow.profileId!, start.projectId), /use/);
        nativeClose.resolve();
        await settles(ending, "End");
        await settles(ready, "cancelled restoration");
        navigation.resolve();
        assert.equal(store.get(slow.id).state, "closed");
        assert.equal(store.get(slow.id).restoreOnRestart, false);
      } else {
        const closing = runtime.close();
        await settles(closeEntered.promise, "shutdown native close");
        nativeClose.resolve();
        await settles(closing, "shutdown");
        assert.equal(store.get(slow.id).restoreOnRestart, true);
      }
    } finally {
      navigation.resolve(); nativeClose.resolve();
      await ready; await runtime.close(); store.close();
    }
    assert.ok(launches.length >= 3);
  });
}

test("a failed profile can retry while another profile is still restoring", async t => {
  let failLaunch = true;
  const start = identity();
  const launches = mockChrome(t, { launch: directory => failLaunch && path.basename(directory) === failing.id });
  const store = new BrowserStore();
  const failing = store.createProfile(start.projectId, "Retry");
  const slow = store.createProfile(start.projectId, "Slow");
  const failedRow = store.create({ ...start, profileId: failing.id });
  store.create({ ...start, profileId: slow.id, url: "https://slow.example" });
  const entered = gate(), release = gate();
  const launch = chromium.launchPersistentContext;
  t.mock.method(chromium, "launchPersistentContext", async (...args: Parameters<typeof launch>) => {
    const context = await launch(...args);
    if (path.basename(args[0]) === slow.id) {
      const newPage = context.newPage.bind(context);
      context.newPage = async () => {
        const page = await newPage();
        page.goto = async () => { entered.resolve(); await release.promise; return null; };
        return page;
      };
    }
    return context;
  });
  const runtime = new BrowserRuntime({ capability });
  const ready = runtime.ready();
  try {
    await entered.promise;
    await settles((async () => { while (!store.get(failedRow.id).error?.startsWith("Browser restore failed")) await new Promise(resolve => setImmediate(resolve)); })(), "failed restoration");
    failLaunch = false;
    const retry = await settles(runtime.create({ ...start, profileId: failing.id }), "explicit retry");
    assert.equal(retry.state, "running", "A completed failure must not remain pending behind another account");
    assert.equal(launches.length, 2);
  } finally { release.resolve(); await ready; await runtime.close(); store.close(); }
});

test("maximum remote human ID survives checkpoints, restart and shutdown", async t => {
  const launches = mockChrome(t);
  let runtime = new BrowserRuntime({ capability });
  const human = { kind: "human" as const, id: "h".repeat(500) };
  const store = new BrowserStore();
  try {
    const session = await runtime.create(identity());
    await runtime.execute(session.id, { action: "takeControl" }, human);
    launches[0].context.pages()[0].emit("domcontentloaded");
    assert.equal(store.recovery(session.id).human, human.id);
    await runtime.close();
    runtime = new BrowserRuntime({ capability });
    await runtime.ready();
    assert.equal((await runtime.get(session.id)).owner, "human");
    await assert.rejects(runtime.execute(session.id, { action: "close" }, agent), /human control/);
    await runtime.close();
    assert.equal(store.recovery(session.id).human, human.id);
  } finally { await runtime.close(); store.close(); }
});

for (const phase of ["capability", "native launch"] as const) {
  test(`End cancels recovery during ${phase} without resurrection`, async t => {
    const launches = mockChrome(t);
    const store = new BrowserStore();
    const start = identity();
    const profile = store.createProfile(start.projectId, "Pending");
    const row = store.create({ ...start, profileId: profile.id });
    store.checkpoint(row.id, { origins: ["https://example.com"], activeIndex: 0, human: "owner" });
    const entered = gate();
    const release = gate();
    const closeEntered = gate();
    const releaseClose = gate();
    const launch = chromium.launchPersistentContext;
    if (phase === "native launch") t.mock.method(chromium, "launchPersistentContext", async (...args: Parameters<typeof launch>) => {
      const context = await launch(...args);
      const close = context.close.bind(context);
      context.close = async () => { closeEntered.resolve(); await releaseClose.promise; await close(); };
      entered.resolve(); await release.promise;
      return context;
    });
    const runtime = new BrowserRuntime({ capability: async () => {
      if (phase === "capability") { entered.resolve(); await release.promise; }
      return capability();
    } });
    const ready = runtime.ready();
    try {
      await entered.promise;
      assert.equal((await settles(runtime.get(row.id), "pending metadata")).owner, "human");
      await assert.rejects(settles(runtime.execute(row.id, { action: "close" }, agent), "pending agent End"), /human control/);
      const ending = runtime.execute(row.id, { action: "close" }, { kind: "human", id: "authenticated" });
      assert.equal(store.get(row.id).restoreOnRestart, false, "End must clear intent before launch finishes");
      assert.throws(() => store.assertProfileUnused(profile.id, start.projectId), /use/);
      release.resolve();
      if (phase === "native launch") {
        await settles(closeEntered.promise, "pending native close");
        assert.throws(() => store.assertProfileUnused(profile.id, start.projectId), /use/);
      }
      releaseClose.resolve();
      await ending; await ready;
      assert.equal(store.get(row.id).state, "closed");
      store.assertProfileUnused(profile.id, start.projectId);
      assert.equal(launches.length, phase === "capability" ? 0 : 1);
    } finally { release.resolve(); releaseClose.resolve(); await ready; await runtime.close(); store.close(); }
  });
}

test("oversized human actor is rejected before changing live ownership", async t => {
  mockChrome(t);
  const runtime = new BrowserRuntime({ capability });
  try {
    const row = await runtime.create(identity());
    await assert.rejects(runtime.execute(row.id, { action: "takeControl" }, { kind: "human", id: "h".repeat(501) }), /human|actor/i);
    assert.equal((await runtime.get(row.id)).owner, "agent");
    await runtime.execute(row.id, { action: "close" }, agent);
  } finally { await runtime.close(); }
});

test("shutdown closes a legacy context whose import finishes after shutdown starts", async t => {
  mockChrome(t);
  const store = new BrowserStore();
  const start = identity();
  const profile = store.saveProfile(start.projectId, "Legacy shutdown", { cookies: [], origins: [] });
  const entered = gate(), release = gate();
  let closed = false;
  const launch = chromium.launchPersistentContext;
  t.mock.method(chromium, "launchPersistentContext", async (...args: Parameters<typeof launch>) => {
    const context = await launch(...args);
    context.setStorageState = async () => { entered.resolve(); await release.promise; };
    context.close = async () => { closed = true; };
    return context;
  });
  const runtime = new BrowserRuntime({ capability });
  const creating = runtime.create({ ...start, profileId: profile.id }).then(value => ({ value }), error => ({ error }));
  try {
    await entered.promise;
    const closing = runtime.close();
    release.resolve();
    await creating; await closing;
    assert.equal(closed, true, "Late import context must close during shutdown");
    assert.equal(store.profile(profile.id, start.projectId).persistent, false, "Cancelled migration must retain its legacy snapshot");
    store.assertProfileUnused(profile.id, start.projectId);
  } finally { release.resolve(); await creating; await runtime.close(); store.close(); }
});

test("control changes during recovery survive shutdown without replacing saved origins", async t => {
  mockChrome(t);
  const store = new BrowserStore();
  const start = identity();
  const profile = store.createProfile(start.projectId, "Restoring control");
  const row = store.create({ ...start, profileId: profile.id, url: "https://example.com" });
  const entered = gate();
  const release = gate();
  const launch = chromium.launchPersistentContext;
  t.mock.method(chromium, "launchPersistentContext", async (...args: Parameters<typeof launch>) => {
    const context = await launch(...args);
    const newPage = context.newPage.bind(context);
    context.newPage = async () => {
      const page = await newPage();
      page.goto = async () => { entered.resolve(); await release.promise; return null; };
      return page;
    };
    return context;
  });
  const runtime = new BrowserRuntime({ capability });
  const ready = runtime.ready();
  try {
    await entered.promise;
    await settles(runtime.execute(row.id, { action: "takeControl" }, { kind: "human", id: "h".repeat(500) }), "recovery takeover");
    await settles(runtime.close(), "shutdown after takeover");
    assert.deepEqual(store.recovery(row.id), { origins: ["https://example.com"], activeIndex: 0, human: "h".repeat(500) });
  } finally { release.resolve(); await ready; await runtime.close(); store.close(); }
});
