import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("Settings turns the per-conversation CPU and memory limits on, saves and reloads them", { timeout: 120_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByTestId("settings-open-button").click();
  await page.locator('[data-testid="settings-save-button"]:enabled').waitFor();
  const cpuEnabled = page.getByTestId("settings-conversation-cpu-limit-enabled");
  const cores = page.getByTestId("settings-conversation-cpu-limit-cores");
  const memoryEnabled = page.getByTestId("settings-conversation-memory-limit-enabled");
  const gigabytes = page.getByTestId("settings-conversation-memory-limit-gb");
  assert.equal(await cpuEnabled.isChecked(), false, "no CPU limit until someone sets one");
  assert.equal(await memoryEnabled.isChecked(), false, "no memory limit until someone sets one");
  assert.equal(await cores.isDisabled(), true);
  assert.equal(await gigabytes.isDisabled(), true);
  await cpuEnabled.check();
  await memoryEnabled.check();
  for (const invalid of ["0", "1025"]) {
    await cores.fill(invalid);
    assert.equal(await cores.evaluate((input: HTMLInputElement) => input.checkValidity()), false, `cores ${invalid}`);
  }
  await cores.fill("2.5");
  await gigabytes.fill("12");
  await page.getByTestId("settings-save-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" });
  const saved = await page.evaluate(async () => { const settings = await (await fetch("/api/settings")).json(); return [settings.conversationCpuLimitCores, settings.conversationMemoryLimitGb]; });
  assert.deepEqual(saved, [2.5, 12]);
  await page.reload();
  await page.getByTestId("settings-open-button").click();
  await page.locator('[data-testid="settings-save-button"]:enabled').waitFor();
  assert.equal(await cores.inputValue(), "2.5");
  assert.equal(await gigabytes.inputValue(), "12");
  await memoryEnabled.uncheck();
  assert.equal(await gigabytes.isDisabled(), true);
  await page.getByTestId("settings-save-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" });
  const cleared = await page.evaluate(async () => { const settings = await (await fetch("/api/settings")).json(); return [settings.conversationCpuLimitCores, settings.conversationMemoryLimitGb]; });
  assert.deepEqual(cleared, [2.5, null], "unticking a limit removes it");
});
