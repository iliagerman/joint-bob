import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("the composer names the agent of the open conversation", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-placeholder-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser: Browser | undefined;
  try {
    browser = await launchChrome({ headless: process.env.HEADED !== "1" });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    page.setDefaultTimeout(20_000);
    await page.goto(node.url, { waitUntil: "domcontentloaded" });
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
    const input = page.getByTestId("chat-message-input");

    await page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();
    await page.waitForFunction(() => (document.querySelector("#messageInput") as HTMLTextAreaElement | null)?.disabled === false);
    // Pi runs any provider's model, so its conversations are not offered as "Pi".
    assert.equal(await input.getAttribute("placeholder"), "Ask the agent to work...");

    // A Claude conversation is named for Claude, never offered as another harness's.
    await page.locator(".session-card", { hasText: "[Claude] Makor deployment information" }).first().click();
    await page.waitForFunction(() => (document.querySelector("#messageInput") as HTMLTextAreaElement | null)?.placeholder === "Ask Claude to work...");
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
