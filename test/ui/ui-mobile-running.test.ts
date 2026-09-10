import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

async function assertMobileToolbarFits(page: Page): Promise<void> {
  for (const width of [320, 375, 430, 768, 1023]) {
    await page.setViewportSize({ width, height: 850 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const boxes = await page.locator("#chatToolbar").evaluate((toolbar) => {
      const controls = ["#modelButton", "#reasoningLevelSelect", "#chatRecentSessionsButton", ".chat-running-button", "#chatNodeSelect", "#chatHarnessSelect", ".chat-more > summary"].map((selector) => {
        const rect = toolbar.querySelector(selector)!.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      });
      return { controls, overflow: toolbar.scrollWidth > toolbar.clientWidth };
    });
    const [model, thinking, recents, running, node, agent, more] = boxes.controls;
    assert.equal(boxes.overflow, false, `toolbar must not overflow at ${width}px`);
    const row = [model, thinking, recents, running];
    for (const [index, box] of row.entries()) {
      assert.ok(box.left >= 0 && box.right <= width, `control ${index} must fit at ${width}px`);
      assert.ok(Math.abs(box.bottom - running.bottom) <= 1, `second row must stay aligned at ${width}px`);
      if (index) assert.ok(row[index - 1].right < box.left, `second-row controls must not overlap at ${width}px`);
    }
    assert.ok(thinking.width < model.width, `Thinking must leave more room for Model at ${width}px`);
    assert.ok(thinking.width >= 80, `Thinking must remain usable at ${width}px`);
    assert.ok(running.width >= 32 && running.height >= 32, "Running keeps the existing toolbar touch target");
    assert.ok(node.right < agent.left && agent.right < more.left, `first-row controls must not overlap at ${width}px`);
    assert.ok(more.bottom < running.top, `More stays above Running at ${width}px`);
  }
}

async function assertMobileConversationList(page: Page): Promise<void> {
  const running = page.getByTestId("chats-running-conversations-open-button");
  assert.equal(await running.isVisible(), true, "Running must be visible on the mobile Conversations list");
  for (const width of [320, 375, 430, 768, 1023]) {
    await page.setViewportSize({ width, height: 850 });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const boxes = await page.evaluate(() => {
      return ["#chatsRecentSessionsButton", ".chats-running-button", "#appMenu"].map((selector) => {
        const rect = document.querySelector(selector)!.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      });
    });
    const [recents, button, menu] = boxes;
    assert.ok(recents.right < button.left && button.right < menu.left, `Recents, Running and app menu must not overlap at ${width}px`);
    assert.ok(Math.abs(recents.top - button.top) <= 1, `Running sits beside Recents at ${width}px`);
    assert.ok(button.left >= 0 && button.right <= width, `Running must fit at ${width}px`);
  }
  await running.click();
  await page.getByTestId("running-conversations-dialog").getByText("No conversations are running.").waitFor();
  await page.getByTestId("running-conversations-close-button").click();
  await page.getByTestId("chats-recent-sessions-open-button").click();
  await page.getByTestId("recent-sessions-dialog").waitFor();
  await page.keyboard.press("Escape");
}

test("mobile lists and conversations fit Running beside Recents and open the global dialog", { timeout: 240_000 }, async (t) => {
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
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 375, height: 850 }, reducedMotion: "reduce", serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const session = await signIn(environment, node);
  const project = node.projects.find((candidate) => candidate.name === "Joint Bob")!;
  await api(node, session, "GET", "/running");
  const response = await api<{ sessions: Array<{ id: string; title: string; harnessId: string }> }>(node, session, "GET", `/projects/${project.id}/sessions`);
  const target = response.body.sessions[0];

  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().waitFor({ state: "attached" });
  await page.getByTestId("nav-projects-button").click();
  await page.getByTestId("running-conversations-open-button").click();
  await page.getByTestId("running-conversations-dialog").getByText("No conversations are running.").waitFor();
  await page.getByTestId("running-conversations-close-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await assertMobileConversationList(page);
  await page.setViewportSize({ width: 375, height: 850 });
  await page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();
  await page.getByTestId("chat-reasoning-select").waitFor();
  const running = page.getByTestId("chat-running-conversations-open-button");
  assert.equal(await running.isVisible(), true, "Running must be visible inside a mobile conversation");
  await assertMobileToolbarFits(page);

  await page.setViewportSize({ width: 375, height: 850 });
  await running.click();
  const dialog = page.getByTestId("running-conversations-dialog");
  await dialog.getByText("No conversations are running.").waitFor();
  await page.getByTestId("running-conversations-close-button").click();
  assert.equal(await dialog.isVisible(), false, "empty Running dialog closes");
  await page.getByTestId("chat-recent-sessions-open-button").click();
  await page.getByTestId("recent-sessions-dialog").waitFor();
  await page.keyboard.press("Escape");

  const database = new DatabaseSync(path.join(node.dataDir, "node.db"));
  try {
    const now = new Date();
    database.prepare(`INSERT INTO conversation_runtime_leases
      (engine, session_id, owner_node_id, ownership_epoch, run_id, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(target.harnessId, target.id, node.nodeId, 1, randomUUID(), now.toISOString(), new Date(now.getTime() + 60_000).toISOString());
    await running.click();
    await dialog.getByText(project.name, { exact: true }).waitFor();
    await dialog.getByTestId("running-conversation-option").filter({ hasText: target.title }).click();
    await page.getByTestId("chat-project-name").getByText(project.name, { exact: true }).waitFor();
    await page.locator("#sessionTitle").getByText(target.title, { exact: true }).waitFor();
    assert.equal(await dialog.isVisible(), false, "selecting a running conversation closes the dialog");
  } finally {
    database.prepare("DELETE FROM conversation_runtime_leases WHERE engine = ? AND session_id = ?").run(target.harnessId, target.id);
    database.close();
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  assert.equal(await running.isVisible(), false, "desktop keeps its existing global Running button");
  assert.equal(await page.getByTestId("chats-running-conversations-open-button").isVisible(), false, "desktop Conversations list keeps its existing header");
  assert.equal(await page.getByTestId("running-conversations-open-button").isVisible(), true);
});
