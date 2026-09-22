import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function signIn(page: Page, url: string, username: string, password: string) {
  await page.goto(url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(username);
  await page.getByTestId("login-password-input").fill(password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#projectList .project-card").first().waitFor();
}

async function openSettingsTab(page: Page, tab: string) {
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" }).catch(() => {});
  // The shell re-renders its buttons about once a second; retry the click through the jitter.
  for (let attempt = 0; attempt < 10 && !(await page.locator("#settingsDialog[open]").count()); attempt += 1) {
    await page.getByTestId("settings-open-button").click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
  }
  await page.locator("#settingsDialog[open]").waitFor();
  await page.locator("#settingsDialog[open]").waitFor();
  await page.getByTestId(`settings-tab-${tab}`).click();
}

async function openHarnessRoutingGrid(page: Page, harnessId: string) {
  await openSettingsTab(page, "engines");
  await page.locator(`#harnessTabs [data-harness-tab="${harnessId}"]`).click();
  await page.locator(`[data-routing-harness="${harnessId}"] [data-testid="routing-model-${harnessId}-1"]`).waitFor();
}

test("routing settings are split across harness tabs, the Classifiers tab, and the Cluster tab", { timeout: 240_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);

  // The level grids live under each harness's own tab in the Harnesses section.
  await openHarnessRoutingGrid(page, "kiro");
  const rows = page.locator('[data-routing-harness="kiro"] [data-testid^="routing-level-kiro-"]');
  assert.equal(await rows.count(), 10, "each harness exposes levels 1 to 10");
  assert.equal(await page.getByTestId("routing-model-kiro-1").inputValue(), "", "harnesses without approved defaults stay blank");
  assert.equal(await page.getByTestId("routing-model-kiro-10").inputValue(), "", "blank rows are omitted from classifier choices");

  // The classifier and its calibration context live in their own tab, not under Clusters.
  await openSettingsTab(page, "classifiers");
  await page.getByTestId("routing-classifier").waitFor();
  assert.equal(await page.getByTestId("routing-classifier").inputValue(), "typesafe");
  await page.getByTestId("routing-instructions").fill("easiest is a rename; hardest is a two-service migration");

  // Policy controls, saving, and the leader status stay in the Cluster tab.
  await openSettingsTab(page, "cluster");
  await page.getByTestId("routing-status").getByText("No routing policy yet").waitFor();
  assert.equal(await page.locator('#settingsPanel-cluster [data-testid="routing-classifier"]').count(), 0, "the classifier select must not be under Clusters");
  await page.getByTestId("routing-enabled").check();
  await page.getByTestId("routing-cadence").selectOption("every-n");
  await page.getByTestId("routing-cadence-n").fill("3");
  await page.getByTestId("routing-confidence").fill("0.25");
  await page.getByTestId("routing-save-button").click();
  await page.getByTestId("routing-status").getByText("This node manages the routing policy").waitFor();

  await page.evaluate('document.querySelector("#settingsDialog").close(); true');
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  db.exec("PRAGMA busy_timeout=5000");
  const stored = db.prepare("SELECT policy,revision,leader_node_id,updated_by FROM cluster_routing_policies WHERE cluster_id='' ").get() as { policy: string; revision: number; leader_node_id: string; updated_by: string };
  const pending = { clusterId: "", policy: { ...JSON.parse(stored.policy), classifierId: "future-classifier" }, revision: stored.revision + 1, leaderNodeId: stored.leader_node_id, updatedBy: stored.updated_by, updatedAt: "2030-01-01T00:00:00Z", originNodeId: stored.leader_node_id };
  db.prepare("INSERT INTO cluster_routing_pending VALUES (?,?,?,?)").run("", JSON.stringify(pending), pending.updatedAt, pending.originNodeId);
  db.close();

  // Loading the classifier list once must not start a model-dialog render loop.
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();
  await page.locator("#modelButton:enabled").waitFor();
  const routing = await page.evaluate('import("/app/state.js").then(({ state }) => state.routing)');
  assert.equal(routing?.active, true, `saved routing policy must be active for the conversation: ${JSON.stringify(routing)}`);
  await page.getByTestId("chat-routing-warning").getByText("future-classifier").waitFor();
  await page.getByTestId("chat-model-button").click();
  await page.getByTestId("model-option-bob-auto").waitFor();
  await page.getByTestId("routing-classifier-dialog-select").waitFor();
  await page.waitForTimeout(500);
  await page.getByTestId("model-dialog-close-button").click();
  assert.equal(await page.getByTestId("model-dialog").isVisible(), false, "the model picker stays responsive after classifier loading");

  await openSettingsTab(page, "classifiers");
  assert.equal(await page.getByTestId("routing-instructions").inputValue(), "easiest is a rename; hardest is a two-service migration", "calibration survives save and reload");

  await openSettingsTab(page, "cluster");
  await page.getByTestId("routing-status").getByText("future-classifier").waitFor();
  await page.getByTestId("routing-clear-button").click();
  await page.locator("#confirmDialog[open]").waitFor();
  await page.getByTestId("confirm-accept-button").click();
  await page.getByTestId("routing-status").getByText("No routing policy yet").waitFor();
});
