import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { before, after } from "node:test";
import type { ChildProcess } from "node:child_process";
import type { Browser, Page, Route } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment } from "../dev-nodes.js";
import { waitInPage } from "./wait-in-page.js";

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
  await waitInPage(page, async () => {
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

test("cross-project refreshes serialize overlapping scans and keep one trailing refresh", { timeout: 60_000 }, async () => {
  const page = await openPage();
  try {
    const results = await page.evaluate(async () => {
      const runningModule = "/app/running.js", reviewsModule = "/app/reviews.js";
      const { refreshRunningConversations } = await import(runningModule);
      const { refreshPendingReviews } = await import(reviewsModule);
      const results = [];
      for (const [endpoint, refresh] of [["/api/running", refreshRunningConversations], ["/api/reviews/pending", refreshPendingReviews]] as const) {
        await refresh();
        const originalFetch = window.fetch;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        let requests = 0, active = 0, peak = 0, fail = false;
        window.fetch = async (input, options) => {
          if (input !== endpoint) return originalFetch(input, options);
          const ordinal = ++requests;
          peak = Math.max(peak, ++active);
          try {
            if (ordinal === 1) await gate;
            return Response.json(fail ? { error: "temporary failure" } : { projects: [] }, { status: fail ? 503 : 200 });
          } finally { active--; }
        };
        try {
          const first = refresh();
          const overlapping = Array.from({ length: 5 }, () => refresh());
          const whileHeld = { requests, peak };
          release();
          await Promise.all([first, ...overlapping]);
          const afterBurst = requests;
          fail = true;
          const failureReported = await refresh().then(() => false, () => true);
          fail = false;
          await refresh();
          results.push({ endpoint, whileHeld, afterBurst, peak, failureReported, afterRecovery: requests });
        } finally { release(); window.fetch = originalFetch; }
      }
      return results;
    });
    for (const result of results) {
      assert.equal(result.whileHeld.requests, 1, `${result.endpoint} must not start overlapping full-project scans`);
      assert.equal(result.afterBurst, 2, `${result.endpoint} keeps exactly one trailing refresh for in-flight invalidations`);
      assert.equal(result.peak, 1, `${result.endpoint} never has two scans in flight`);
      assert.equal(result.failureReported, true, `${result.endpoint} reports failed requests`);
      assert.equal(result.afterRecovery, 4, `${result.endpoint} releases its in-flight guard after failure`);
    }
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

test("mark-all clears the inbox at once and keeps working after the dialog closes", { timeout: 60_000 }, async () => {
  const page = await openPage();
  try {
    const projects = await page.evaluate(async () => {
      const module = "/app/state.js";
      const { state } = await import(module);
      const session = state.sessions[0];
      session.reviewState = "needs_review";
      state.pendingReviews = [{ projectId: state.activeProjectId, projectName: "Internal Assistant", sessions: [{ ...session }] }];
      return state.pendingReviews;
    });
    const held = deferred<Route>();
    let pendingReads = 0;
    await page.route("**/api/projects/*/sessions/reviewed-all", (route) => held.resolve(route));
    await page.route("**/api/reviews/pending", (route) => route.fulfill({ json: { projects: ++pendingReads === 1 ? projects : [] } }));
    await page.evaluate(async () => { const module = "/app/reviews.js"; (await import(module)).openPendingReviews(); });
    await page.getByTestId("pending-review-option").first().waitFor();
    const button = page.getByTestId("pending-reviews-mark-all-button");
    await button.click();
    const request = await held.promise;
    assert.equal(await button.getAttribute("aria-busy"), "true", "the button shows the operation is running");
    assert.equal(await button.isDisabled(), true, "a second click cannot start another run");
    assert.equal(await page.getByTestId("pending-review-option").count(), 0, "the inbox empties before the server answers");
    assert.equal(await page.locator("#pendingReviewsBadge").isHidden(), true, "the badge clears before the server answers");
    await page.locator("#closePendingReviewsButton").click();
    await request.fulfill({ status: 204 });
    await page.getByText("All conversations marked as read", { exact: true }).waitFor();
    assert.equal(await button.getAttribute("aria-busy"), null, "the busy state ends with the run");
  } finally { await page.context().close(); }
});

test("a pending-review scan still lands when more refreshes are asked for while it runs", { timeout: 60_000 }, async () => {
  const page = await openPage();
  try {
    await page.evaluate(async () => { const module = "/app/reviews.js"; await (await import(module)).refreshPendingReviews(); });
    const first = deferred<Route>(), second = deferred<Route>();
    let reads = 0;
    await page.route("**/api/reviews/pending", (route) => {
      if (++reads === 1) first.resolve(route);
      else if (reads === 2) second.resolve(route);
      else void route.fulfill({ json: { projects: [] } });
    });
    await page.evaluate(async () => { const module = "/app/reviews.js"; void (await import(module)).refreshPendingReviews(); });
    const slow = await first.promise;
    // Another project's running conversation asks for a refresh every few seconds, faster than
    // the scan answers. Discarding the scan for each request froze the counts for good.
    await page.evaluate(async () => { const module = "/app/reviews.js"; void (await import(module)).refreshPendingReviews(); });
    await slow.fulfill({ json: { projects: [{ projectId: "scanned-project", projectName: "Scanned", sessions: [{ id: "scanned", path: "scanned.jsonl" }] }] } });
    const trailing = await second.promise;
    assert.equal(await page.evaluate(async () => { const module = "/app/state.js"; return (await import(module)).state.pendingReviews.some((group: { projectId: string }) => group.projectId === "scanned-project"); }), true, "the scan's result is applied while the trailing scan runs");
    await trailing.fulfill({ json: { projects: [] } });
    await waitInPage(page, async () => { const module = "/app/state.js"; return (await import(module)).state.pendingReviews.length === 0; });
  } finally { await page.context().close(); }
});

test("opening a conversation clears it from the inbox and a scan begun before the mark cannot bring it back", { timeout: 60_000 }, async () => {
  const page = await openPage();
  try {
    await page.evaluate(async () => { const module = "/app/reviews.js"; await (await import(module)).refreshPendingReviews(); });
    const fixture = await page.evaluate(async () => {
      const module = "/app/state.js";
      const { state } = await import(module);
      const session = state.sessions[0];
      session.reviewState = "needs_review";
      session.running = false;
      const groups = [{ projectId: state.activeProjectId, projectName: "Internal Assistant", sessions: [{ id: session.id, path: session.path, title: session.title, updatedAt: session.updatedAt }] }];
      state.pendingReviews = groups;
      return { path: session.path, groups };
    });
    const scan = deferred<Route>(), mark = deferred<Route>(), afterMark = deferred<Route>();
    let reads = 0;
    await page.route("**/api/reviews/pending", (route) => {
      if (++reads === 1) scan.resolve(route);
      else if (reads === 2) afterMark.resolve(route);
      else void route.fulfill({ json: { projects: [] } });
    });
    await page.route("**/api/projects/*/sessions/reviewed", (route) => mark.resolve(route));
    await page.evaluate(async () => { const module = "/app/reviews.js"; void (await import(module)).refreshPendingReviews(); });
    const staleScan = await scan.promise;
    await page.locator(`#sessionList [data-session-path=${JSON.stringify(fixture.path)}] .session-card`).click();
    const markRequest = await mark.promise;
    const listed = () => page.evaluate(async (sessionPath) => {
      const module = "/app/state.js";
      return (await import(module)).state.pendingReviews.some((group: { sessions: Array<{ path: string }> }) => group.sessions.some((entry) => entry.path === sessionPath));
    }, fixture.path);
    assert.equal(await listed(), false, "the inbox drops the conversation as soon as it opens");
    await staleScan.fulfill({ json: { projects: fixture.groups } });
    await markRequest.fulfill({ status: 204 });
    const freshScan = await afterMark.promise;
    assert.equal(await listed(), false, "a scan begun before the mark must not bring the conversation back");
    await freshScan.fulfill({ json: { projects: [] } });
    await page.waitForFunction(() => document.querySelector("#pendingReviewsBadge")!.hasAttribute("hidden"));
  } finally { await page.context().close(); }
});

test("the review badges, the menu count and the inbox dialog list the same conversations", { timeout: 60_000 }, async () => {
  const page = await openPage();
  try {
    const fixture = await page.evaluate(async () => {
      const module = "/app/state.js";
      const { state } = await import(module);
      const session = state.sessions[0];
      session.reviewState = "needs_review";
      session.running = false;
      return {
        sessions: state.sessions,
        title: session.title,
        // The snapshot is behind the open project's live list: it still holds a conversation that
        // was reviewed since, and not yet the one that now waits.
        projects: [
          { projectId: state.activeProjectId, projectName: "Internal Assistant", sessions: [{ id: "reviewed-since", path: "reviewed-since.jsonl", title: "Reviewed since the scan", agentId: "pi", agentLabel: "Pi", updatedAt: session.updatedAt }] },
          { projectId: "other-project", projectName: "Other project", sessions: [{ id: "other", path: "other.jsonl", title: "Waiting elsewhere", agentId: "pi", agentLabel: "Pi", updatedAt: session.updatedAt }] },
        ],
      };
    });
    await page.route("**/api/projects/*/sessions", (route) => route.fulfill({ json: { sessions: fixture.sessions } }));
    await page.route("**/api/reviews/pending", (route) => route.fulfill({ json: { projects: fixture.projects } }));
    await page.evaluate(async () => { const module = "/app/reviews.js"; await (await import(module)).refreshPendingReviews(); });
    const surfaces = () => page.evaluate(() => ({
      badge: document.querySelector("#pendingReviewsBadge")!.textContent,
      nav: document.querySelector("#navPendingReviewsBadge")!.textContent,
      fab: document.querySelector("#focusPendingBadge")!.textContent,
      menu: document.querySelector("#focusReviewCount")!.textContent,
      rows: [...document.querySelectorAll("[data-testid=pending-review-option]")].map((row) => (row as HTMLElement).title),
    }));
    await page.evaluate(async () => { const module = "/app/reviews.js"; (await import(module)).openPendingReviews(); });
    await page.getByTestId("pending-review-option").first().waitFor();
    assert.deepEqual(await surfaces(), { badge: "2", nav: "2", fab: "2", menu: "2", rows: [fixture.title, "Waiting elsewhere"] });
    // A list refresh that clears the open project's conversation updates every surface, the open dialog too.
    fixture.sessions[0].reviewState = "reviewed";
    await page.evaluate(async () => { const module = "/app/socket.js"; await (await import(module)).refreshSessionsQuietly(); });
    assert.deepEqual(await surfaces(), { badge: "1", nav: "1", fab: "1", menu: "1", rows: ["Waiting elsewhere"] });
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
