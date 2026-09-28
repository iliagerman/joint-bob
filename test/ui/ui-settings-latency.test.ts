import assert from "node:assert/strict";
import test from "node:test";
import { api, signIn } from "../dev-nodes.js";
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
    assert.equal(await page.getByTestId("settings-tab-cluster").isEnabled(), true, "navigation must not wait for local settings");
    await page.getByTestId("settings-tab-cluster").click();
    await page.getByTestId("cluster-loading").waitFor();
    assert.equal(await page.getByTestId("cluster-loading").evaluate(element => getComputedStyle(element, "::before").content), '""', "pending clusters show a spinner");
    assert.equal(await page.getByTestId("cluster-content").isVisible(), false);
    await clusterRequested.promise;
    await page.getByTestId("settings-cancel-button").click();
    await page.getByTestId("settings-open-button").click();
    await page.locator("#settingsDialog[open]").waitFor({ timeout: 2_000 });
    await page.getByTestId("settings-tab-cluster").click();
    settings.release();
    await page.locator('[data-testid="settings-save-button"]:enabled').waitFor({ timeout: 5_000 });
    assert.equal(await page.getByTestId("cluster-loading").isVisible(), true, "optional cluster requests do not block saving local settings");
    cluster.release();
    await page.getByTestId("cluster-content").waitFor({ timeout: 5_000 });
    assert.equal(await page.getByTestId("cluster-loading").isVisible(), false);
    assert.equal(await page.getByTestId("settingsPanel-cluster").evaluate(element => element.inert), false);
    assert.equal(await page.locator("#settingsDialog").evaluate((element: HTMLDialogElement) => element.open), true);
    assert.equal(await page.locator("#settingsForm").getAttribute("aria-busy"), null);
    assert.equal(await page.getByTestId("settings-tab-cluster").getAttribute("aria-selected"), "true", "late local settings must not switch tabs");
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

test("Settings uses the desktop viewport and keeps navigation and actions inside small screens", { timeout: 90_000 }, async (t) => {
  const { page, node, environment } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card").first().waitFor();
  await page.setViewportSize({ width: 2415, height: 1219 });
  await page.getByTestId("settings-open-button").click();
  await page.locator('[data-testid="settings-save-button"]:enabled').waitFor();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const desktop = await page.locator("#settingsForm").boundingBox();
  assert.ok(desktop && desktop.width >= 1600 && desktop.height >= 950, "large screens get a substantially larger Settings workspace");
  const panel = await page.locator("#settingsPanel-account").boundingBox();
  assert.ok(panel && panel.height > 700, "panels fill the larger dialog instead of keeping the old 440px cap");
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 600 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const [form, save] = await Promise.all([page.locator("#settingsForm").boundingBox(), page.getByTestId("settings-save-button").boundingBox()]);
    assert.ok(form && form.x >= 0 && form.y >= 0 && form.x + form.width <= viewport.width && form.y + form.height <= viewport.height);
    assert.ok(save && save.y + save.height <= viewport.height, "Save remains on screen without scrolling the whole dialog");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
});

test("Cluster loading failures offer retry and selected-cluster spinners ignore stale responses", { timeout: 90_000 }, async (t) => {
  const { page, node, environment } = await nativeUiFixture(t);
  const auth = await signIn(environment, node);
  const create = async (name: string) => {
    const result = await api<{ snapshot: { body: { clusterId: string } } }>(node, auth, "POST", "/clusters", { name });
    assert.equal(result.status, 201);
    return result.body.snapshot.body.clusterId;
  };
  const alphaId = await create("Alpha"), betaId = await create("Beta");
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card").first().waitFor();
  let fail = true;
  await page.route("**/api/clusters", route => fail ? route.fulfill({ status: 503, json: { error: "Fixture unavailable" } }) : route.continue());
  const alpha = gate(), beta = gate(), settings = gate();
  await page.route("**/api/settings", async route => { await settings.promise; await route.continue(); });
  await page.route(`**/api/clusters/${alphaId}/sharing`, async route => { await alpha.promise; await route.continue(); });
  await page.route(`**/api/clusters/${betaId}/sharing`, async route => { await beta.promise; await route.continue(); });
  try {
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-cluster").click();
    await page.getByTestId("cluster-retry").waitFor();
    assert.match(await page.getByTestId("cluster-loading").innerText(), /Could not load clusters/);
    assert.equal(await page.getByTestId("cluster-loading").evaluate(element => element.classList.contains("is-loading")), false);
    assert.equal(await page.getByTestId("cluster-content").isVisible(), false);
    fail = false;
    await page.getByTestId("cluster-retry").click();
    await page.getByTestId("cluster-item").filter({ hasText: "Alpha" }).click();
    await page.locator('[data-testid="sharing-status"].is-loading').waitFor();
    await page.getByTestId("cluster-item").filter({ hasText: "Beta" }).click();
    await page.getByTestId("cluster-sharing").getByText("You share with Beta").waitFor();
    const oldResponse = page.waitForResponse(response => response.url().endsWith(`/api/clusters/${alphaId}/sharing`));
    alpha.release();
    await oldResponse;
    assert.equal(await page.getByTestId("cluster-sharing").getAttribute("aria-busy"), "true", "the old cluster must not clear the new spinner");
    assert.equal(await page.locator('[data-testid="sharing-status"].is-loading').isVisible(), true);
    beta.release();
    await page.getByTestId("sharing-save").waitFor();
    assert.equal(await page.getByTestId("cluster-sharing").getAttribute("aria-busy"), null);
    assert.equal(await page.locator('[data-testid="sharing-status"].is-loading').count(), 0);
    assert.equal(await page.getByTestId("cluster-loading").isVisible(), false);
    assert.equal(await page.getByTestId("settings-save-button").isDisabled(), true, "Cluster works while local settings are still loading");
    assert.equal(await page.getByTestId("settingsPanel-cluster").evaluate(element => element.inert), false);
  } finally {
    alpha.release(); beta.release(); settings.release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
