import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function configure(card: Locator, provider: string, key: string) {
  await card.getByTestId("pi-profile-provider-picker").click();
  await card.getByTestId("pi-profile-provider-picker-search").fill(provider);
  await card.getByTestId("pi-profile-provider-picker-option").filter({ hasText: provider === "zai" ? "Z.AI" : "OpenAI" }).first().click();
  await card.getByTestId("pi-profile-provider-method").selectOption("api_key");
  await card.getByTestId("pi-profile-provider-connect").click();
  await card.getByTestId("provider-profile-login-answer").fill(key);
  await card.getByTestId("provider-profile-login-continue").click();
  try {
    await card.getByTestId("pi-profile-connected-provider").filter({ hasText: provider === "zai" ? "Z.AI" : "OpenAI" }).waitFor();
  } catch (error) {
    throw new Error(`Provider setup did not render: ${await card.innerText()}`, { cause: error });
  }
}

test("Pi profiles configure multiple providers together or keep single-provider accounts separate", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden" });
  await page.locator(".project-card").first().waitFor();
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-engines").click();
  await page.getByTestId("provider-profile-provider-pi").click();
  const add = async (label: string) => {
    await page.getByTestId("provider-profile-label").fill(label);
    await page.getByTestId("provider-profile-add").click();
    const card = page.getByTestId("provider-profile-row").filter({ hasText: label });
    await card.waitFor();
    await card.getByTestId("pi-profile-providers-toggle").click();
    await card.getByTestId("pi-profile-provider-picker").waitFor();
    return card;
  };
  const multi = await add("Multi provider");
  await configure(multi, "zai", "fixture-multi-zai");
  await configure(multi, "openai", "fixture-multi-openai");
  assert.equal(await multi.getByTestId("pi-profile-connected-provider").count(), 2);
  assert.doesNotMatch(await multi.innerText(), /fixture-multi/);
  const one = await add("Single z.ai");
  await configure(one, "zai", "fixture-single-zai");
  const two = await add("Single OpenAI");
  await configure(two, "openai", "fixture-single-openai");
  await page.reload();
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-engines").click();
  const restored = page.getByTestId("provider-profile-row").filter({ hasText: "Multi provider" });
  await restored.getByTestId("pi-profile-providers-toggle").click();
  const zai = restored.getByTestId("pi-profile-connected-provider").filter({ hasText: "Z.AI" });
  await zai.getByTestId("pi-profile-provider-disconnect").click();
  await page.getByTestId("confirm-accept-button").click();
  await zai.waitFor({ state: "detached" });
  assert.equal(await restored.getByTestId("pi-profile-connected-provider").count(), 1);
  assert.match(await restored.getByTestId("pi-profile-connected-provider").innerText(), /OpenAI/);
  await page.getByTestId("provider-profile-row").filter({ hasText: "Single z.ai" }).getByTestId("pi-profile-providers-toggle").click();
  await page.getByTestId("provider-profile-row").filter({ hasText: "Single z.ai" }).getByTestId("pi-profile-connected-provider").filter({ hasText: "Z.AI" }).waitFor();
});
