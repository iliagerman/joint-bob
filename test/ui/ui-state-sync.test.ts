import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { Browser, Page, Route } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment } from "../dev-nodes.js";

let root: string;
let environment: DevEnvironment;
let server: ChildProcess;
let browser: Browser;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-state-sync-"));
  environment = await seedDevEnvironment(root, 1);
  server = await startDevNode(environment, environment.nodes[0]);
  browser = await launchChrome({ headless: true });
}, { timeout: 120_000 });
after(async () => {
  await browser?.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

async function openPage(): Promise<Page> {
  const page = await browser.newPage({ serviceWorkers: "block", viewport: { width: 1440, height: 900 } });
  const node = environment.nodes[0];
  const session = await signIn(environment, node);
  await page.context().addCookies(session.cookie.split("; ").map((cookie) => {
    const split = cookie.indexOf("=");
    return { name: cookie.slice(0, split), value: cookie.slice(split + 1), url: node.url };
  }));
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#projectList").getByText("Internal Assistant", { exact: true }).click();
  await page.locator("#sessionList .session-card").first().waitFor();
  await page.waitForFunction(async () => {
    const module = "/app/state.js";
    const { state } = await import(module);
    return !state.sessionsRefreshing && !state.sessionsLoading;
  });
  return page;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("an invalidation during a list fetch gets a trailing authoritative refresh", { timeout: 60_000 }, async () => {
  const page = await openPage();
  try {
    const held = deferred<Route>();
    let reads = 0;
    await page.route("**/api/projects/*/sessions", async (route) => {
      if (++reads === 1) { held.resolve(route); return; }
      const response = await route.fetch();
      const body = await response.json();
      body.sessions[0].title = "Fresh state after invalidation";
      await route.fulfill({ response, json: body });
    });
    await page.evaluate(async () => {
      const module = "/app/socket.js";
      const socket = await import(module);
      void socket.refreshSessionsQuietly();
    });
    const route = await held.promise;
    await page.evaluate(async () => {
      const module = "/app/socket.js";
      const socket = await import(module);
      void socket.refreshSessionsQuietly();
    });
    await route.continue();
    await page.getByText("Fresh state after invalidation", { exact: true }).waitFor({ timeout: 5000 });
    assert.ok(reads >= 2, "in-flight invalidation must not be discarded");
  } finally { await page.context().close(); }
});

test("a stale pins read cannot erase a pending pin click", { timeout: 60_000 }, async () => {
  const page = await openPage();
  try {
    const read = deferred<Route>();
    const write = deferred<Route>();
    await page.route("**/api/pins", (route) => {
      if (route.request().method() === "GET") read.resolve(route);
      else write.resolve(route);
    });
    await page.evaluate(async () => {
      const module = "/app/api.js";
      void (await import(module)).loadPins();
    });
    const oldRead = await read.promise;
    const row = page.locator("#sessionList .list-row").first();
    const sessionPath = await row.getAttribute("data-session-path");
    await row.getByTestId("session-pin-button").click();
    const mutation = await write.promise;
    await oldRead.fulfill({ json: { projectIds: [], conversations: [] } });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    // Find by the stable path rather than position, since pinning reorders the list.
    assert.equal(await page.locator(`[data-session-path=${JSON.stringify(sessionPath)}]`).first().evaluate((element) => element.classList.contains("pinned")), true, "pending intent survives an older server snapshot");
    await mutation.fulfill({ json: { projectIds: [], conversations: [mutation.request().postDataJSON()] } });
    await page.unroute("**/api/pins");
  } finally { await page.context().close(); }
});

test("rapid pin then unpin reaches the server in click order", { timeout: 60_000 }, async () => {
  const page = await openPage();
  try {
    const pinned = await page.evaluate(async () => {
      const stateModule = "/app/state.js", rowsModule = "/app/session-rows.js", apiModule = "/app/api.js";
      const { state } = await import(stateModule);
      const { togglePinnedSession } = await import(rowsModule);
      const { loadPins } = await import(apiModule);
      const originalFetch = window.fetch;
      let release!: () => void, firstStarted!: () => void, bothStarted!: () => void;
      const first = new Promise<void>((resolve) => { firstStarted = resolve; });
      const both = new Promise<void>((resolve) => { bothStarted = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let writes = 0;
      let pins: unknown[] = [];
      window.fetch = async (input, options) => {
        if (input !== "/api/pins") return originalFetch(input, options);
        if (options?.method === "PUT") {
          const change = JSON.parse(String(options.body));
          if (++writes === 1) { firstStarted(); await gate; }
          pins = change.pinned ? [change] : [];
          if (writes === 2) bothStarted();
        }
        return new Response(JSON.stringify({ projectIds: [], conversations: pins }), { headers: { "Content-Type": "application/json" } });
      };
      try {
        await loadPins();
        const session = state.sessions[0];
        togglePinnedSession(session);
        await first;
        togglePinnedSession(session);
        release();
        await both;
        await loadPins();
        return pins.length > 0;
      } finally { window.fetch = originalFetch; }
    });
    assert.equal(pinned, false, "delayed pin must not commit after a newer unpin");
  } finally { await page.context().close(); }
});

test("queued pin writes cannot cross a sign-in boundary", { timeout: 60_000 }, async () => {
  const page = await openPage();
  try {
    const result = await page.evaluate(async () => {
      const stateModule = "/app/state.js", apiModule = "/app/api.js";
      const { state } = await import(stateModule);
      const { savePin, loadPins } = await import(apiModule);
      const originalFetch = window.fetch, originalToken = state.csrfToken;
      let release!: () => void, started!: () => void;
      const first = new Promise<void>((resolve) => { started = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let writes = 0;
      window.fetch = async (input, options) => {
        if (input !== "/api/pins") return originalFetch(input, options);
        if (options?.method === "PUT") {
          if (++writes === 1) { started(); await gate; }
          return new Response(JSON.stringify({ projectIds: ["old-account-pin"], conversations: [] }));
        }
        return new Response(JSON.stringify({ projectIds: [], conversations: [] }));
      };
      try {
        const firstWrite = savePin({ kind: "project", projectId: "old-account-pin" }, true);
        const secondWrite = savePin({ kind: "project", projectId: "queued-old-account-pin" }, true);
        const settled = Promise.allSettled([firstWrite, secondWrite]);
        await first;
        state.csrfToken = "synthetic-next-login";
        await loadPins();
        release();
        const results = await settled;
        return { writes, queuedStatus: results[1].status, pins: state.replicatedPinnedProjectIds };
      } finally { state.csrfToken = originalToken; window.fetch = originalFetch; }
    });
    assert.deepEqual(result, { writes: 1, queuedStatus: "rejected", pins: [] }, "old account mutations and responses must not affect the new account");
  } finally { await page.context().close(); }
});

test("a rejected pin write restores the server's state", { timeout: 60_000 }, async () => {
  const page = await openPage();
  try {
    await page.route("**/api/pins", (route) => route.request().method() === "PUT"
      ? route.fulfill({ status: 503, json: { error: "Pin fixture rejected" } })
      : route.fulfill({ json: { projectIds: [], conversations: [] } }));
    await page.evaluate(async () => { const module = "/app/api.js"; await (await import(module)).loadPins(); });
    const row = page.locator("#sessionList .list-row").first();
    const sessionPath = await row.getAttribute("data-session-path");
    await row.getByTestId("session-pin-button").click();
    await page.getByText("Pin fixture rejected", { exact: true }).waitFor();
    await page.waitForFunction((sessionPath) => !document.querySelector(`[data-session-path=${JSON.stringify(sessionPath)}]`)?.classList.contains("pinned"), sessionPath, { timeout: 5000 });
  } finally { await page.context().close(); }
});

test("mark-all does not mark activity newer than the submitted inbox snapshot read", { timeout: 60_000 }, async () => {
  const page = await openPage();
  try {
    const fixture = await page.evaluate(async () => {
      const module = "/app/state.js", reviewModule = "/app/reviews.js";
      const { state } = await import(module);
      const session = state.sessions[0];
      session.reviewState = "needs_review";
      const entry = { ...session, updatedAt: new Date(Date.parse(session.updatedAt) - 1000).toISOString() };
      state.pendingReviews = [{ projectId: state.activeProjectId, projectName: "Internal Assistant", sessions: [entry] }];
      return { sessions: state.sessions, projects: state.pendingReviews, path: session.path };
    });
    await page.route("**/api/projects/*/sessions/reviewed-all", (route) => route.fulfill({ status: 204 }));
    await page.route("**/api/projects/*/sessions", (route) => route.fulfill({ json: { sessions: fixture.sessions } }));
    await page.route("**/api/reviews/pending", (route) => route.fulfill({ json: { projects: fixture.projects } }));
    await page.evaluate(async () => { const module = "/app/reviews.js"; (await import(module)).openPendingReviews(); });
    await page.getByTestId("pending-reviews-mark-all-button").click();
    await page.getByText("All conversations marked as read", { exact: true }).waitFor();
    const reviewState = await page.evaluate(async (sessionPath) => {
      const module = "/app/state.js";
      return (await import(module)).state.sessions.find((session: { path: string }) => session.path === sessionPath).reviewState;
    }, fixture.path);
    assert.equal(reviewState, "needs_review", "mark-all only covers the submitted watermark, not newer activity");
  } finally { await page.context().close(); }
});

test("an older pending-review response cannot overwrite a newer inbox", { timeout: 60_000 }, async () => {
  const page = await openPage();
  try {
    const first = deferred<Route>();
    let reads = 0;
    await page.route("**/api/reviews/pending", (route) => {
      if (++reads === 1) first.resolve(route);
      else void route.fulfill({ json: { projects: [] } });
    });
    await page.evaluate(async () => { const module = "/app/reviews.js"; void (await import(module)).refreshPendingReviews(); });
    const old = await first.promise;
    await page.evaluate(async () => { const module = "/app/reviews.js"; await (await import(module)).refreshPendingReviews(); });
    await old.fulfill({ json: { projects: [{ projectId: "stale-project", projectName: "Old snapshot", sessions: [{ id: "old" }] }] } });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    assert.equal(await page.evaluate(async () => { const module = "/app/state.js"; return (await import(module)).state.pendingReviews.length; }), 0, "older inbox must not restore already-reviewed entries");
  } finally { await page.context().close(); }
});

test("opening a replacement watch socket recovers pins missed while disconnected", { timeout: 60_000 }, async () => {
  const page = await openPage();
  try {
    const target = await page.evaluate(async () => {
      const stateModule = "/app/state.js", socketModule = "/app/socket.js";
      const { state } = await import(stateModule);
      (await import(socketModule)).closeWatchSocket();
      return { projectId: state.activeProjectId, engine: state.sessions[0].harnessId, sessionId: state.sessions[0].id, path: state.sessions[0].path };
    });
    await page.route("**/api/pins", (route) => route.fulfill({ json: { projectIds: [], conversations: [target] } }));
    await page.evaluate(async () => { const module = "/app/socket.js"; (await import(module)).ensureWatchSocket(); });
    await page.waitForFunction((sessionPath) => document.querySelector(`[data-session-path=${JSON.stringify(sessionPath)}]`)?.classList.contains("pinned"), target.path, { timeout: 5000 });
  } finally { await page.context().close(); }
});
