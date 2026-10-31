import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator, Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function choose(page: Page | Locator, testid: string, search: string, label: string): Promise<void> {
  await page.getByTestId(testid).click();
  await page.getByTestId(`${testid}-search`).fill(search);
  await page.getByTestId(`${testid}-option`).filter({ hasText: label }).first().click();
}

test("subscription profiles sit apart from harness setup, page, and save choices for many workspaces at once", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden" });
  await page.locator(".project-card").first().waitFor();
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-engines").click();
  await page.getByTestId("provider-profile-add").waitFor();
  assert.match(await page.getByTestId("harness-config-card").locator("h3").innerText(), /Harness configuration/);
  assert.match(await page.getByTestId("provider-profiles").locator("h3").innerText(), /Subscription profiles/);
  assert.match(await page.getByTestId("provider-profiles").innerText(), /never goes through the relay/);
  assert.equal(await page.getByTestId("harness-config-card").getByTestId("provider-profiles").count(), 0, "profiles are not inside the harness card");

  await page.getByTestId("provider-profile-provider-openai-codex").click();
  for (let i = 1; i <= 5; i += 1) {
    await page.getByTestId("provider-profile-label").fill(`Account ${i}`);
    const created = page.waitForResponse((response) => response.url().endsWith("/api/provider-profiles") && response.request().method() === "POST");
    await page.getByTestId("provider-profile-add").click();
    const response = await created;
    assert.equal(response.status(), 201, `Account ${i}: ${await response.text()}`);
    await page.getByTestId("provider-profile-row").filter({ hasText: `Account ${i}` }).waitFor();
  }
  assert.equal(await page.getByTestId("provider-profile-row").count(), 1);
  await page.getByTestId("provider-profile-prev").click();
  assert.equal(await page.getByTestId("provider-profile-row").count(), 4);
  const first = page.getByTestId("provider-profile-row").filter({ hasText: "Account 1" });
  await first.getByTestId("provider-profile-status").filter({ hasText: "Sign in on this node or on a twin." }).waitFor();
  assert.equal(await first.locator(".profile-pill").innerText(), "Not signed in");
  assert.equal(await first.getByTestId("provider-profile-signout").isVisible(), false);

  const defaultRow = page.locator('[data-testid="provider-assignment-row"][data-scope="default"]');
  const workspaceRows = page.locator('[data-testid="provider-assignment-row"][data-scope="workspace"]');
  assert.ok(await workspaceRows.count() >= 2, "the seeded workspaces each have a row");
  const workspaceCell = (index: number) => workspaceRows.nth(index).getByTestId("provider-assignment-openai-codex");
  await choose(defaultRow, "provider-assignment-openai-codex", "Account 1", "Account 1");
  await page.getByTestId("provider-assignments-pending").filter({ hasText: "1 unsaved change" }).waitFor();
  assert.match(await workspaceCell(0).innerText(), /Use my default · Account 1/);
  await choose(workspaceRows.nth(0), "provider-assignment-openai-codex", "Account 2", "Account 2");
  await choose(workspaceRows.nth(1), "provider-assignment-openai-codex", "Account 3", "Account 3");
  await page.getByTestId("provider-assignments-pending").filter({ hasText: "3 unsaved changes" }).waitFor();
  const workspaceIds = await workspaceRows.evaluateAll((rows) => rows.slice(0, 2).map((row) => (row as HTMLElement).dataset.scopeId));

  const puts: Array<{ scope: string; scopeId: string }> = [];
  page.on("request", (request) => { if (request.url().endsWith("/api/provider-profiles/selection") && request.method() === "PUT") puts.push(request.postDataJSON()); });
  await page.getByTestId("provider-assignments-save").click();
  await page.locator("#confirmDialog[open]").waitFor();
  assert.match(await page.locator("#confirmDialog").innerText(), /conversation history/);
  await page.getByTestId("confirm-accept-button").click();
  await page.getByTestId("provider-assignments-pending").filter({ hasText: "All choices saved" }).waitFor();
  assert.deepEqual(puts.map(({ scope, scopeId }) => [scope, scopeId]).sort(), [["default", ""], ["workspace", workspaceIds[0]], ["workspace", workspaceIds[1]]].sort());

  await page.getByTestId("settings-tab-account").click();
  const reload = page.waitForResponse((response) => response.url().endsWith("/api/provider-profiles") && response.request().method() === "GET");
  await page.getByTestId("settings-tab-engines").click();
  await reload;
  await page.getByTestId("provider-assignments-pending").filter({ hasText: "All choices saved" }).waitFor();
  assert.equal((await workspaceCell(0).innerText()).trim(), "Account 2");
  assert.equal((await workspaceCell(1).innerText()).trim(), "Account 3");

  await page.getByTestId("provider-override-provider").selectOption("openai-codex");
  await choose(page, "provider-override-profile", "Account 4", "Account 4");
  await page.getByTestId("provider-override-add").click();
  await page.getByTestId("confirm-accept-button").click();
  const override = page.getByTestId("provider-override-row").filter({ hasText: "Account 4" });
  await override.waitFor();
  await override.getByTestId("provider-override-remove").click();
  await page.getByTestId("confirm-accept-button").click();
  await override.waitFor({ state: "detached" });

  const sharing = page.getByTestId("provider-profile-row").filter({ hasText: "Account 2" });
  await sharing.getByTestId("provider-profile-sharing").click();
  await page.locator("#confirmDialog[open]").waitFor();
  assert.match(await page.locator("#confirmDialog").innerText(), /Every user on this node/);
  await page.getByTestId("confirm-accept-button").click();
  await page.getByTestId("provider-profile-row").filter({ hasText: "Account 2" }).filter({ hasText: "Shared for automation" }).waitFor();
  assert.match(await workspaceCell(0).innerText(), /Account 2 — unavailable, choose another/);
  assert.match(await workspaceCell(0).getAttribute("class") ?? "", /invalid/);
  await defaultRow.getByTestId("provider-assignment-openai-codex").click();
  await defaultRow.getByTestId("provider-assignment-openai-codex-search").fill("Account 2");
  assert.equal(await defaultRow.getByTestId("provider-assignment-openai-codex-option").count(), 0);
});
