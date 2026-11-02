import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function signIn(page: Page, url: string, username: string, password: string) {
  await page.goto(url);
  await page.getByTestId("login-username-input").fill(username);
  await page.getByTestId("login-password-input").fill(password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card").first().waitFor();
}

/** Every visible settings panel that scrolls sideways, with the element that sets its width. */
function sidewaysPanels(): string[] {
  const panels = [...document.querySelectorAll<HTMLElement>("#settingsForm .settings-panel")].filter((panel) => !panel.hidden);
  return panels.flatMap((panel) => {
    if (panel.scrollWidth <= panel.clientWidth) return [];
    const wide = [...panel.querySelectorAll<HTMLElement>("*")].filter((element) => element.getBoundingClientRect().right > panel.getBoundingClientRect().right + 1);
    const culprits = wide.slice(0, 3).map((element) => `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}.${element.className}`);
    return [`${panel.id}: scrollWidth ${panel.scrollWidth} > clientWidth ${panel.clientWidth}; wider: ${culprits.join(", ")}`];
  });
}

test("settings sections fit a phone without scrolling sideways", { timeout: 240_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await page.setViewportSize({ width: 390, height: 844 });
  // Harness rows with the dates and versions a real node shows, so the Updates section is measured with content.
  await page.route(/\/api\/update\/status$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json() as { harnessUpdates: { harnesses: unknown[] } };
    const checkedAt = new Date("2026-11-02T18:48:15Z").toISOString();
    body.harnessUpdates.harnesses = [
      { id: "pi", label: "Pi", version: "1.5.0", state: "succeeded", checkedAt, error: null },
      { id: "claude", label: "Claude", version: "2.1.316", state: "succeeded", checkedAt, error: null },
      { id: "kiro", label: "Kiro", version: "2.37.1", state: "succeeded", checkedAt, error: null },
    ];
    await route.fulfill({ response, json: body });
  });
  const tabs = await page.locator("#settingsForm .settings-tab").evaluateAll((elements) => elements.map((element) => element.getAttribute("data-settings-tab")));
  assert.ok(tabs.length > 10, `the audit reaches every settings section (found ${tabs.length})`);
  const problems: string[] = [];
  for (const tab of tabs) {
    await page.evaluate(async (name) => (await import("/app/settings.js")).openSettings(name), tab);
    await page.locator(`#settingsPanel-${tab}`).waitFor({ state: "visible" });
    const found = await page.evaluate(sidewaysPanels);
    problems.push(...found.map((problem) => `[${tab}] ${problem}`));
  }
  assert.deepEqual(problems, [], "no settings section scrolls sideways on a phone");
});
