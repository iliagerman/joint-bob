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

/** Every dropdown that fails to draw the shared chevron, or leaves its label no room beside it. */
function unstyledDropdowns(): string[] {
  const controls = [...document.querySelectorAll<HTMLElement>("select, .searchable-select-trigger, #modelButton")];
  return controls.flatMap((control) => {
    const style = getComputedStyle(control);
    const problems = [
      control.tagName === "SELECT" && style.appearance !== "none" && "native appearance",
      !/svg/.test(style.backgroundImage) && "no chevron",
      parseFloat(style.paddingRight) < 24 && `text runs under the chevron (padding-right ${style.paddingRight})`,
    ].filter(Boolean);
    return problems.length ? [`${control.id || control.dataset.testid || control.getAttribute("name") || control.className}: ${problems.join(", ")}`] : [];
  });
}

for (const [layout, viewport] of [["desktop", { width: 1440, height: 900 }], ["phone", { width: 390, height: 844 }]] as const) {
  test(`every dropdown shows the shared chevron with room for it on ${layout}`, { timeout: 120_000 }, async (t) => {
    const { page, environment, node } = await nativeUiFixture(t);
    await signIn(page, node.url, environment.username, environment.password);
    await page.setViewportSize(viewport);
    // Settings builds its per-harness pickers on open, so open it before counting.
    await page.evaluate(async () => (await import("/app/settings.js")).openSettings("engines"));
    await page.getByTestId("settings-pi-default-model").waitFor();
    const count = await page.locator("select, .searchable-select-trigger").count();
    assert.ok(count > 40, `the audit reaches the app's dropdowns (found ${count})`);
    assert.deepEqual(await page.evaluate(unstyledDropdowns), [], "classic layout");
    await page.evaluate(() => document.body.classList.add("focus-ui"));
    assert.deepEqual(await page.evaluate(unstyledDropdowns), [], "focus layout");
  });
}

test("project pickers are dropdowns with a search box, not text fields", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  for (const testid of ["new-session-project-select", "quick-note-project-select"]) {
    const picker = page.getByTestId(testid);
    assert.equal(await picker.evaluate((element) => element.tagName), "BUTTON", `${testid} cannot be typed into`);
  }
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.evaluate(async () => (await import("/app/quick-notes.js")).openQuickNote());
  await page.locator("#quickNoteDialog[open]").waitFor();
  assert.equal(await page.getByTestId("quick-note-project-select").textContent(), "Internal Assistant", "the note starts in the active project");
  const picker = page.getByTestId("quick-note-project-select");
  await picker.click();
  await page.getByTestId("quick-note-project-select-search").fill("infra");
  const options = page.getByTestId("quick-note-project-options").getByRole("option");
  assert.deepEqual(await options.allTextContents(), ["Infra Scripts"]);
  await options.first().click();
  assert.equal(await picker.textContent(), "Infra Scripts");
});
