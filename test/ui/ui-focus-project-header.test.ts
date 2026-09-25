import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { api, signIn } from "../dev-nodes.js";

test("mobile project header hides clutter, offers copyable path and moves real filters into project actions", { timeout: 180_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  await api(node, await signIn(environment, node), "PUT", "/preferences", { focusUiEnabled: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  const path = await page.locator("#projectPath").textContent();
  for (const selector of ["#projectPath", "#chatsRecentSessionsButton", "#chatsRunningConversationsButton", "#conversationListPane .live-row", "#chatFilters", ".classification-filter", ".done-filter"]) {
    assert.equal(await page.locator(selector).isVisible(), false, `${selector} stays out of the mobile list`);
  }
  assert.ok((await page.locator("#chatsPanel .panel-bar").boundingBox())!.height <= 56);
  await page.locator("#projectName").click();
  await page.locator("#focusProjectInfoDialog").waitFor();
  assert.equal(await page.locator("#focusProjectPath").inputValue(), path);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByTestId("focus-project-copy-path").click();
  await page.waitForFunction(async path => await navigator.clipboard.readText() === path, path);
  await page.getByTestId("focus-project-info-close").click();
  await page.getByTestId("focus-controls-button").click();
  await page.locator("#focusContextActions button", { hasText: "Project actions" }).click();
  await page.getByTestId("project-conversation-filters-button").click();
  await page.locator("#focusProjectFiltersDialog").waitFor();
  await page.getByTestId("conversation-classification-filter").selectOption("unclassified");
  await page.getByTestId("show-done-conversations-toggle").check();
  await page.getByTestId("focus-project-filters-close").click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForFunction(() => document.querySelector("#conversationListPane .classification-filter") !== null);
  assert.equal(await page.locator("#projectPath").isVisible(), true);
  assert.equal(await page.locator("#chatsRecentSessionsButton").isVisible(), false, "desktop keeps its existing global Recents control");
  assert.equal(await page.locator("#chatsRunningConversationsButton").isVisible(), false);
  assert.equal(await page.getByTestId("conversation-classification-filter").inputValue(), "unclassified");
  assert.equal(await page.getByTestId("show-done-conversations-toggle").isChecked(), true);
  assert.equal(await page.locator("#projectName").getAttribute("role"), null);
});
