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
  await page.getByTestId(`settings-tab-${tab}`).click();
}

test("routing configurations live under Classifiers, save mappings, and keep unavailable saved models", { timeout: 240_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  db.exec("PRAGMA busy_timeout=5000");
  t.after(() => db.close());

  // No routing control may remain in the Cluster or Harnesses panels.
  await openSettingsTab(page, "cluster");
  assert.equal(await page.locator('#settingsPanel-cluster [data-testid^="routing-"]').count(), 0, "the Cluster panel has no routing controls");
  await openSettingsTab(page, "engines");
  await page.locator('#harnessTabs [data-harness-tab="kiro"]').click();
  assert.equal(await page.locator('#settingsPanel-engines [data-testid^="routing-"]').count(), 0, "the Harnesses panel has no routing controls");

  // Everything is configured in the Classifiers tab: create, edit, save, activate.
  await openSettingsTab(page, "classifiers");
  await page.getByTestId("routing-config-name-input").fill("Field routing");
  await page.getByTestId("routing-config-create-button").click();
  await page.getByTestId("routing-config-editor").waitFor();
  const rows = page.locator('[data-testid^="routing-level-kiro-"]');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 10, "each harness exposes levels 1 to 10 in the Classifiers editor");
  const modelOption = await page.getByTestId("routing-model-kiro-1").locator("option:not([value=''])").first().getAttribute("value");
  assert.ok(modelOption, "Kiro exposes a model option for routing");
  await page.getByTestId("routing-model-kiro-1").selectOption(modelOption);
  const description = page.getByTestId("routing-description-kiro-1");
  assert.equal(await description.isEnabled(), true, "choosing a model enables its mandatory classifier description");
  await description.fill("Small, localized requests with clear requirements");
  await page.getByTestId("routing-cadence").selectOption("every-n");
  await page.getByTestId("routing-cadence-n").fill("3");
  await page.getByTestId("routing-context-messages").fill("6");
  await page.getByTestId("routing-confidence").fill("0.25");
  await page.getByTestId("routing-enabled").check();
  await page.getByTestId("routing-config-save-button").click();
  await page.getByTestId("routing-config-status").getByText("Local to this node").waitFor();

  await page.getByTestId("routing-active-config-select").selectOption({ label: "Field routing" });
  const configIdRow = db.prepare("SELECT id FROM routing_configs WHERE name = 'Field routing'").get() as { id: string } | undefined;
  assert.ok(configIdRow, "the configuration exists before it is selected");
  const configId = configIdRow.id;
  const selectionDeadline = Date.now() + 15_000;
  let selection: { config_id: string } | undefined;
  while (Date.now() < selectionDeadline) {
    selection = db.prepare("SELECT config_id FROM routing_config_selection WHERE singleton = 1").get() as { config_id: string } | undefined;
    if (selection?.config_id === configId) break;
    await page.waitForTimeout(250);
  }
  const stored = db.prepare("SELECT policy FROM routing_configs WHERE name = 'Field routing'").get() as { policy: string } | undefined;
  assert.ok(stored, "the configuration is saved under its name");
  const saved = JSON.parse(stored!.policy);
  assert.ok(saved.harnesses.kiro?.levels?.["1"], `level 1 mapping must be saved: ${stored!.policy.slice(0, 400)}`);
  assert.equal(saved.harnesses.kiro.levels["1"].modelId, modelOption!.split("\u0000")[1]);
  assert.equal(saved.harnesses.kiro.levels["1"].description, "Small, localized requests with clear requirements");
  assert.equal(saved.evalCadence.n, 3);
  assert.equal(saved.contextMessages, 6);
  assert.equal(saved.confidenceThreshold, 0.25);
  assert.equal(selection?.config_id, configId, "the active select stores this node's own selection");

  // Reopening the editor shows the saved values.
  await openSettingsTab(page, "classifiers");
  await page.locator('[data-testid="routing-config-edit-button"]').first().click();
  await page.getByTestId("routing-config-editor").waitFor();
  await page.getByTestId("routing-model-kiro-1").waitFor();
  assert.equal(await page.getByTestId("routing-description-kiro-1").inputValue(), "Small, localized requests with clear requirements", "the description survives save and reload");
  assert.equal(await page.getByTestId("routing-cadence-n").inputValue(), "3");
  assert.equal(await page.getByTestId("routing-context-messages").inputValue(), "6");

  // A saved mapping whose model is not offered right now keeps its own option, and
  // saving the editor must not silently clear it — nor clear an undetected harness.
  const ghost = JSON.parse(stored!.policy);
  ghost.harnesses.kiro.levels["2"] = { modelId: "ghost-model", thinkingLevel: "high", description: "A model this node cannot currently offer" };
  ghost.harnesses.claude = { levels: { "9": { modelId: "claude-opus-5", thinkingLevel: "high", description: "An undetected harness's mapping" } } };
  db.prepare("UPDATE routing_configs SET policy = ? WHERE id = ?").run(JSON.stringify(ghost), configId);
  await openSettingsTab(page, "classifiers");
  await page.locator('[data-testid="routing-config-edit-button"]').first().click();
  await page.getByTestId("routing-config-editor").waitFor();
  const ghostSelect = page.getByTestId("routing-model-kiro-2");
  await ghostSelect.waitFor();
  assert.match(await ghostSelect.locator("option:checked").textContent(), /saved, unavailable here/, "the unavailable saved model stays selected");
  assert.ok(await page.locator('[data-routing-harness="claude"] [data-testid="routing-level-claude-9"]').count(), "a harness present only in the saved policy keeps its grid");
  await page.getByTestId("routing-config-save-button").click();
  await page.getByTestId("routing-config-status").getByText("Local to this node").waitFor();
  const resaved = JSON.parse((db.prepare("SELECT policy FROM routing_configs WHERE id = ?").get(configId) as { policy: string }).policy);
  assert.equal(resaved.harnesses.kiro.levels["2"]?.modelId, "ghost-model", "saving preserves the unavailable saved model");
  assert.equal(resaved.harnesses.claude?.levels["9"]?.modelId, "claude-opus-5", "saving preserves the undetected harness's mapping");

  // An unknown classifier on the selected configuration surfaces a warning in chat.
  const future = JSON.parse(JSON.stringify(resaved));
  future.classifierId = "future-classifier";
  db.prepare("UPDATE routing_configs SET policy = ? WHERE id = ?").run(JSON.stringify(future), configId);
  await page.evaluate('document.querySelector("#settingsDialog").close(); true');
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator(".session-card", { hasText: "Thread-Based Agent Builder" }).first().click();
  await page.locator("#modelButton:enabled").waitFor();
  const routing = await page.evaluate('import("/app/state.js").then(({ state }) => state.routing)');
  assert.equal(routing?.active, true, `the selected configuration must be active for the conversation: ${JSON.stringify(routing)}`);
  await page.getByTestId("chat-routing-warning").getByText("future-classifier").waitFor();
  await page.getByTestId("chat-model-button").click();
  await page.getByTestId("model-option-bob-auto").waitFor();
  await page.getByTestId("routing-classifier-dialog-select").waitFor();
  await page.waitForTimeout(500);
  await page.getByTestId("model-dialog-close-button").click();
  assert.equal(await page.getByTestId("model-dialog").isVisible(), false, "the model picker stays responsive after classifier loading");

  // Deleting the active configuration ends the selection.
  await openSettingsTab(page, "classifiers");
  await page.locator('[data-testid="routing-config-edit-button"]').first().click();
  await page.getByTestId("routing-config-editor").waitFor();
  await page.getByTestId("routing-config-delete-button").click();
  await page.locator("#confirmDialog[open]").waitFor();
  await page.getByTestId("confirm-accept-button").click();
  await page.getByTestId("routing-config-list").getByText("No routing configurations yet").waitFor();
  assert.equal((db.prepare("SELECT count(*) AS count FROM routing_configs").get() as { count: number }).count, 0);
  assert.equal((db.prepare("SELECT config_id FROM routing_config_selection WHERE singleton = 1").get() as { config_id: string } | undefined)?.config_id ?? "", "", "deleting the selected configuration clears the selection");
});
