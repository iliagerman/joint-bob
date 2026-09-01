// Browser sanity suite: drives a real Chrome against a seeded dev node and walks
// the journey a person walks — sign in, pick a project, open a conversation, open
// the canvas picker. It exists to catch breakage that source-text assertions
// cannot see: a login that never persists its session, a panel that renders
// nothing, or rows collapsed to an unreadable height.
//
// Run with `npm run test:ui`. It is deliberately outside the `test/*.test.ts`
// glob: it needs a Chrome binary, and a suite that silently skips itself would
// report success while testing nothing.
import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "../dev-nodes.js";

let root: string;
let environment: DevEnvironment;
let node: SeededNode;
let server: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;
const consoleErrors: string[] = [];
const failedResponses: string[] = [];

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-"));
  environment = await seedDevEnvironment(root, 1);
  node = environment.nodes[0];
  server = await startDevNode(environment, node);

  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: process.env.HEADED !== "1" });
  context = await browser.newContext({
    // Wide enough for the desktop layout: the canvas is hidden below 1024px.
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
    // The app ships a service worker. Blocking it keeps a cached shell from a
    // previous run out of the picture.
    serviceWorkers: "block",
  });
  page = await context.newPage();
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("response", (response) => {
    if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
  });
}, { timeout: 120_000 });

after(async () => {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(root, "final.png") }).catch(() => undefined);
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

test("signing in through the login form reaches the app and the session survives a reload", async () => {
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });

  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();

  // Readiness is a rendered project, not a load event: the shell paints long
  // before the project list arrives.
  await page.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 20_000 });
  assert.equal(await page.locator("#loginDialog[open]").count(), 0, "login dialog closes");

  // A dropped session cookie still closes the dialog, so the reload is the real
  // check that signing in persisted.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 20_000 });
  assert.equal(await page.locator("#loginDialog[open]").count(), 0, "reload stays signed in");
});

test("the project list shows every seeded project", async () => {
  for (const project of node.projects) {
    await page.locator(".project-card", { hasText: project.name }).first().waitFor({ timeout: 15_000 });
  }
});

test("opening a conversation renders its transcript", async () => {
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();

  const message = page.locator(".message").first();
  await message.waitFor({ timeout: 20_000 });
  assert.ok((await page.locator(".message").count()) >= 2, "both turns of the conversation render");
  assert.match(await message.innerText(), /re-threading the same builder prompt/);
});

test("the canvas picker lists conversations at a readable height", async () => {
  await page.getByTestId("projects-open-canvas-button").click();
  await page.getByTestId("canvas-add-button").click();
  await page.locator(".canvas-session-option").first().waitFor({ timeout: 20_000 });

  // The project with the most conversations, because the rows only used to
  // collapse once the list overflowed its own maximum height.
  await page.selectOption("#canvasProjectSelect", { label: "Internal Assistant" });
  await page.locator(".canvas-session-option", { hasText: "Thread-Based Agent Builder" }).waitFor({ timeout: 20_000 });

  // Two frames, so the measurements below read settled layout.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const overflowing = await page.evaluate(() => {
    const list = document.querySelector(".canvas-session-options");
    return list ? list.scrollHeight > list.clientHeight + 1 : false;
  });
  assert.ok(overflowing, "the list overflows its maximum height, which is the state that used to collapse the rows");

  const rows = await page.evaluate(() => [...document.querySelectorAll(".canvas-session-option")].map((option) => ({
    title: option.querySelector("strong")?.textContent ?? "",
    height: Math.round(option.getBoundingClientRect().height),
    subtitle: option.querySelector("span")?.textContent ?? "",
    subtitleHeight: Math.round(option.querySelector("span")?.getBoundingClientRect().height ?? 0),
    lineHeight: Math.round(parseFloat(getComputedStyle(option.querySelector("span") ?? option).lineHeight)),
  })));

  assert.ok(rows.length >= 3, `picker lists conversations (got ${rows.length})`);
  for (const row of rows) {
    // 44px is the row's minimum height. A row stuck at the minimum is the
    // regression this test exists for: the preview text is clipped mid-line.
    assert.ok(row.height > 44, `row "${row.title}" is taller than its 44px floor (got ${row.height})`);
    assert.ok(
      row.subtitleHeight >= row.lineHeight,
      `row "${row.title}" shows at least one full preview line (got ${row.subtitleHeight} for a ${row.lineHeight}px line)`,
    );
  }

  // The seeded long preview is the one that has to wrap to two lines.
  const wrapping = rows.find((row) => row.subtitle.length > 120);
  assert.ok(wrapping, "a long preview is present to test wrapping");
  assert.ok(
    wrapping.subtitleHeight >= wrapping.lineHeight * 2,
    `a long preview wraps to two lines (got ${wrapping.subtitleHeight} for a ${wrapping.lineHeight}px line)`,
  );
});

test("the journey produced no console errors and no failed requests", () => {
  assert.deepEqual(consoleErrors, [], "no console errors");
  assert.deepEqual(failedResponses, [], "no 4xx or 5xx responses");
});
