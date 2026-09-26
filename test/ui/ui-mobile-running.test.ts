import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

test("mobile conversations expose running work and keep the current chat globally reachable", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-mobile-running-"));
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  t.after(async () => {
    if (browser) await browser.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  });
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  server = await startDevNode(environment, node);
  browser = await launchChrome({ headless: true });
  const context = await browser.newContext({ viewport: { width: 375, height: 850 }, serviceWorkers: "block" });
  const session = await signIn(environment, node);
  await context.addCookies([{ name: node.cookieName, value: session.cookie.split("=")[1], url: node.url }]);
  const page = await context.newPage();

  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator(".project-card").first().waitFor();

  assert.equal(await page.getByTestId("running-conversations-open-button").isVisible(), true);
  assert.equal(await page.getByTestId("nav-chat-button").isVisible(), true);

  await page.locator(".project-card").first().click();
  const runningButton = page.getByTestId("chats-running-conversations-open-button");
  await runningButton.waitFor();
  await runningButton.click();
  await page.getByTestId("running-conversations-dialog").getByText("No conversations are running.").waitFor();
  await page.getByTestId("running-conversations-close-button").click();

  const conversation = page.locator("#sessionList .session-card").first();
  const title = await conversation.locator("strong").first().textContent();
  await conversation.click();
  await page.getByTestId("nav-projects-button").click();
  await page.getByTestId("nav-chat-button").click();
  await page.locator("#sessionTitle").getByText(title!, { exact: true }).waitFor();
});

test("mobile chat toolbar reaches running work and the label filter matches the search field", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-mobile-toolbar-"));
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  t.after(async () => {
    if (browser) await browser.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  });
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  server = await startDevNode(environment, node);
  browser = await launchChrome({ headless: true });
  const session = await signIn(environment, node);

  const phone = await browser.newContext({ viewport: { width: 375, height: 850 }, serviceWorkers: "block" });
  await phone.addCookies([{ name: node.cookieName, value: session.cookie.split("=")[1], url: node.url }]);
  const page = await phone.newPage();
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator(".project-card").first().waitFor();
  await page.locator(".project-card").first().click();
  await page.locator("#sessionList .session-card").first().waitFor();

  // The label filter sits in the same lane as the search field, so both render the same width.
  const { search, labels } = await page.evaluate(() => ({
    search: document.querySelector("#sessionSearchInput")!.getBoundingClientRect().toJSON(),
    labels: document.querySelector("#conversationClassificationFilter")!.getBoundingClientRect().toJSON(),
  }));
  assert.ok(search && labels, "both filter controls must be laid out");
  assert.equal(Math.round(labels!.width), Math.round(search!.width));
  assert.equal(Math.round(labels!.x), Math.round(search!.x));

  // The chat toolbar carries its own running button on a phone, where the header has no room.
  await page.locator("#sessionList .session-card").first().click();
  const toolbarRunning = page.getByTestId("chat-running-conversations-open-button");
  await toolbarRunning.waitFor();
  assert.equal(await toolbarRunning.isVisible(), true);
  await toolbarRunning.click();
  await page.getByTestId("running-conversations-dialog").waitFor();
  await page.getByTestId("running-conversations-close-button").click();

  // On a wide screen the header already carries that button, so the toolbar copy stays hidden.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("running-conversations-open-button").waitFor();
  assert.equal(await page.getByTestId("chat-running-conversations-open-button").isVisible(), false);
});
