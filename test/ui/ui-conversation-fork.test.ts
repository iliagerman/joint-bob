import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("conversation submenu forks and opens independent Pi and Claude history", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-fork-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: true });
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
    for (const [title, text] of [["Short one", "Single short line."], ["[Claude] Makor deployment information", "Deployment information for the Makor environment."]]) {
      const row = page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: title }) }).first();
      await row.getByTestId("session-menu-button").click();
      const action = page.getByTestId("session-fork-button");
      assert.equal(await action.count(), 1, "each conversation submenu needs Fork conversation");
      assert.equal(await action.innerText(), "Fork conversation");
      await action.click();
      await page.locator("#sessionTitle").filter({ hasText: `[F] ${title}` }).waitFor();
      await page.locator("#messages").getByText(text, { exact: true }).waitFor();
      const copy = page.locator("#sessionList .list-row.active");
      assert.match(await copy.innerText(), /\[F\]/);
      assert.equal(await page.locator("#sessionList").getByText(title, { exact: true }).count(), 1, "original remains separately listed");
      await page.reload();
      await page.locator("#sessionTitle").filter({ hasText: `[F] ${title}` }).waitFor();
      await page.locator("#messages").getByText(text, { exact: true }).waitFor();
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
