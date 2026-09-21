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

async function openClusterSettings(page: Page) {
  await page.getByTestId("settings-open-button").click();
  await page.locator("#settingsDialog[open]").waitFor();
  await page.getByTestId("settings-tab-cluster").click();
  await page.getByTestId("routing-status").waitFor();
}

test("the cluster panel edits, saves, and clears the routing policy", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await openClusterSettings(page);

  await page.getByTestId("routing-status").getByText("No routing policy yet").waitFor();
  const rows = page.locator('[data-testid="routing-harness-kiro"] [data-testid^="routing-level-kiro-"]');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 10, "each harness exposes levels 1 to 10");
  assert.equal(await page.locator('[data-testid="routing-model-kiro-1"]').inputValue(), "", "levels default to the conversation model");

  await page.getByTestId("routing-enabled").check();
  await page.getByTestId("routing-cadence").selectOption("every-n");
  await page.getByTestId("routing-cadence-n").fill("3");
  await page.getByTestId("routing-confidence").fill("0.25");
  await page.getByTestId("routing-save-button").click();
  await page.getByTestId("routing-status").getByText("This node leads the routing policy").waitFor();

  await page.evaluate('document.querySelector("#settingsDialog").close(); true');
  await openClusterSettings(page);
  assert.equal(await page.getByTestId("routing-enabled").isChecked(), true, "saved policy survives reload");
  assert.equal(await page.getByTestId("routing-cadence").inputValue(), "every-n");
  assert.equal(await page.getByTestId("routing-cadence-n").inputValue(), "3");
  assert.equal(await page.getByTestId("routing-confidence").inputValue(), "0.25");

  await page.getByTestId("routing-clear-button").click();
  await page.locator("#confirmDialog[open]").waitFor();
  await page.getByTestId("confirm-accept-button").click();
  await page.getByTestId("routing-status").getByText("No routing policy yet").waitFor();
});
