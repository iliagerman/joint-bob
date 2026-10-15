import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { type Browser, type Page } from "playwright-core";
import { seedDevEnvironment, startDevNode, stopDevNode, type DevEnvironment } from "../dev-nodes.js";
import { launchChrome } from "./launch-chrome.js";

let root: string;
let environment: DevEnvironment;
let server: ChildProcess;
let browser: Browser;
const references = "Review these references together.\nConversation: Selected context\nTask:\n";

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-references-"));
  environment = await seedDevEnvironment(root, 1);
  server = await startDevNode(environment, environment.nodes[0]);
  browser = await launchChrome({ headless: true });
}, { timeout: 120_000 });
after(async () => {
  if (browser) await browser.close();
  if (server) await stopDevNode(server);
  if (root) await rm(root, { recursive: true, force: true });
});

async function openProject(page: Page) {
  // Register before navigation. Hold the unsent path without launching an agent.
  await page.routeWebSocket((url) => url.pathname === "/ws", () => {});
  await page.goto(environment.nodes[0].url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Joint Bob" }).first().click();
  await page.locator(".session-card").first().waitFor();
  await page.waitForFunction(async () => {
    const { state } = await import("/app/state.js");
    return state.harnesses.some((h) => h.id === "pi" && h.ready) && state.sessionNodes.length > 0;
  });
}

async function startReferences(page: Page) {
  // Exercise the same exported entry point as the reference picker, without worktree fixtures.
  await page.evaluate((text) => {
    void import("/app/new-session.js").then((m) => m.startConversationWithReferences(text, 1)).catch(() => {});
  }, references);
  await page.locator("#choiceDialog[open]").waitFor();
  await page.locator('#choiceDialog input[value="pi"]').check();
  await page.getByTestId("choice-accept-button").click();
}

async function submitConversation(page: Page) {
  await page.locator("#newSessionNameDialog[open]").waitFor();
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("#newSessionNodeSelect")?.value);
  await page.getByTestId("new-session-name-start-button").click();
  await page.locator("#newSessionNameDialog[open]").waitFor({ state: "hidden" });
}

for (const previous of ["", "Unsent previous conversation"]) {
  test(`context references survive a same-harness new composer with ${previous ? "nonempty" : "empty"} input`, async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    try {
      await openProject(page);
      await page.evaluate(async () => (await import("/app/new-session.js")).startNewHarnessConversation("pi"));
      await submitConversation(page);
      assert.equal(await page.evaluate(async () => (await import("/app/state.js")).state.activeSessionPath), "new");
      await page.evaluate(async (text) => {
        (await import("/app/composer.js")).setInputValue(text);
      }, previous);
      assert.equal(await page.locator("#messageInput").inputValue(), previous);
      await startReferences(page);
      await page.locator("#newSessionNameDialog[open]").waitFor();
      assert.deepEqual(await page.evaluate(async () => {
        const { state } = await import("/app/state.js");
        return { path: state.activeSessionPath, next: state.newSessionDraft.sessionPath, text: document.querySelector<HTMLTextAreaElement>("#messageInput")!.value };
      }), { path: "new", next: "new", text: previous }, "same-harness unsent composer is still active before opening references");
      await submitConversation(page);
      assert.equal(await page.locator("#messageInput").inputValue(), references, "selected references replace the previous unsent composer");
    } finally {
      await context.close();
    }
  });
}

test("context references do not leak after failed settings retrieval", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage();
  try {
    await openProject(page);
    await page.route("**/api/settings", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Reference settings failed" }) }));
    const failed = page.waitForResponse((response) => response.url().endsWith("/api/settings") && response.status() === 500);
    await startReferences(page);
    await failed;
    await page.unroute("**/api/settings");
    await page.evaluate(async () => (await import("/app/new-session.js")).startNewHarnessConversation("pi"));
    assert.equal(await page.evaluate(async () => (await import("/app/state.js")).state.newSessionDraft.defaultTitle), "New Pi conversation");
    await submitConversation(page);
    assert.equal(await page.locator("#messageInput").inputValue(), "", "ordinary conversation must not inherit abandoned references");
  } finally {
    await context.close();
  }
});

for (const cancel of ["button", "Escape"]) {
  test(`context references clear their dialog draft on ${cancel} cancellation`, async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    try {
      await openProject(page);
      await startReferences(page);
      await page.locator("#newSessionNameDialog[open]").waitFor();
      assert.equal(await page.evaluate(async () => (await import("/app/state.js")).state.newSessionDraft.referenceDraft), references);
      if (cancel === "button") await page.getByTestId("new-session-name-cancel-button").click();
      else await page.keyboard.press("Escape");
      await page.locator("#newSessionNameDialog[open]").waitFor({ state: "hidden" });
      assert.equal(await page.evaluate(async () => (await import("/app/state.js")).state.newSessionDraft), null);
      await page.evaluate(async () => (await import("/app/new-session.js")).startNewHarnessConversation("pi"));
      await submitConversation(page);
      assert.equal(await page.locator("#messageInput").inputValue(), "");
    } finally {
      await context.close();
    }
  });
}
