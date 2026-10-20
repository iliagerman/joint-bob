import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("the auto respond dialog opens from the chat menu with the default rules and no pill while off", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-auto-respond-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser: Browser | undefined;
  try {
    browser = await launchChrome({ headless: process.env.HEADED !== "1" });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url, { waitUntil: "domcontentloaded" });
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
    await page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();
    await page.getByTestId("chat-message-input").waitFor();
    assert.equal(await page.getByTestId("auto-respond-pill").isHidden(), true, "nothing is shown while it is off");

    await page.getByTestId("chat-auto-respond-button").click();
    await page.getByTestId("auto-respond-dialog").waitFor({ state: "visible" });
    assert.match(await page.getByTestId("auto-respond-status").innerText(), /Off/);
    assert.match(await page.getByTestId("auto-respond-instructions").inputValue(), /Answer as the user would/);
    assert.match(await page.getByTestId("auto-respond-stop-instructions").inputValue(), /password/);
    assert.equal(await page.getByTestId("auto-respond-limit").inputValue(), "10");
    assert.match(await page.getByTestId("auto-respond-instructions").inputValue(), /add a way to test it/, "the default asks the agent for a way to test what it built");
    assert.equal(await page.getByTestId("auto-respond-use-tools").isChecked(), true, "the responder may check the work by default");
    await page.getByTestId("auto-respond-harness").locator("option").first().waitFor({ state: "attached" });
    await page.getByTestId("auto-respond-cancel-button").click();
    await page.getByTestId("auto-respond-dialog").waitFor({ state: "hidden" });
    assert.equal(await page.getByTestId("session-auto-respond-badge").count(), 0, "the conversation row shows no badge while it is off");

    // Turning it on marks the conversation's row in the list, not only the toolbar.
    await page.getByTestId("chat-auto-respond-button").click();
    await page.getByTestId("auto-respond-enabled").check();
    await page.getByTestId("auto-respond-save-button").click();
    const rowBadge = page.locator(".session-card, .list-row").filter({ hasText: "Thread-Based Agent Builder" }).getByTestId("session-auto-respond-badge").first();
    await rowBadge.waitFor({ timeout: 20_000 });
    assert.match(await rowBadge.innerText(), /^Auto 0\/10$/);

    // An app update reloads the page: the saved state comes back from the node, not from the browser.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("chat-message-input").waitFor();
    await page.getByTestId("auto-respond-pill").waitFor({ state: "visible", timeout: 20_000 });

    // Choosing a preset fills in its rules; editing a rule switches the preset back to Custom.
    await page.getByTestId("chat-auto-respond-button").click();
    await page.getByTestId("auto-respond-preset").selectOption("review-consent");
    assert.match(await page.getByTestId("auto-respond-instructions").inputValue(), /LGTM/);
    await page.getByTestId("auto-respond-preset").selectOption("implementation-reviewer");
    const reviewerInstructions = await page.getByTestId("auto-respond-instructions").inputValue();
    assert.match(reviewerInstructions, /ongoing, constructive reviewer/);
    assert.match(reviewerInstructions, /do not nitpick/);
    assert.match(reviewerInstructions, /relevant tests pass/);
    assert.match(reviewerInstructions, /complements the AI-DLC driver/);
    await page.getByTestId("auto-respond-stop-instructions").fill("Stop now");
    assert.equal(await page.getByTestId("auto-respond-preset").inputValue(), "", "editing a preset's rule makes it Custom");
    await page.getByTestId("auto-respond-cancel-button").click();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
