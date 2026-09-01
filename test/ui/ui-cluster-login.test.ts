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

test("signing into both nodes through the form leaves both tabs signed in", async () => {
  const pages: Page[] = [];
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
