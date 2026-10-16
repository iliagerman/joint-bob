// The conversation switcher in a real Chrome: holding its chord lists the conversations
// opened most recently, a tap steps through them, and letting go opens the row selected.
// The chord is Control+Option with Tab on a Mac and Ctrl+Shift+Space elsewhere.
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
let mac = true;
let chordKeys: string[] = [];
let cycleKey = "Tab";

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-switcher-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);
  browser = await launchChrome({ headless: process.env.HEADED !== "1" });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  page.setDefaultNavigationTimeout(60_000);
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
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().waitFor({ timeout: 20_000 });
  mac = await page.evaluate(() => /mac/i.test(navigator.platform));
  chordKeys = mac ? ["Control", "Alt"] : ["Control", "Shift"];
  cycleKey = mac ? "Tab" : "Space";
}

async function openConversation(title: string): Promise<void> {
  await page.locator(".session-card", { hasText: title }).first().click();
  await page.locator('.session-card[aria-current="true"]', { hasText: title }).first().waitFor({ timeout: 20_000 });
}

const isCurrent = (title: string) => page.locator('.session-card[aria-current="true"]', { hasText: title }).count().then((count) => count === 1);
const rows = () => page.locator(".conversation-switcher-row");
const overlayOpen = () => page.locator(".conversation-switcher").isVisible();

async function holdChord(): Promise<void> {
  for (const key of chordKeys) await page.keyboard.down(key);
}

async function letGoOfChord(): Promise<void> {
  for (const key of [...chordKeys].reverse()) await page.keyboard.up(key);
}

test("holding the chord and tapping the cycle key steps to the previous conversation on release", async () => {
  await signIn();
  await openConversation("Thread-Based Agent Builder");
  await openConversation("Mobile Multi-Agent Threads");

  await holdChord();
  await page.keyboard.press(cycleKey);
  assert.equal(await overlayOpen(), true, "the list opens while the chord is held");
  assert.equal(await rows().count(), 2, "both conversations opened are listed");
  assert.match(await rows().nth(0).innerText(), /Mobile Multi-Agent Threads/, "row 1 is the conversation open now");
  assert.equal(await rows().nth(1).evaluate((row) => row.classList.contains("selected")), true, "a tap selects row 2");
  assert.equal(await isCurrent("Mobile Multi-Agent Threads"), true, "nothing opens until the chord is let go");

  await letGoOfChord();
  await page.locator('.session-card[aria-current="true"]', { hasText: "Thread-Based Agent Builder" }).first().waitFor({ timeout: 20_000 });
  assert.equal(await overlayOpen(), false, "letting go closes the list");
});

test("rows show review, running, and auto-respond indicators", async () => {
  await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    const first = state.recentSessions[0];
    const second = state.recentSessions[1];
    const firstSession = state.sessions.find((session) => session.id === first.sessionId);
    const secondSession = state.sessions.find((session) => session.id === second.sessionId);
    if (!firstSession || !secondSession) throw new Error("Expected both recent sessions in active project");
    firstSession.turnRunning = true;
    firstSession.autoRespond = { status: "running", responses: 2, maxResponses: 10 };
    if (state.activeConversationId === (firstSession.conversationId || firstSession.id)) state.autoRespond = firstSession.autoRespond;
    secondSession.reviewState = "needs_review";
  });
  await holdChord();
  await page.keyboard.press(cycleKey);
  assert.match(await rows().nth(0).innerText(), /Running/i);
  assert.match(await rows().nth(0).innerText(), /Auto 2\/10/);
  assert.match(await rows().nth(1).innerText(), /Needs review/i);
  await page.keyboard.press("Escape");
  await letGoOfChord();
});

