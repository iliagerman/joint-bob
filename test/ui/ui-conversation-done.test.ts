import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium, type Browser } from "playwright-core";
import type { SessionSummary } from "../../src/types.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

test("done conversations leave the list until the reader asks for them", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-done-ui-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser: Browser | undefined;
  try {
    const auth = await signIn(environment, node);
    const project = node.projects.find((entry) => entry.name === "Internal Assistant")!;
    const sessions = (await api<{ sessions: SessionSummary[] }>(node, auth, "GET", `/projects/${project.id}/sessions`)).body.sessions;
    const target = sessions.find((entry) => entry.title === "Thread-Based Agent Builder");
    assert.ok(target, "the seeded conversation is present");

    browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator(".project-card", { hasText: project.name }).first().click();
    const rows = page.locator("#sessionList .session-card");
    await rows.first().waitFor();
    assert.equal(await rows.count(), sessions.length);

    const row = page.locator(`#sessionList [data-session-path="${target.path}"]`);
    await row.getByTestId("session-menu-button").click();
    const menuItem = page.getByTestId("session-done-button");
    assert.equal(await menuItem.innerText(), "Mark done");
    await menuItem.click();

    await page.locator("#sessionList").getByText("Thread-Based Agent Builder").waitFor({ state: "hidden" });
    assert.equal(await rows.count(), sessions.length - 1, "a done conversation leaves the default list");
    assert.equal(await page.locator('[data-filter-count="all"]').textContent(), String(sessions.length - 1), "counts follow the same rule");

    const toggle = page.getByTestId("show-done-conversations-toggle");
    await toggle.check();
    assert.equal(await rows.count(), sessions.length, "Show done brings them back");
    const doneRow = page.locator(`#sessionList [data-session-path="${target.path}"]`);
    await doneRow.locator(".session-done-badge").waitFor();

    await doneRow.getByTestId("session-menu-button").click();
    assert.equal(await page.getByTestId("session-done-button").innerText(), "Mark not done");
    await page.getByTestId("session-done-button").click();
    await page.locator(`#sessionList [data-session-path="${target.path}"] .session-done-badge`).waitFor({ state: "detached" });
    await toggle.uncheck();
    assert.equal(await rows.count(), sessions.length, "an undone conversation stays visible");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
