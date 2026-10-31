import assert from "node:assert/strict";
import { test } from "node:test";
import type { Locator, Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function choose(page: Page | Locator, testid: string, search: string, label: string): Promise<void> {
  await page.getByTestId(testid).click();
  await page.getByTestId(`${testid}-search`).fill(search);
  await page.getByTestId(`${testid}-option`).filter({ hasText: label }).first().click();
}

test("subscription pools are searchable, selectable, editable, and cluster-scoped", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden" });
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-engines").click();
  await page.getByTestId("provider-profile-add").waitFor();

  const addProfile = async (provider: "claude" | "openai-codex", label: string) => {
    await page.getByTestId(`provider-profile-provider-${provider}`).click();
    await page.getByTestId("provider-profile-label").fill(label);
    await page.getByTestId("provider-profile-add").click();
    await page.getByTestId("provider-profile-row").filter({ hasText: label }).waitFor();
  };
  await addProfile("claude", "Claude work");
  await addProfile("openai-codex", "ChatGPT work");

  assert.equal(await page.getByTestId("subscription-pool-save").count(), 1, "pool controls should be in Settings → Harnesses");
  await page.getByTestId("subscription-pool-name").fill("Team pool");
  await choose(page, "subscription-pool-member-0", "Claude work", "Claude work");
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

  await pool.getByTestId("subscription-pool-edit").click();
  await page.getByTestId("subscription-pool-name").fill("Team pool edited");
  await page.getByTestId("subscription-pool-save").click();
  const editedPool = page.getByTestId("subscription-pool-card").filter({ hasText: "Team pool edited" });
  await editedPool.waitFor();
  const poolId = await editedPool.getAttribute("data-pool-id");
  assert.ok(poolId);

  const defaultRow = page.locator('[data-testid="provider-assignment-row"][data-scope="default"]');
  await choose(defaultRow, "provider-assignment-claude", "Team pool edited", "Team pool edited");
  await page.getByTestId("provider-assignments-save").click();
  await page.getByTestId("confirm-accept-button").click();
  await page.getByTestId("provider-assignments-pending").filter({ hasText: "All choices saved" }).waitFor();

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
  await page.getByTestId("settings-tab-engines").click();
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

  const assignment = defaultRow.getByTestId("provider-assignment-claude");
  await assignment.click();
  await defaultRow.getByTestId("provider-assignment-claude-search").fill("None");
  await defaultRow.getByTestId("provider-assignment-claude-option").filter({ hasText: "None" }).click();
  const personalChoiceResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/provider-profiles/selection" && response.request().method() === "PUT");
  await page.getByTestId("provider-assignments-save").click();
  await page.getByTestId("confirm-accept-button").click();
  const personalChoice = await personalChoiceResponse;
  assert.equal(personalChoice.status(), 200, await personalChoice.text());
  await page.waitForFunction(() => document.querySelector('[data-testid="provider-assignment-row"][data-scope="default"] [data-testid="provider-assignment-claude"]')?.textContent?.trim() === "None");
  const savedSelections = await (await page.request.get(`${node.url}/api/provider-profiles`)).json();
  assert.equal(savedSelections.selections.some((selection: { poolId?: string }) => selection.poolId === poolId), false);
  const savedClusters = await (await page.request.get(`${node.url}/api/clusters`)).json();
  assert.equal(savedClusters.clusters.some((item: { subscriptionPool?: { poolId: string } }) => item.subscriptionPool?.poolId === poolId), false);
  await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="subscription-pool-card"] [data-testid="subscription-pool-delete"]');
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await editedPool.getByTestId("subscription-pool-delete").click();
  await page.getByTestId("confirm-accept-button").click();
  await editedPool.waitFor({ state: "detached" });
});
