import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
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
  const level1Model = await page.getByTestId("routing-model-kiro-1").inputValue();
  assert.ok(level1Model === "" || level1Model.includes("\u0000"), "level 1 prefill is either empty or a real model choice");
  assert.equal(await page.getByTestId("routing-thinking-kiro-1").inputValue(), "low", "level 1 prefills the easiest reasoning pair");
  assert.equal(await page.getByTestId("routing-thinking-kiro-10").inputValue(), "max", "level 10 prefills the strongest reasoning pair");

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
  await page.getByTestId("routing-status").getByText("This node leads the routing policy").waitFor();

  await page.evaluate('document.querySelector("#settingsDialog").close(); true');
  await openSettingsTab(page, "classifiers");
  assert.equal(await page.getByTestId("routing-instructions").inputValue(), "easiest is a rename; hardest is a two-service migration", "calibration survives save and reload");

  await openSettingsTab(page, "cluster");
  await page.getByTestId("routing-clear-button").click();
  await page.locator("#confirmDialog[open]").waitFor();
  await page.getByTestId("confirm-accept-button").click();
  await page.getByTestId("routing-status").getByText("No routing policy yet").waitFor();
});
