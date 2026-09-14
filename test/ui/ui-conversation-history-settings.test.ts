import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode } from "../dev-nodes.js";

let root: string;
let server: ChildProcess;
let browser: Browser;
let page: Page;
let node: SeededNode;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-history-settings-"));
  const environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);
  const session = await signIn(environment, node);
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const [name, value] = session.cookie.split("=");
  await context.addCookies([{ name, value, url: node.url }]);
  page = await context.newPage();
  await page.goto(node.url);
  await page.getByText("Internal Assistant", { exact: true }).waitFor();
});

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("conversation history window saves and reloads", async () => {
  await page.getByTestId("settings-open-button").click();
  const input = page.getByTestId("settings-conversation-history-days");
  await page.waitForFunction(() => (document.querySelector("#settingsConversationHistoryDays") as HTMLInputElement).value === "30");
  assert.equal(await input.inputValue(), "30");
  for (const value of ["45", "90"]) {
    await input.fill(value);
    await page.getByTestId("settings-save-button").click();
    await page.getByTestId("settings-dialog").waitFor({ state: "hidden" });
    await page.getByTestId("settings-open-button").click();
    await page.waitForFunction((expected) => (document.querySelector("#settingsConversationHistoryDays") as HTMLInputElement).value === expected, value);
    assert.equal(await input.inputValue(), value);
  }
  await page.getByTestId("settings-dialog").evaluate((dialog: HTMLDialogElement) => dialog.close());
});
