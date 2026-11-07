import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { waitInPage } from "./wait-in-page.js";

test("disabling unavailable Kiro allows Settings saves and survives reopening", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden" });
  await waitInPage(page, async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.evaluate(async () => {
    const { api } = await import("/app/api.js");
    const settings = await api("/api/settings");
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ runtimes: { kiro: { ...settings.runtimes.kiro, executable: "/nonexistent/kiro-cli" } } }) });
  });
  const open = async () => {
    await page.getByTestId("settings-open-button").click();
    await page.locator("#settingsDialog[open]").waitFor();
    await page.getByTestId("settings-tab-engines").click();
    await page.locator('[data-testid="settings-save-button"]:enabled').waitFor();
    await page.getByTestId("harness-tab-kiro").click();
  };
  await open();
  await page.getByTestId("settings-save-button").click();
  await page.getByText("Could not save settings: Fix unavailable custom paths: Kiro executable", { exact: true }).waitFor();
  await page.getByTestId("settings-kiro-enabled").uncheck();
  assert.equal(await page.getByTestId("settings-kiro-executable-input").isDisabled(), true);
  await page.getByTestId("settings-save-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" });
  const saved = await page.evaluate(async () => (await fetch("/api/settings")).json());
  assert.equal(saved.kiroEnabled, false);
  assert.equal(saved.runtimeOverrides.kiro.executable, "/nonexistent/kiro-cli");
  const harnesses = await page.evaluate(async () => (await fetch("/api/harnesses")).json());
  assert.equal(harnesses.harnesses.find((h: { id: string }) => h.id === "kiro").unavailableReason, "Kiro is disabled on this node");
  await open();
  assert.equal(await page.getByTestId("settings-kiro-enabled").isChecked(), false);
  await page.getByTestId("settings-save-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" });
});
