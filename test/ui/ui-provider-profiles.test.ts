import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator, Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function choose(page: Page | Locator, testid: string, search: string, label: string): Promise<void> {
  await page.getByTestId(testid).click();
  await page.getByTestId(`${testid}-search`).fill(search);
  await page.getByTestId(`${testid}-option`).filter({ hasText: label }).first().click();
}

test("connections have their own Settings tab, list profiles per provider, and choose a default with exceptions", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden" });
  await page.locator(".project-card").first().waitFor();
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-connections").click();
  await page.getByTestId("provider-profile-add").waitFor();
  assert.match(await page.getByTestId("provider-profiles").locator("h3").innerText(), /Connections/);
  assert.match(await page.getByTestId("provider-profiles").innerText(), /never goes through the relay/);
  await page.getByTestId("settings-tab-engines").click();
  await page.getByTestId("harness-config-card").waitFor();
  assert.equal(await page.locator("#settingsPanel-engines [data-testid='provider-profiles'], #settingsPanel-engines [data-testid='kiro-profiles']").count(), 0, "Harnesses holds no profile management");
  await page.getByTestId("settings-tab-connections").click();

  // Every provider, Kiro included, is the same kind of tab with its own icon.
  for (const provider of ["claude", "openai-codex", "pi", "kiro"]) {
    assert.equal(await page.getByTestId(`provider-profile-provider-${provider}`).locator("svg").count(), 1, `${provider} tab has its icon`);
  }

  let posted = 0;
  page.on("request", (request) => { if (request.url().endsWith("/api/provider-profiles") && request.method() === "POST") posted += 1; });
  await page.getByTestId("provider-profile-label").fill("   ");
  await page.getByTestId("provider-profile-add").click();
  await page.locator(".toast-message", { hasText: "Enter a profile name first." }).waitFor();
  assert.equal(posted, 0, "an empty name is not sent");
  assert.equal(await page.getByTestId("provider-profile-label").evaluate((input) => input === document.activeElement), true);

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
  await page.getByTestId("provider-profile-provider-claude").click();
  assert.equal(await page.getByTestId("provider-profile-row").count(), 0, "each provider tab lists only its own profiles");
  assert.match(await page.getByTestId("provider-profile-list").innerText(), /No Claude profiles yet/);

  const ids = Object.fromEntries((await (await page.request.get(`${node.url}/api/provider-profiles`)).json()).profiles.map((item: { id: string; label: string }) => [item.label, item.id]));
  const puts: Array<{ scope: string; scopeId: string; profileId: string | null }> = [];
  page.on("request", (request) => { if (request.url().endsWith("/api/provider-profiles/selection") && request.method() === "PUT") puts.push(request.postDataJSON()); });

  await page.getByTestId("provider-profiles-tab-assignments").click();
  assert.equal(await page.getByTestId("provider-profile-row").count(), 0, "profile cards stay on the Profiles tab");
  await page.getByTestId("provider-assignment-provider-openai-codex").click();
  assert.match(await page.getByTestId("provider-assignment-default").innerText(), /Every ChatGPT conversation uses/);
  const savedChoice = () => page.waitForResponse((response) => response.url().endsWith("/api/provider-profiles/selection") && response.request().method() === "PUT");
  await choose(page, "provider-assignment-default-select", "Account 1", "Account 1");
  await page.locator("#confirmDialog[open]").waitFor();
  assert.match(await page.locator("#confirmDialog").innerText(), /conversation history/);
  const defaultSaved = savedChoice();
  await page.getByTestId("confirm-accept-button").click();
  assert.equal((await defaultSaved).status(), 200);
  assert.deepEqual(puts.at(-1), { provider: "openai-codex", scope: "default", scopeId: "", profileId: ids["Account 1"] });

  const addException = async (scope: "workspace" | "project", label: string) => {
    await page.getByTestId("provider-exception-new").click();
    await page.getByTestId("provider-exception-scope").selectOption(scope);
    await page.getByTestId(`provider-exception-${scope}`).selectOption({ index: 0 });
    await choose(page, "provider-exception-choice-select", label, label);
    await page.getByTestId("provider-exception-add").click();
    const exceptionSaved = savedChoice();
    await page.getByTestId("confirm-accept-button").click();
    assert.equal((await exceptionSaved).status(), 200);
    await page.getByTestId("provider-exception-row").filter({ hasText: label }).waitFor();
  };
  await addException("project", "Account 3");
  await addException("workspace", "Account 2");
  const rows = page.getByTestId("provider-exception-row");
  assert.deepEqual(await rows.evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.scope)), ["workspace", "project"], "less specific exceptions come first");
  assert.match(await rows.first().innerText(), /workspace[\s\S]*uses[\s\S]*Account 2/i);
  assert.deepEqual(puts.slice(-2).map(({ scope, profileId }) => [scope, profileId]), [["project", ids["Account 3"]], ["workspace", ids["Account 2"]]]);

  await page.getByTestId("settings-tab-account").click();
  const reload = page.waitForResponse((response) => response.url().endsWith("/api/provider-profiles") && response.request().method() === "GET");
  await page.getByTestId("settings-tab-connections").click();
  await reload;
  await rows.nth(1).waitFor();
  assert.equal((await page.getByTestId("provider-assignment-default-select").innerText()).trim(), "Account 1");
  await page.getByTestId("provider-assignment-provider-claude").click();
  assert.match(await page.getByTestId("provider-exception-list").innerText(), /No exceptions/, "each provider has its own choices");
  await page.getByTestId("provider-assignment-provider-openai-codex").click();

  const project = rows.filter({ hasText: "Account 3" });
  await project.getByTestId("provider-exception-remove").click();
  await page.getByTestId("confirm-accept-button").click();
  await project.waitFor({ state: "detached" });

  await page.getByTestId("provider-profiles-tab-profiles").click();
  await page.getByTestId("provider-profile-provider-openai-codex").click();
  const sharing = page.getByTestId("provider-profile-row").filter({ hasText: "Account 2" });
  await sharing.getByTestId("provider-profile-sharing").click();
  await page.locator("#confirmDialog[open]").waitFor();
  assert.match(await page.locator("#confirmDialog").innerText(), /Every user on this node/);
  await page.getByTestId("confirm-accept-button").click();
  await page.getByTestId("provider-profile-row").filter({ hasText: "Account 2" }).filter({ hasText: "Shared for automation" }).waitFor();
  await page.getByTestId("provider-profiles-tab-assignments").click();
  const shared = rows.filter({ hasText: "Account 2" }).getByTestId("provider-exception-choice");
  assert.match(await shared.innerText(), /Account 2 — unavailable, choose another/);
  assert.match(await shared.getAttribute("class") ?? "", /invalid/);
  await page.getByTestId("provider-assignment-default-select").click();
  await page.getByTestId("provider-assignment-default-select-search").fill("Account 2");
  assert.equal(await page.getByTestId("provider-assignment-default-select-option").count(), 0);
});
