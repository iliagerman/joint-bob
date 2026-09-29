import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("Settings edits and reloads the bounded subprocess lifetime", { timeout: 120_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByTestId("settings-open-button").click();
  await page.locator('[data-testid="settings-save-button"]:enabled').waitFor();
  const minutes = page.getByTestId("settings-subprocess-max-lifetime-minutes");
  assert.equal(await minutes.inputValue(), "360");
  for (const invalid of ["0", "1.5", "10081"]) {
    await minutes.fill(invalid);
    assert.equal(await minutes.evaluate((input: HTMLInputElement) => input.checkValidity()), false);
  }
  await minutes.fill("120");
  await page.getByTestId("settings-save-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(async () => (await (await fetch("/api/settings")).json()).subprocessMaxLifetimeMinutes), 120);
  await page.reload();
  await page.getByTestId("settings-open-button").click();
  await page.locator('[data-testid="settings-save-button"]:enabled').waitFor();
  assert.equal(await minutes.inputValue(), "120");
});
