import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("bob-goal status is shown without starting the harness", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-goal-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser: Browser | undefined;
  try {
    browser = await launchChrome({ headless: process.env.HEADED !== "1" });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    await page.goto(node.url, { waitUntil: "domcontentloaded" });
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
    await page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();
    await page.getByTestId("chat-message-input").fill("/bob-goal status");
    await page.getByTestId("chat-send-button").click();
    await page.locator(".toast-message", { hasText: "No /bob-goal has been started" }).waitFor({ timeout: 20_000 });
    assert.equal(await page.getByText("/bob-goal status", { exact: true }).count(), 0, "status is a controller command, not a harness prompt");
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
