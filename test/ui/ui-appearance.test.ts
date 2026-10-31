import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
let page: Page;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-appearance-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);
  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
}, { timeout: 120_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

async function signIn(): Promise<void> {
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card").first().waitFor({ timeout: 20_000 });
}

test("the logo opens quick appearance settings that change theme and font size and survive a reload", async () => {
  await signIn();
  await page.getByTestId("appearance-open").click();
  await page.getByTestId("appearance-theme-midnight").click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.palette), "midnight");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "dark");

  await page.getByTestId("appearance-preset-huge").click();
  assert.equal(await page.getByTestId("appearance-global-value").textContent(), "150%");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#projectsPanel")!).zoom), "1.5");

  await page.getByTestId("appearance-headers-slider").fill("1.25");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#projectsPanel .panel-bar")!).zoom), "1.25");

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".project-card").first().waitFor({ timeout: 20_000 });
  assert.equal(await page.evaluate(() => document.documentElement.dataset.palette), "midnight");
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#projectsPanel")!).zoom), "1.5");

  await page.getByTestId("appearance-open").click();
  await page.getByTestId("appearance-reset-button").click();
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#projectsPanel")!).zoom), "1");
  assert.equal(await page.evaluate(() => document.documentElement.dataset.palette ?? ""), "");
});