test("a recent conversation in another project gets its status when listed", async () => {
  const other = await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    const project = state.projects.find((candidate) => candidate.id !== state.activeProjectId);
    if (!project) throw new Error("Expected another project");
    const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/sessions`);
    const { sessions } = await response.json();
    const conversation = sessions[0];
    if (!conversation) throw new Error("Expected another project's conversation");
    state.recentSessions.push({ projectId: project.id, sessionPath: conversation.path, title: "Other project status", openedAt: new Date().toISOString() });
    return { id: project.id, path: conversation.path };
  });
  const endpoint = `**/api/projects/${encodeURIComponent(other.id)}/sessions`;
  await page.route(endpoint, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.sessions.find((candidate: { path: string }) => candidate.path === other.path).reviewState = "needs_review";
    await route.fulfill({ response, json: body });
  });
  try {
    await holdChord();
    await page.keyboard.press(cycleKey);
    await rows().filter({ hasText: "Other project status" }).getByText("Needs review", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await letGoOfChord();
  } finally {
    await page.unroute(endpoint);
    await page.evaluate(async (path) => {
      const { state } = await import("/app/state.js");
      state.recentSessions = state.recentSessions.filter((entry) => entry.sessionPath !== path);
    }, other.path);
  }
});

test("a digit opens its row at once, even while the chord is still held", async () => {
  await holdChord();
  await page.keyboard.press(cycleKey);
  const second = await rows().nth(1).locator("strong").innerText();
  await page.keyboard.press("Digit2");
  await page.locator('.session-card[aria-current="true"]', { hasText: second }).first().waitFor({ timeout: 20_000 });
  assert.equal(await overlayOpen(), false, "the digit closes the list without waiting for the release");
  await letGoOfChord();
});

test("Escape cancels the switch and leaves the open conversation as it was", async () => {
  const open = await isCurrent("Mobile Multi-Agent Threads") ? "Mobile Multi-Agent Threads" : "Thread-Based Agent Builder";
  const other = open === "Mobile Multi-Agent Threads" ? "Thread-Based Agent Builder" : "Mobile Multi-Agent Threads";
  await holdChord();
  await page.keyboard.press(cycleKey);
  assert.equal(await overlayOpen(), true);
  await page.keyboard.press("Escape");
  assert.equal(await overlayOpen(), false, "Escape closes the list while the chord is held");
  await letGoOfChord();
  assert.equal(await isCurrent(open), true, "the open conversation is unchanged");
  assert.equal(await isCurrent(other), false);
});

test("the chord still opens the list while a chat pane on the canvas has the keyboard", async () => {
  await page.getByTestId("projects-open-canvas-button").click();
  await page.getByTestId("canvas-add-button").click();
  await page.locator(".canvas-session-option").first().waitFor({ timeout: 20_000 });
  await page.selectOption("#canvasProjectSelect", { label: "Internal Assistant" });
  await page.locator(".canvas-session-option", { hasText: "Thread-Based Agent Builder" }).first().click();
  // A pane is its own document: its keys reach this page only once its app has loaded and
  // forwards them, so the test waits for the pane's composer and types into it first.
  const composer = page.frameLocator('iframe[title*="Thread-Based Agent Builder"]').locator("#messageInput");
  await composer.waitFor({ timeout: 20_000 });
  await composer.click();

  await holdChord();
  await page.keyboard.press(cycleKey);
  // Keyboard forwarding uses postMessage, so key dispatch can finish before the parent handles it.
  await page.locator(".conversation-switcher").waitFor({ state: "visible" });
  assert.equal(await overlayOpen(), true, "the list opens from inside the pane");
  assert.ok(await rows().count() >= 2, "the list has the conversations opened before");
  await letGoOfChord();
  // The pane's release reaches this page as a message, so the close is awaited rather than read.
  await page.locator(".conversation-switcher").waitFor({ state: "hidden", timeout: 5_000 });
});

test("a mouse click on a row opens it while the chord is held", async () => {
  // Control+click is a context-menu gesture on a Mac, so the row must not depend on a click event that never comes.
  await holdChord();
  await page.keyboard.press(cycleKey);
  const target = await rows().nth(1).locator("strong").innerText();
  const box = await rows().nth(1).boundingBox();
  assert.ok(box, "row 2 is on screen");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.locator('.session-card[aria-current="true"]', { hasText: target }).first().waitFor({ timeout: 20_000 });
  assert.equal(await overlayOpen(), false, "the click closes the list");
  await letGoOfChord();
});
