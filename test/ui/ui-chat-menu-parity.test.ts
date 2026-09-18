import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

/** The conversation list's row menu and the open conversation's menu are the same
    menu, so every row action has to be reachable without leaving the conversation. */
test("the open conversation offers the same menu its row offers", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-chat-menu-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser;
  try {
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).click();

    const row = page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Short one" }) }).first();
    await row.getByTestId("session-menu-button").click();
    const rowLabels = await page.locator("#rowMenu button").allInnerTexts();
    assert.ok(rowLabels.includes("Fork conversation"), "the row menu is the one under test");
    await page.keyboard.press("Escape");

    await row.locator("button").first().click();
    await page.locator("#sessionTitle").filter({ hasText: "Short one" }).waitFor();
    await page.getByTestId("chat-session-menu-button").click();
    assert.deepEqual(await page.locator("#rowMenu button").allInnerTexts(), rowLabels, "the open conversation offers exactly the row's actions");

    // The actions act on the open conversation, not on whatever the list last touched.
    await page.getByTestId("session-done-button").click();
    await page.locator("#sessionList").getByText("Short one", { exact: true }).waitFor({ state: "hidden" });
    await page.getByTestId("chat-session-menu-button").click();
    assert.equal(await page.getByTestId("session-done-button").innerText(), "Mark not done");
    await page.keyboard.press("Escape");

    // On a phone the toolbar hides its actions behind More, so the entry lives there.
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.getByTestId("chat-session-menu-button").isVisible(), false);
    await page.getByTestId("chat-more-button").click();
    await page.getByTestId("chat-session-menu-button").click();
    await page.locator("#rowMenu:popover-open").waitFor();
    assert.ok((await page.locator("#rowMenu button").allInnerTexts()).includes("Fork conversation"));
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
