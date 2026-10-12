import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensureUsageSchema } from "../../src/usage-ledger.js";
import { launchChrome } from "./launch-chrome.js";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

test("an owner limits a project and a conversation from the app, and sees the budget when it is used up", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-budget-owner-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const project = projectNamed(node, "Internal Assistant");
  const db = new DatabaseSync(path.join(node.dataDir, "node.db")); ensureUsageSchema(db);
  const occurredAt = new Date().toISOString();
  const event = { id: "spent", projectId: project.id, conversationId: "somewhere", sessionId: "s", engine: "pi", provider: "test", modelId: "fixture", occurredAt, requestId: null, input: 1, output: 1, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0, reasoning: 0, apiCostUsd: 4.5, pricing: null, usageStatus: "reported", difficultyLevel: null, difficultyConfidence: null, difficultyStatus: "unknown", turnId: null, toolCalls: 0, toolErrors: 0 };
  db.prepare("INSERT INTO model_usage_events(id,project_id,conversation_id,session_id,engine,occurred_at,payload,origin_node_id) VALUES(?,?,?,?,?,?,?,?)").run("spent", project.id, "somewhere", "s", "pi", occurredAt, JSON.stringify(event), node.nodeId);
  db.close();
  const server = await startDevNode(environment, node);
  let browser;
  try {
    const session = await signIn(environment, node);
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("response", (response) => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
    await page.goto(node.url);
    await page.locator("#loginDialog[open]").waitFor({ timeout: 20_000 });
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    const card = page.locator(".project-card", { hasText: "Internal Assistant" }).first();
    await card.waitFor();

    // Project limit from the project's menu: $4.50 is spent, so a $10 limit warns and leaves room.
    await page.locator(`[data-project-id="${project.id}"] [data-testid="project-menu-button"]`).click();
    await page.getByTestId("project-budget-button").click();
    const dialog = page.getByTestId("budget-dialog");
    await dialog.waitFor();
    await dialog.locator('[data-budget-period="day"]').fill("5");
    await page.getByTestId("budget-dialog-save").click();
    await page.getByText("Budget saved").waitFor();
    const saved = await api<any>(node, session, "GET", `/budgets/limits?kind=project&subjectId=${encodeURIComponent(project.id)}`);
    assert.deepEqual(saved.body.limits, [{ period: "day", usd: 5 }]);

    // Opening a conversation shows the warning strip: 90% of $5.
    await card.click();
    const row = page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Short one" }) }).first();
    await row.click();
    const notice = page.getByTestId("budget-notice");
    await notice.waitFor();
    assert.match(await notice.innerText(), /Nearing a budget: daily project limit: \$4\.50 of \$5\.00/);

    // The conversation's own limit comes from its menu and shows its status.
    await row.getByTestId("session-menu-button").click();
    await page.getByTestId("session-budget-button").click();
    await dialog.waitFor();
    assert.match(await page.getByTestId("budget-dialog-status").innerText(), /daily project limit: \$4\.50 of \$5\.00/);
    await dialog.locator('[data-budget-period="total"]').fill("1");
    await page.getByTestId("budget-dialog-save").click();
    await page.getByText("Budget saved").waitFor();

    // Lowering the project limit below the spend turns the strip into the used-up message.
    await api(node, session, "PUT", `/budgets/limits?kind=project&subjectId=${encodeURIComponent(project.id)}`, { limits: [{ period: "day", usd: 4 }], utcOffsetMinutes: 0 });
    await page.reload();
    await card.click();
    await page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Short one" }) }).first().click();
    await notice.waitFor();
    assert.match(await notice.innerText(), /Budget reached: the daily limit of \$4\.00 for project Internal Assistant is used up \(\$4\.50 spent\)/);
    assert.equal(await notice.getAttribute("data-state"), "over");

    // Workspace limits are the admin's, from Settings > Workspaces.
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-workspaces").click();
    await page.getByTestId("workspace-budget-button").first().click();
    await dialog.waitFor();
    await dialog.locator('[data-budget-period="month"]').fill("100");
    await page.getByTestId("budget-dialog-save").click();
    await page.getByText("Budget saved").waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
