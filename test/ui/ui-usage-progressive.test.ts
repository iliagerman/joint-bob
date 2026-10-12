// The Costs dashboard must not leave a person staring at an empty page: totals show as soon as
// they are read, each grouping fills in when it arrives, one failed grouping does not blank the
// rest, and a background refresh is watched with a cheap status poll rather than full reloads.
import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { isoDate } from "../../public/app/usage-periods.js";

async function until(check: () => Promise<boolean> | boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(message);
}

test("totals show while a slow grouping is still loading, and a failed grouping leaves the rest in place", { timeout: 240_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByTestId("usage-open").waitFor();

  const totals = (cost: number, requests = 2) => ({
    apiCostUsd: cost, partial: false, input: 100, output: 50, cacheRead: 10, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0,
    totalTokens: 160, pricedRequests: requests, requests, toolCalls: 1, toolErrors: 0, reasoning: 5, unavailableSessions: 0,
  });
  const now = new Date();
  const lastDays = Array.from({ length: 5 }, (_, index) => ({ key: isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - index)), totals: totals(2) })).reverse();
  const rows: Record<string, unknown[]> = {
    projects: [{ key: "project-id", totals: totals(12) }],
    conversations: [{ key: "chat-1", totals: totals(12) }],
    classifications: [{ key: "feature", totals: totals(12) }],
    difficulties: [{ key: "3", totals: totals(12) }],
    models: [{ key: "model-a", totals: totals(12) }],
    days: lastDays,
  };
  let cost = 12, refreshing = false, revision = 1, failModels = true;
  let releaseProjects: (() => void) | undefined;
  let projectsGate: Promise<void> | null = new Promise<void>((resolve) => { releaseProjects = resolve; });
  const requested: string[] = [];
  let statusGets = 0;
  const json = (route: any, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

  await page.route("**/api/usage**", async (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/usage/status") { statusGets++; return json(route, { refreshing, refreshedAt: "2025-06-16T12:00:00.000Z", error: null, revision }); }
    if (url.pathname === "/api/usage/refresh") return json(route, {});
    if (request.method() !== "GET" || url.pathname !== "/api/usage") return route.continue();
    const section = url.searchParams.get("sections") || "";
    requested.push(section);
    if (section === "projects" && projectsGate) await projectsGate;
    if (section === "models" && failModels) return json(route, { error: "Models broke" }, 500);
    const coverage = { error: "", refreshing, refreshedAt: "2025-06-16T12:00:00.000Z", revision };
    const body: Record<string, unknown> = { projects: [{ id: "project-id", name: "Readable Project" }], breakdowns: {}, coverage };
    if (section === "summary") body.summary = totals(cost);
    else body.breakdowns = { [section]: rows[section] };
    if (section === "conversations") { body.conversations = [{ conversationId: "chat-1", title: "First chat", projectId: "project-id" }]; body.conversationPagination = { page: 1, pageSize: 10, total: 1, totalPages: 1 }; }
    await json(route, body);
  });

  await page.getByTestId("usage-open").click();
  const dialog = page.getByTestId("usage-dialog");
  await dialog.waitFor({ state: "visible" });
  const firstStat = dialog.locator(".usage-stat strong").first();
  const breakdowns = page.getByTestId("usage-breakdowns");

  // Totals and the trend are on screen while the open grouping is still being read.
  await firstStat.waitFor();
  assert.equal(await firstStat.textContent(), "$12");
  await dialog.locator("#usageTrend svg.usage-trend-line").waitFor();
  await breakdowns.getByText("Loading projects…", { exact: true }).waitFor();
  assert.equal(await breakdowns.getByText("Readable Project", { exact: true }).count(), 0);
  assert.equal(await dialog.locator('[data-testid="usage-dimension-projects"] small').textContent(), "…", "a grouping that has not arrived shows no count yet");
  await until(async () => (await dialog.locator('[data-testid="usage-dimension-days"] small').textContent()) === "5", "groupings that arrived show their count");
  assert.equal(requested[0], "summary", "totals are asked for first");
  assert.equal(requested[1], "projects", "then the grouping on screen");
  assert.deepEqual([...new Set(requested)].sort(), ["classifications", "conversations", "days", "difficulties", "models", "projects", "summary"], "each part is its own request");

  releaseProjects?.(); projectsGate = null;
  await breakdowns.getByText("Readable Project", { exact: true }).waitFor();
  assert.equal(await dialog.locator('[data-testid="usage-dimension-projects"] small').textContent(), "1");

  // One grouping failed: it says so, and everything else stays.
  await dialog.getByText("Models broke. Select Refresh usage to try again.", { exact: true }).waitFor();
  assert.equal(await firstStat.textContent(), "$12", "totals survive another grouping's failure");
  const before = requested.length;
  failModels = false;
  await dialog.getByTestId("usage-dimension-models").click();
  await breakdowns.locator(".usage-name", { hasText: "model-a" }).waitFor();
  assert.deepEqual(requested.slice(before), ["models"], "opening the failed grouping retries only that grouping");

  // A background refresh is watched through the status route; nothing is re-read until it changes.
  refreshing = true;
  await page.locator("#usageRefresh").click();
  await page.getByText("Refreshing transcripts in background…", { exact: true }).waitFor();
  const settled = requested.length;
  const polls = statusGets;
  await until(() => statusGets >= polls + 2, "the dashboard polls the status route while a refresh runs");
  assert.equal(requested.length, settled, "polling an unchanged ledger re-reads nothing");

  // The refresh finishes with new usage: the page reloads once and shows it.
  cost = 30; revision = 2; refreshing = false;
  await page.waitForFunction(() => document.querySelector(".usage-stat strong")?.textContent === "$30");
  await page.getByText(/^Usage refreshed /).waitFor();
  const afterReload = requested.length;
  const afterPolls = statusGets;
  await new Promise((resolve) => setTimeout(resolve, 2600));
  assert.equal(requested.length, afterReload, "nothing is re-read once the refresh is over");
  assert.equal(statusGets, afterPolls, "and the status polling stops");
  assert.deepEqual(errors, []);
});
