import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser, type WebSocketRoute } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { projectNamed, seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("the open conversation's auto badge follows live state even when the list snapshot is stale", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-auto-sync-"));
  let browser: Browser | undefined;
  let server: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const project = projectNamed(node, "Internal Assistant");
    server = await startDevNode(environment, node);
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // Model a stale list snapshot on the browsing node and live state from the
    // execution node. No model is called: only auto-respond wire data is replaced.
    let listedStatus = "stopped";
    let liveState = { projectId: project.id, conversationId: "thread-based-agent-builder", status: "active", responses: 0, maxResponses: 10, stopReason: null as string | null };
    let liveSocket: WebSocketRoute | undefined;
    await page.route(`**/api/projects/${project.id}/sessions`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      for (const session of body.sessions) {
        session.autoRespond = { status: listedStatus, responses: 7, maxResponses: 10, stopReason: "Old stop reason" };
      }
      await route.fulfill({ response, json: body });
    });
    await page.routeWebSocket(/\/ws\?/, (socket) => {
      const upstream = socket.connectToServer();
      const query = new URL(socket.url()).searchParams;
      if (!query.get("sessionPath")?.includes("thread-based-agent-builder")) return;
      liveSocket = socket;
      upstream.onMessage((message) => {
        const payload = JSON.parse(String(message));
        if (payload.type === "ready") payload.autoRespond = liveState;
        socket.send(JSON.stringify(payload));
      });
    });
    const refresh = () => page.evaluate(async () => {
      const { refreshSessionsQuietly } = await import("/app/socket.js");
      await refreshSessionsQuietly();
    });
    const publish = async (status: string, responses: number, stopReason: string | null = null) => {
      liveState = { ...liveState, status, responses, stopReason };
      assert.ok(liveSocket, "the fixture has a connected conversation socket");
      liveSocket.send(JSON.stringify({ type: "autoRespond", state: liveState, phase: "idle", message: stopReason || status }));
      await page.waitForFunction((status) => {
        const pill = document.querySelector<HTMLElement>('[data-testid="auto-respond-pill"]');
        return status === "off" ? pill?.hidden : !pill?.hidden && pill?.dataset.state === status;
      }, status);
    };
    await page.goto(node.url, { waitUntil: "domcontentloaded" });
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
    const row = page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first();
    const badge = row.getByTestId("session-auto-respond-badge");
    const otherBadge = page.locator(".session-card", { hasText: "Mobile Multi-Agent Threads" }).first().getByTestId("session-auto-respond-badge");
    assert.equal(await badge.textContent(), "Auto stopped", "the fixture starts with the stale list badge");
    await row.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="auto-respond-pill"]')?.textContent === "Auto 0/10");
    assert.equal(await badge.textContent(), "Auto 0/10", "ready replaces the stale stopped badge with the live state");
    assert.equal(await otherBadge.textContent(), "Auto stopped", "another conversation keeps its own state");

    await refresh();
    assert.equal(await badge.textContent(), "Auto 0/10", "a stale refresh cannot restore Auto stopped");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.querySelector('[data-testid="auto-respond-pill"]')?.textContent === "Auto 0/10");
    await refresh();
    assert.equal(await badge.textContent(), "Auto 0/10", "ready also reconciles the badge after reload");

    listedStatus = "active";
    await publish("stopped", 2, "You stopped the turn");
    assert.equal(await badge.textContent(), "Auto stopped", "the live stop updates the badge immediately");
    assert.match(await badge.getAttribute("title") ?? "", /You stopped the turn/);
    await refresh();
    assert.equal(await badge.textContent(), "Auto stopped", "a stale active snapshot cannot hide the live stop");
    await publish("active", 0);
    assert.equal(await badge.textContent(), "Auto 0/10", "resuming clears the stopped badge");
    await publish("active", 3);
    await page.waitForFunction(() => document.querySelector('[data-testid="auto-respond-pill"]')?.textContent === "Auto 3/10");
    assert.equal(await badge.textContent(), "Auto 3/10", "response counts update with the live event");
    await publish("off", 3);
    assert.equal(await badge.count(), 0, "off removes the sidebar badge too");
    await refresh();
    assert.equal(await badge.count(), 0, "a stale active snapshot cannot resurrect an off badge");
    assert.deepEqual(errors, []);
  } finally {
    for (const context of browser?.contexts() ?? []) {
      for (const page of context.pages()) await page.unrouteAll({ behavior: "ignoreErrors" });
    }
    await browser?.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
