import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("bob-btw opens an isolated temporary conversation and deletes it on close", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-btw-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node, { JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") });
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
    await page.getByText("Short one", { exact: true }).click();

    const open = async () => {
      await page.getByTestId("chat-message-input").fill("/bob-btw");
      await page.locator("#composer").evaluate((form: HTMLFormElement) => form.requestSubmit());
      await page.locator("#byTheWayDialog[open]").waitFor();
      const frame = page.frameLocator('[data-testid="by-the-way-frame"]');
      await frame.locator("#appBoot").waitFor({ state: "attached" });
      assert.equal(await frame.locator("#appBoot").isVisible(), false, "BTW must open as an in-app dialog without the app splash screen");
      await frame.locator("#sessionTitle").filter({ hasText: "[BTW] Short one" }).waitFor();
      await frame.locator("#messages").getByText("Single short line.", { exact: true }).waitFor();
    };

    await open();
    const sideChat = page.frameLocator('[data-testid="by-the-way-frame"]');
    await sideChat.getByTestId("chat-message-input").fill("side-only question");
    await sideChat.locator("#composer").evaluate((form: HTMLFormElement) => form.requestSubmit());
    await sideChat.locator("#messages").getByText("stubbed response", { exact: true }).waitFor();
    assert.equal(await page.locator("#messages").getByText("side-only question", { exact: true }).count(), 0, "BTW prompt must not enter the source conversation");
    const desktop = await page.getByTestId("by-the-way-dialog").boundingBox();
    assert.ok(desktop && desktop.width < 1400 && desktop.height < 880, `desktop BTW should be modal-sized: ${JSON.stringify(desktop)}`);
    await sideChat.getByTestId("chat-message-input").press("Escape");
    await page.locator("#byTheWayDialog[open]").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#sessionList").getByText("[BTW] Short one", { exact: true }).count(), 0);

    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    const mobile = await page.getByTestId("by-the-way-dialog").boundingBox();
    assert.ok(mobile && mobile.width >= 389 && mobile.height >= 843, `mobile BTW should fill the viewport: ${JSON.stringify(mobile)}`);
    await page.getByTestId("by-the-way-close-button").click();
    await page.locator("#byTheWayDialog[open]").waitFor({ state: "hidden" });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
