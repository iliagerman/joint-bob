import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type BrowserContext, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-quick-notes-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);
  const session = await signIn(environment, node);
  browser = await launchChrome({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const separator = session.cookie.indexOf("=");
  await context.addCookies([{ name: session.cookie.slice(0, separator), value: session.cookie.slice(separator + 1), url: node.url }]);
  page = await context.newPage();
  page.setDefaultTimeout(60_000);
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.getByText("Internal Assistant", { exact: true }).waitFor();
}, { timeout: 180_000 });

after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("a quick note defaults to the active project, stays inert, and can move projects", async () => {
  await page.getByText("Internal Assistant", { exact: true }).click();
  await page.getByTestId("session-list-loading-bar").waitFor({ state: "hidden" });
  const conversationCount = await page.locator("#sessionList .session-card").count();

  const button = page.getByTestId("quick-note-create-button");
  assert.equal(await button.locator(".shortcut-hint").count(), 1, "quick note button advertises its shortcut");
  await page.keyboard.press("Control+Alt+.");
  await page.locator("#quickNoteDialog[open]").waitFor();
  assert.equal(await page.getByTestId("quick-note-project-select").inputValue(), node.projects.find((project) => project.name === "Internal Assistant")!.id);
  await page.getByTestId("quick-note-title-input").fill("Verify release smoke test");
  await page.getByTestId("quick-note-content-input").fill("Do this manually after deploy.");
  await page.getByTestId("quick-note-save-button").click();

  const row = page.getByTestId("quick-note-row").filter({ hasText: "Verify release smoke test" });
  await row.waitFor();
  assert.equal(await page.locator("#sessionList .session-card").count(), conversationCount, "saving a note does not create a conversation");

  await row.click();
  await page.getByTestId("quick-note-project-select").selectOption({ label: "Joint Bob" });
  await page.getByTestId("quick-note-save-button").click();
  await row.waitFor({ state: "detached" });

  const jointBobId = node.projects.find((project) => project.name === "Joint Bob")!.id;
  await page.locator(`[data-project-id="${jointBobId}"] .project-card`).click();
  await page.getByTestId("quick-note-list").getByText("Verify release smoke test", { exact: true }).waitFor();
});
