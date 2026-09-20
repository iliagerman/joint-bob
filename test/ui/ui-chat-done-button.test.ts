import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

/** Closing a conversation out is the action people reach for most from inside it, so
    on a phone it has to sit in the More menu itself, not one nested menu deeper. */
test("the chat More menu closes a conversation out without a nested menu", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-chat-done-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser: Browser | undefined;
  try {
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    page.setDefaultTimeout(30_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    // A loaded server can take a while to paint the sign-in dialog under load.
    await page.locator("#loginDialog[open], .project-card").first().waitFor({ timeout: 60_000 });
    if (await page.locator("#loginDialog[open]").count()) {
      await page.getByTestId("login-username-input").fill(environment.username);
      await page.getByTestId("login-password-input").fill(environment.password);
      await page.getByTestId("login-submit-button").click();
    }
    await page.getByText("Internal Assistant", { exact: true }).click();

    const row = page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Short one" }) }).first();
    await row.locator("button").first().click();
    await page.locator("#sessionTitle").filter({ hasText: "Short one" }).waitFor();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("chat-more-button").click();
    const doneButton = page.getByTestId("chat-done-button");
    assert.equal(await doneButton.innerText(), "Mark done");
    await doneButton.click();
    await page.locator(".toast-message").first().waitFor();
    assert.equal(await page.locator(".toast-message").first().innerText(), "Conversation marked done");

    await page.getByTestId("chat-more-button").click();
    assert.equal(await page.getByTestId("chat-done-button").innerText(), "Mark not done", "the label follows the conversation");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
