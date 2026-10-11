import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("conversation menu moves a conversation to another project's list", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-transfer-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser;
  try {
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.goto(node.url);
    await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).click();
    const title = "Short one";
    const row = page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: title }) }).first();
    await row.getByTestId("session-menu-button").click();
    await page.getByTestId("session-transfer-button").click();
    const dialog = page.getByTestId("session-transfer-dialog");
    await dialog.waitFor();
    const submit = page.getByTestId("session-transfer-submit");
    assert.equal(await submit.isDisabled(), true, "submit needs a destination first");
    await page.getByTestId("session-transfer-copy").check();
    assert.equal(await submit.innerText(), "Copy");
    await page.getByTestId("session-transfer-project-select").click();
    await page.getByTestId("session-transfer-project-select-search").fill("Joint Bob");
    await page.getByTestId("session-transfer-project-select-option").filter({ hasText: "Joint Bob" }).first().click();
    assert.equal(await submit.isDisabled(), false);
    await submit.click();
    await dialog.waitFor({ state: "hidden" });
    await page.locator(".toast-message", { hasText: "Conversation copied to Joint Bob" }).first().waitFor({ state: "attached", timeout: 10_000 });
    assert.equal(await page.locator("#sessionList").getByText(title, { exact: true }).count(), 1, "the original stays in this project after a copy");
    await page.locator(".project-card", { hasText: "Joint Bob" }).first().click();
    await page.locator("#sessionList").getByText(title, { exact: true }).first().waitFor({ timeout: 10_000 });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
