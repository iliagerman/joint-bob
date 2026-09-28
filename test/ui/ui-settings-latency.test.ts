import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test("Settings opens immediately and local settings do not wait for optional panels", { timeout: 90_000 }, async (t) => {
  const { page, node, environment } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card").first().waitFor();
  const settings = gate(), cluster = gate();
  const clusterRequested = gate();
  await page.route("**/api/settings", async route => { await settings.promise; await route.continue(); });
  await page.route("**/api/cluster/node", async route => { clusterRequested.release(); await cluster.promise; await route.continue(); });
  await page.route("**/api/update/status", route => route.fulfill({ status: 503, json: { error: "Update service unavailable" } }));
  try {
    await page.getByTestId("settings-open-button").click();
    await page.locator("#settingsDialog[open]").waitFor({ timeout: 2_000 });
    assert.equal(await page.getByTestId("settings-save-button").isDisabled(), true, "an unfinished settings read must never overwrite saved values");
    assert.equal(await page.locator("#settingsForm").getAttribute("aria-busy"), "true");
    settings.release();
    await page.locator('[data-testid="settings-save-button"]:enabled').waitFor({ timeout: 5_000 });
    await clusterRequested.promise;
    assert.equal(await page.locator("#settingsDialog").evaluate((element: HTMLDialogElement) => element.open), true);
    assert.equal(await page.locator("#settingsForm").getAttribute("aria-busy"), null);
    await page.getByTestId("settings-tab-engines").click();
    await page.locator("#harnessTabs button").first().waitFor();
  } finally {
    settings.release(); cluster.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("failed settings reads keep saving disabled and allow closing the dialog", { timeout: 90_000 }, async (t) => {
  const { page, node, environment } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card").first().waitFor();
  await page.route("**/api/settings", route => route.fulfill({ status: 503, json: { error: "Settings temporarily unavailable" } }));
  await page.getByTestId("settings-open-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ timeout: 2_000 });
  await page.waitForFunction(() => !document.querySelector("#settingsForm")?.hasAttribute("aria-busy"));
  assert.equal(await page.getByTestId("settings-save-button").isDisabled(), true);
  await page.locator("#cancelSettingsButton").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" });
});
