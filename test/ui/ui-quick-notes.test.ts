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

test("a quick note can move, start a conversation, and be deleted", async () => {
  await page.getByText("Internal Assistant", { exact: true }).click();
  await page.getByTestId("session-list-loading-bar").waitFor({ state: "hidden" });
  const conversationCount = await page.locator("#sessionList .session-card").count();

  const notesSection = page.getByTestId("quick-notes-section");
  const notesToggle = page.getByTestId("quick-notes-toggle-button");
  assert.equal(await notesToggle.locator(".shortcut-hint").count(), 1, "the project notes section advertises its shortcut");
  await notesToggle.click();
  await notesSection.and(page.locator(".collapsed")).waitFor();
  assert.equal(await notesToggle.getAttribute("aria-expanded"), "false");
  await page.keyboard.press("Control+Alt+/");
  await notesSection.and(page.locator(":not(.collapsed)")).waitFor();
  assert.equal(await notesToggle.getAttribute("aria-expanded"), "true");

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
  const movedRow = page.getByTestId("quick-note-row").filter({ hasText: "Verify release smoke test" });
  await movedRow.waitFor();
  const movedItem = page.locator(".quick-note-row-wrap").filter({ has: movedRow });
  assert.equal(await movedItem.getByTestId("quick-note-start-button").isVisible(), true, "each note has a start shortcut");

  await movedRow.click();
  assert.equal(await page.getByTestId("quick-note-convert-button").isVisible(), true, "the note dialog can start a conversation");
  await page.getByTestId("quick-note-cancel-button").click();
  await movedItem.getByTestId("quick-note-start-button").click();
  await page.locator("#messages .message.user").filter({ hasText: "Do this manually after deploy." }).waitFor();
  await movedRow.waitFor({ state: "detached" });

  await page.getByTestId("quick-note-create-button").click();
  await page.getByTestId("quick-note-title-input").fill("Delete this note");
  await page.getByTestId("quick-note-save-button").click();
  const disposable = page.locator(".quick-note-row-wrap").filter({ hasText: "Delete this note" });
  await disposable.getByTestId("quick-note-quick-delete-button").click();
  await page.getByTestId("confirm-accept-button").click();
  await disposable.waitFor({ state: "detached" });
});
