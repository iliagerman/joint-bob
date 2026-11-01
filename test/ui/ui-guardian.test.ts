import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser, type Page } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

async function choose(page: Page, testid: string, text: string): Promise<void> {
  await page.getByTestId(testid).click();
  await page.getByTestId(`${testid}-search`).fill(text);
  await page.locator(`[data-testid="${testid}-option"]`, { hasText: text }).first().click();
}

const guardian = (page: Page) => page.evaluate(async () => (await fetch("/api/guardian")).json()) as Promise<{ settings: { enabled: boolean; model: string; rules: Array<{ id: string; name: string; ifYes: string; care: string }> } }>;

test("Guardian rules are switched, edited with searchable dropdowns and reviewed in the conversation", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-guardian-ui-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser: Browser | undefined;
  try {
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-guardian").click();

    const rows = page.getByTestId("guardian-rule");
    await rows.first().waitFor();
    assert.deepEqual(await rows.locator(".guardian-rule-copy strong").allTextContents(), ["Dangerous commands", "Secrets", "Personal information"]);
    assert.equal(await rows.nth(0).locator(".guardian-rule-copy span").textContent(), "Before commands · ask me");

    await page.getByTestId("guardian-enabled").check();
    await page.waitForFunction(async () => (await (await fetch("/api/guardian")).json()).settings.enabled === true);

    await rows.nth(1).getByTestId("guardian-rule-edit").click();
    await page.getByTestId("guardian-rule-editor").waitFor();
    await choose(page, "guardian-if-yes", "Block");
    await page.getByTestId("guardian-care-cautious").click();
    await page.getByTestId("guardian-rule-save").click();
    await page.getByTestId("guardian-rule-editor").waitFor({ state: "detached" });
    assert.equal(await rows.nth(1).locator(".guardian-rule-copy span").textContent(), "Before anything is sent to the AI · block");
    const saved = (await guardian(page)).settings.rules.find((rule) => rule.id === "secrets");
    assert.equal(saved?.ifYes, "block");
    assert.equal(saved?.care, "cautious");

    await page.getByTestId("guardian-rule-add").click();
    await page.getByTestId("guardian-rule-name").fill("Production deploys");
    await page.getByTestId("guardian-rule-question").fill("Does this command deploy to production?");
    await choose(page, "guardian-check", "Before commands");
    await page.screenshot({ path: path.join(root, "guardian-editor.png") });
    await page.getByTestId("guardian-rule-save").click();
    await page.locator('[data-testid="guardian-rule"]', { hasText: "Production deploys" }).waitFor();
    assert.equal((await guardian(page)).settings.rules.length, 4);

    await page.getByTestId("settings-tab-classifiers").click();
    await page.getByTestId("guardian-laya-row").waitFor();
    await choose(page, "guardian-model", "Laya");
    await page.waitForFunction(async () => (await (await fetch("/api/guardian")).json()).settings.model === "laya-local");
    await page.screenshot({ path: path.join(root, "guardian-classifiers.png") });
    await page.keyboard.press("Escape");

    // A paused action as the conversation's socket delivers it.
    await page.evaluate(() => document.dispatchEvent(new CustomEvent("guardian-event", { detail: { type: "guardianReviews", reviews: [
      { id: "11111111-1111-4111-8111-111111111111", projectId: "p", conversationId: "c", title: "Pi wants to run a command", subject: "rm -rf ./customer-exports", detail: "Dangerous commands rule · 94% sure · Jev", createdAt: "", expiresAt: "" },
    ] } })));
    const card = page.getByTestId("guardian-review");
    await card.waitFor();
    assert.equal(await card.locator("strong").textContent(), "Pi wants to run a command");
    assert.equal(await page.getByTestId("guardian-review-subject").textContent(), "rm -rf ./customer-exports");
    assert.equal(await page.evaluate(() => document.querySelector('[data-testid="guardian-review"]')?.nextElementSibling?.id), "composer", "the card sits directly above the composer");
    await page.screenshot({ path: path.join(root, "guardian-review.png") });
    await page.evaluate(() => document.dispatchEvent(new CustomEvent("guardian-event", { detail: { type: "guardianReviews", reviews: [] } })));
    await card.waitFor({ state: "detached" });
    assert.deepEqual(errors, []);
    console.log(`screenshots: ${root}`);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    if (!process.env.KEEP_GUARDIAN_UI) await rm(root, { recursive: true, force: true });
  }
});
