import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import type { Locator, Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function choose(page: Page | Locator, testid: string, search: string, label: string): Promise<void> {
  await page.getByTestId(testid).click();
  await page.getByTestId(`${testid}-search`).fill(search);
  await page.getByTestId(`${testid}-option`).filter({ hasText: label }).first().click();
}

test("subscription pools are built in their own tab, editable, testable, and cluster-scoped", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden" });
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-connections").click();
  await page.getByTestId("provider-profile-add").waitFor();

  const addProfile = async (provider: "claude" | "openai-codex", label: string) => {
    await page.getByTestId(`provider-profile-provider-${provider}`).click();
    await page.getByTestId("provider-profile-label").fill(label);
    await page.getByTestId("provider-profile-add").click();
    await page.getByTestId("provider-profile-row").filter({ hasText: label }).waitFor();
  };
  await addProfile("claude", "Claude work");
  await addProfile("openai-codex", "ChatGPT work");

  // A signed-in Claude profile offers Pi's Claude models (provider "anthropic") as fallbacks.
  const { profiles } = await page.evaluate(async () => (await fetch("/api/provider-profiles")).json()) as { profiles: Array<{ id: string; label: string }> };
  const claudeAuth = path.join(node.dataDir, "provider-profile-auth", profiles.find((item) => item.label === "Claude work")!.id, "auth.json");
  await mkdir(path.dirname(claudeAuth), { recursive: true, mode: 0o700 });
  await writeFile(claudeAuth, JSON.stringify({ anthropic: { type: "oauth", access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000 } }), { mode: 0o600 });
  await page.reload();
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-connections").click();
  await page.getByTestId("provider-profiles-tab-pools").click();
  assert.equal(await page.getByTestId("subscription-pool-form").count(), 0, "the editor stays closed until New pool");
  assert.equal(await page.getByTestId("provider-profile-row").count(), 0, "profile cards live on the Profiles tab");
  await page.getByTestId("subscription-pool-new").click();
  assert.equal(await page.getByTestId("subscription-pool-fallback-claude").count(), 0, "no switching model before a Claude member is chosen");
  await page.getByTestId("subscription-pool-name").fill("Team pool");
  await choose(page, "subscription-pool-member-0", "Claude work", "Claude work");
  assert.equal(await page.getByTestId("subscription-pool-fallback-openai-codex").count(), 0, "only providers in the pool get a switching model");
  assert.equal(await page.getByTestId("subscription-pool-name").inputValue(), "Team pool", "choosing a member keeps the typed name");

  // Pi's Claude models (provider "anthropic"), newest first, each listed once.
  await page.getByTestId("subscription-pool-fallback-claude").click();
  await page.getByTestId("subscription-pool-fallback-claude-option").filter({ hasText: /claude-/ }).first().waitFor();
  const listed = await page.getByTestId("subscription-pool-fallback-claude-option").evaluateAll((options) => options.map((option) => option.textContent ?? ""));
  await page.keyboard.press("Escape");
  const ids = listed.map((text) => text.match(/claude-[a-z0-9-]+/)?.[0]).filter((id): id is string => Boolean(id));
  assert.ok(ids.length > 3, `Claude models listed: ${listed.join(" | ")}`);
  assert.equal(listed.some((text) => text.includes("(latest)")), false, "alias labels drop Pi's (latest) suffix");
  assert.equal(ids.some((id) => /-\d{8}$/.test(id) && ids.includes(id.replace(/-\d{8}$/, ""))), false, "a dated snapshot is hidden when its alias is listed");
  const versions = ids.map((id) => (id.match(/\d+/g) ?? []).slice(0, 2).map(Number)).map(([major = 0, minor = 0]) => major * 100 + minor);
  assert.deepEqual(versions, [...versions].sort((left, right) => right - left), `newest first: ${ids.join(", ")}`);

  await page.getByTestId("subscription-pool-member-add").click();
  await choose(page, "subscription-pool-member-1", "ChatGPT work", "ChatGPT work");
  for (const provider of ["claude", "openai-codex"]) {
    await choose(page, `subscription-pool-fallback-${provider}`, "Enter model ID", "Enter model ID…");
    await page.getByTestId(`subscription-pool-fallback-${provider}-custom`).fill(`${provider}-fallback-test-model`);
  }
  const poolResponses: string[] = [];
  page.on("response", async (response) => { if (response.url().includes("/api/provider-profiles/pools")) poolResponses.push(`${response.request().method()} ${response.status()} ${await response.text()}`); });
  await page.getByTestId("subscription-pool-save").click();
  const pool = page.getByTestId("subscription-pool-card").filter({ hasText: "Team pool" });
  const toast = page.locator(".toast").last();
  const outcome = await Promise.race([
    pool.waitFor({ timeout: 5000 }).then(() => "pool").catch(() => "timeout"),
    toast.waitFor({ state: "visible", timeout: 5000 }).then(() => "toast").catch(() => "timeout"),
  ]);
  if (outcome === "toast") throw new Error(`Pool save error: ${await toast.innerText()}`);
  if (outcome !== "pool") throw new Error(`Pool creation failed: ui=${await page.getByTestId("subscription-pools").innerText()} requests=${poolResponses.join(",")} pageErrors=${pageErrors.join(" | ")}`);
  assert.match(await pool.innerText(), /Claude work[\s\S]*ChatGPT work/);
  assert.match(await pool.innerText(), /claude-fallback-test-model/);
  assert.match(await pool.innerText(), /openai-codex-fallback-test-model/);
  assert.match(await pool.innerText(), /Not used yet/);

  await pool.getByTestId("subscription-pool-test").click();
  const simulated = page.getByTestId("subscription-pool-simulation-result");
  await choose(page, "subscription-pool-simulation-model", "Claude", "Claude");
  assert.equal(await simulated.innerText(), "The next turn uses Claude work.");
  await page.getByTestId("subscription-pool-simulation-cards").locator("button").first().click();
  assert.equal(await simulated.innerText(), "The next turn uses ChatGPT work.");
  await page.getByTestId("subscription-pool-simulation-back").click();

  await pool.getByTestId("subscription-pool-edit").click();
  await page.getByTestId("subscription-pool-name").fill("Team pool edited");
  await page.getByTestId("subscription-pool-save").click();
  const editedPool = page.getByTestId("subscription-pool-card").filter({ hasText: "Team pool edited" });
  await editedPool.waitFor();
  const poolId = await editedPool.getAttribute("data-pool-id");
  assert.ok(poolId);

  await page.getByTestId("provider-profiles-tab-assignments").click();
  const defaultChoice = page.getByTestId("provider-assignment-default-select");
  // Nothing is chosen yet, and Claude work is the only Claude profile, so it is used automatically.
  assert.equal((await defaultChoice.innerText()).trim(), "Automatic: Claude work");
  assert.match(await page.getByTestId("provider-assignment-default").innerText(), /your only Claude profile, Claude work, is used/);
  await choose(page, "provider-assignment-default-select", "Team pool edited", "Team pool edited");
  await page.getByTestId("confirm-accept-button").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="provider-assignment-default-select"]')?.textContent?.trim() === "Team pool edited");

  const cookie = (await page.context().cookies(node.url)).map(({ name, value }) => `${name}=${value}`).join("; ");
  const createdCluster = await page.evaluate(async () => {
    const { api } = await import("/app/api.js");
    return api("/api/clusters", { method: "POST", body: JSON.stringify({ name: "Pool test cluster" }) });
  });
  assert.ok(createdCluster.snapshot);
  const clusters = await page.request.get(`${node.url}/api/clusters`, { headers: { cookie } });
  const cluster = (await clusters.json()).clusters.find((item: { name: string }) => item.name === "Pool test cluster");
  assert.ok(cluster);
  await page.getByTestId("settings-tab-account").click();
  await page.getByTestId("settings-tab-connections").click();
  await page.getByTestId("provider-profiles-tab-pools").click();
  assert.match(await editedPool.innerText(), /Used for My default \(Claude\)/);
  assert.equal(await editedPool.getByTestId("subscription-pool-delete").isDisabled(), true, "a pool in use cannot be deleted");
  // Cluster pools are part of the Pools tab.
  const clusterRow = page.locator('[data-testid="cluster-pool-row"]').filter({ hasText: "Pool test cluster" });
  await clusterRow.waitFor();
  const assignmentPath = `/api/clusters/${cluster.id}/subscription-pool`;
  const assignResponse = page.waitForResponse((response) => new URL(response.url()).pathname === assignmentPath && response.request().method() === "POST");
  await choose(clusterRow, "cluster-pool-select", "Team pool edited", "Team pool edited");
  await clusterRow.getByTestId("cluster-pool-save").click();
  await page.locator("#confirmDialog[open]").waitFor();
  assert.match(await page.locator("#confirmDialog").innerText(), /overrides.*personal/i);
  await page.getByTestId("confirm-accept-button").click();
  const assigned = await assignResponse;
  assert.equal(assigned.status(), 200, await assigned.text());
  const assignmentStatus = clusterRow.locator(".profile-status-detail");
  await assignmentStatus.waitFor();
  assert.match(await assignmentStatus.innerText(), /Assigned pool: Team pool edited/);
  // Assignments says the cluster's pool wins in its projects while personal choices cover the rest.
  await page.getByTestId("provider-profiles-tab-assignments").click();
  assert.match(await page.getByTestId("provider-assignment-cluster-note").innerText(), /Pool test cluster uses Team pool edited[\s\S]*every other project at the same time/);
  await page.getByTestId("provider-profiles-tab-pools").click();

  const clusterPicker = clusterRow.getByTestId("cluster-pool-select");
  await clusterPicker.click();
  await clusterRow.getByTestId("cluster-pool-select-search").fill("No pool");
  await clusterRow.getByTestId("cluster-pool-select-option").filter({ hasText: "No pool" }).click();
  assert.equal(await clusterPicker.getAttribute("data-value"), "");
  assert.equal(await clusterRow.getByTestId("cluster-pool-save").isEnabled(), true);
  const clearResponse = page.waitForResponse((response) => new URL(response.url()).pathname === assignmentPath && response.request().method() === "DELETE");
  await clusterRow.getByTestId("cluster-pool-save").click();
  await page.getByTestId("confirm-accept-button").click();
  const cleared = await clearResponse;
  assert.equal(cleared.status(), 200, await cleared.text());
  await assignmentStatus.waitFor({ state: "detached" });
  assert.match(await clusterRow.innerText(), /No pool assigned/);

  await page.getByTestId("provider-profiles-tab-assignments").click();
  const personalChoiceResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/provider-profiles/selection" && response.request().method() === "PUT");
  await choose(page, "provider-assignment-default-select", "Automatic", "Automatic: Claude work");
  await page.getByTestId("confirm-accept-button").click();
  const personalChoice = await personalChoiceResponse;
  assert.equal(personalChoice.status(), 200, await personalChoice.text());
  await page.waitForFunction(() => document.querySelector('[data-testid="provider-assignment-default-select"]')?.textContent?.trim() === "Automatic: Claude work");
  assert.equal(await page.getByTestId("provider-assignment-cluster-note").count(), 0, "no note once no cluster has a pool");
  const savedSelections = await (await page.request.get(`${node.url}/api/provider-profiles`)).json();
  assert.equal(savedSelections.selections.some((selection: { poolId?: string }) => selection.poolId === poolId), false);
  const savedClusters = await (await page.request.get(`${node.url}/api/clusters`)).json();
  assert.equal(savedClusters.clusters.some((item: { subscriptionPool?: { poolId: string } }) => item.subscriptionPool?.poolId === poolId), false);
  await page.getByTestId("provider-profiles-tab-pools").click();
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="subscription-pool-card"] [data-testid="subscription-pool-delete"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await editedPool.getByTestId("subscription-pool-delete").click();
  await page.getByTestId("confirm-accept-button").click();
  await editedPool.waitFor({ state: "detached" });
});
