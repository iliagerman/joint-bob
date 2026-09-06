// Two nodes, one browser, one cookie jar.
//
// Cookies ignore the port, so every node reachable at 127.0.0.1 shares a cookie
// jar. With one cookie name, signing into the second node silently replaces the
// first node's session and the first tab is signed out on its next load — which
// is exactly what a developer running a dev node beside an installed one hits.
// Each node therefore names its own session cookie, and this is the test that
// says so.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment } from "../dev-nodes.js";

let root: string;
let environment: DevEnvironment;
let servers: ChildProcess[] = [];
let browser: Browser;
let context: BrowserContext;
let pages: Page[] = [];

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-cluster-"));
  environment = await seedDevEnvironment(root, 2);
  servers = await Promise.all(environment.nodes.map((node) => startDevNode(environment, node)));

  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: process.env.HEADED !== "1" });
  // One context: both tabs share a cookie jar, the way two tabs in a real
  // browser do.
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", serviceWorkers: "block" });
}, { timeout: 180_000 });

after(async () => {
  if (browser) await browser.close();
  await Promise.all(servers.map((server) => stopDevNode(server)));
  if (root) await rm(root, { recursive: true, force: true });
});

async function signInThroughForm(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 30_000 });
}

async function waitForOwner(sessionId: string, ownerNodeId: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const settled = environment.nodes.every((node) => {
      const database = new DatabaseSync(path.join(node.dataDir, "node.db"), { readOnly: true });
      const owner = database.prepare("SELECT owner_node_id FROM conversation_ownership WHERE session_id = ?").get(sessionId) as { owner_node_id: string } | undefined;
      database.close();
      return owner?.owner_node_id === ownerNodeId;
    });
    if (settled) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Conversation ownership did not settle across both nodes");
}

test("signing into both nodes through the form leaves both tabs signed in", async () => {
  for (const node of environment.nodes) {
    const page = await context.newPage();
    pages.push(page);
    await signInThroughForm(page, node.url);
  }

  const cookieNames = (await context.cookies()).map((cookie) => cookie.name);
  for (const node of environment.nodes) {
    assert.ok(cookieNames.includes(node.cookieName), `node ${node.key} stored its own ${node.cookieName} cookie`);
  }

  // The reload is the real check. A replaced or rejected cookie still leaves the
  // dialog closed on the tab that just signed in; only a fresh load asks the
  // server who you are.
  for (const [index, node] of environment.nodes.entries()) {
    const page = pages[index];
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(await page.locator("#loginDialog[open]").count(), 0, `node ${node.key} is still signed in after the other node signed in`);

    const status = await page.evaluate(() => fetch("/api/auth/status").then((response) => response.json() as Promise<{ authenticated: boolean }>));
    assert.equal(status.authenticated, true, `node ${node.key} reports an authenticated session`);
  }
});

// The Cluster tab is where a person checks whether the other machine is up. Both nodes
// are running here, so each tab must name itself and report the other as connected.
test("the cluster settings list says which nodes are connected", async () => {
  const [mac, homeserver] = environment.nodes;
  const [macPage] = pages;

  await macPage.getByTestId("settings-open-button").click();
  await macPage.getByTestId("settings-tab-cluster").click();
  const rows = macPage.getByTestId("cluster-node-row");
  await rows.first().waitFor({ timeout: 30_000 });
  assert.equal(await rows.count(), 2, "one row for this node and one for its peer");

  const listed = await rows.evaluateAll((nodes) => nodes.map((node) => ({
    name: node.querySelector("strong")?.textContent ?? "",
    status: node.querySelector(".cluster-node-status")?.textContent ?? "",
    state: (node as HTMLElement).dataset.state,
  })));
  const local = listed.find((entry) => entry.name === mac.name);
  const peer = listed.find((entry) => entry.name === homeserver.name);
  assert.ok(local, `the list names this node (${JSON.stringify(listed)})`);
  assert.equal(local.status, "This node");
  assert.ok(peer, `the list names the paired node by name, not by id (${JSON.stringify(listed)})`);
  assert.equal(peer.status, "Connected", "a running peer reads as connected");
  assert.equal(peer.state, "online");

  await macPage.getByTestId("settings-cancel-button").click();
  await macPage.getByTestId("settings-dialog").waitFor({ state: "hidden" });
});

test("an open remote conversation can switch locally and take ownership", async () => {
  const [mac, homeserver] = environment.nodes;
  const [macPage, homeserverPage] = pages;

  await macPage.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await macPage.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();
  await macPage.locator("#messages .message", { hasText: "We keep re-threading" }).waitFor({ timeout: 30_000 });
  await waitForOwner("thread-based-agent-builder", mac.nodeId);

  await homeserverPage.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await homeserverPage.getByTestId("chat-node-select").selectOption(mac.nodeId);
  await homeserverPage.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();
  await homeserverPage.locator("#messages .message", { hasText: "We keep re-threading" }).waitFor({ timeout: 30_000 });

  const nodeSelect = homeserverPage.getByTestId("chat-node-select");
  assert.equal(await nodeSelect.isEnabled(), true, "the node selector remains usable for an open conversation");
  await nodeSelect.selectOption(homeserver.nodeId);
  const takeButton = homeserverPage.getByTestId("conversation-lock-take-button");
  await homeserverPage.locator("#messages .message", { hasText: "We keep re-threading" }).waitFor({ timeout: 30_000 });
  const takeoverState = await homeserverPage.evaluate(() => ({
    selectedNodeId: (document.querySelector("#chatNodeSelect") as HTMLSelectElement).value,
    lockHidden: (document.querySelector("#conversationLock") as HTMLElement).hidden,
    lockDetail: document.querySelector("#conversationLockDetail")?.textContent,
  }));
  assert.equal(await takeButton.isVisible(), true, `local view offers takeover: ${JSON.stringify(takeoverState)}`);
  await takeButton.click();
  await homeserverPage.locator("#conversationLock").waitFor({ state: "hidden", timeout: 30_000 });
  assert.equal(await homeserverPage.getByTestId("chat-message-input").isEnabled(), true, "the destination can continue the conversation after takeover");
});
