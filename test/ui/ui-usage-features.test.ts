import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { reportClusterId, seedUsageAnalysis } from "../usage-analysis-fixture.js";

test("Cluster and Repeated work use local selectors, not conflicting global filters", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  seedUsageAnalysis(node);
  // The ledger fixture grants a real report scope; no membership handshake is needed here.
  await page.route("**/api/clusters", (route) => route.fulfill({ json: { clusters: [{
    id: reportClusterId, name: "Analysis cluster", originalNodeId: node.nodeId, managerNodeId: node.nodeId,
    managerEpoch: 1, closed: false, autoShareProjects: false, pendingDeliveries: 0,
    members: [{ clusterId: reportClusterId, nodeId: node.nodeId, name: "Fixture node", url: node.url, autoShareProjects: false, joinSequence: 1 }],
  }] } }));
  const errors: string[] = [], reports: URL[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => { if (request.url().includes(`/clusters/${reportClusterId}/report`)) reports.push(new URL(request.url())); });
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByTestId("usage-open").click();
  await page.locator('#usageFilters [name="projectId"]').selectOption(node.projects[1].id);
  await page.locator('#usageFilters [name="difficulty"]').selectOption("10");
  await page.getByTestId("usage-tab-insights").click();
  await page.getByTestId("usage-insight-view-cluster").click();
  assert.equal(await page.getByTestId("usage-cluster-controls").count(), 1, "Cluster needs its own visible selectors");
  assert.equal(await page.locator("#usageFilters").isVisible(), false, "unrelated global filters must be hidden");
  assert.equal(await page.getByTestId("usage-insight-stats").isVisible(), false, "global totals must not look like cluster totals");
  await page.getByTestId("usage-cluster-cluster").selectOption(reportClusterId);
  await page.getByTestId("usage-cluster-period").selectOption("all");
  await page.getByTestId("usage-insight-cluster").getByText(node.projects[0].name, { exact: true }).waitFor();
  const controlsBox = await page.getByTestId("usage-cluster-controls").boundingBox();
  const bodyBox = await page.getByTestId("usage-insight-body").boundingBox();
  assert.ok(controlsBox && controlsBox.height < 180, `controls must not take the table's flexible height: ${controlsBox?.height}`);
  assert.ok(bodyBox && bodyBox.height >= 300, `cluster results retain room for paging: ${bodyBox?.height}`);
  const projects = page.getByTestId("usage-cluster-project");
  assert.deepEqual(await projects.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)), ["", node.projects[0].id], "only cluster-shared projects are selectable");
  assert.ok(reports.length > 0);
  for (const url of reports) {
    assert.equal(url.searchParams.has("projectId"), false);
    assert.equal(url.searchParams.has("difficulty"), false);
    assert.equal(url.searchParams.has("clusters"), false);
  }

  await projects.selectOption(node.projects[0].id);
  await page.getByTestId("usage-cluster-period").selectOption("custom");
  await page.getByTestId("usage-cluster-from").fill("2025-01-01");
  await page.getByTestId("usage-cluster-to").fill("2025-01-01");
  await page.getByTestId("usage-cluster-refresh").click();
  await page.getByTestId("usage-insight-cluster").getByTestId("usage-insight-row").filter({ hasText: node.projects[0].name }).locator("td").nth(2).getByText(/105/).waitFor();
  assert.equal(reports.at(-1)?.searchParams.get("projectId"), node.projects[0].id);
  assert.equal(reports.at(-1)?.searchParams.get("from"), "2025-01-01");
  await page.getByTestId("usage-cluster-period").selectOption("all");

  await page.getByTestId("usage-insight-view-flows").click();
  await page.getByTestId("usage-flows-project").selectOption(node.projects[0].id);
  await page.getByTestId("usage-flows-period").selectOption("custom");
  await page.getByTestId("usage-flows-from").fill("2025-01-01");
  await page.getByTestId("usage-flows-to").fill("2025-01-01");
  await page.getByTestId("usage-flows-limit").selectOption("25");
  await page.getByTestId("usage-analysis").click();
  await page.getByTestId("usage-analysis-results").getByText("25 of 105", { exact: false }).waitFor();
  await page.getByTestId("usage-analysis-run").click();
  await page.getByTestId("usage-analysis-results").getByText("Repeated flow 1 (25 conversations)", { exact: false }).waitFor();
  await page.getByTestId("usage-flows-limit").selectOption("50");
  assert.equal(await page.getByTestId("usage-analysis-results").textContent(), "", "changing local scope discards old preview and results");
  await page.getByTestId("usage-insight-view-cluster").click();
  assert.equal(await page.getByTestId("usage-cluster-period").inputValue(), "all");
  await page.getByTestId("usage-insight-view-flows").click();
  assert.equal(await page.getByTestId("usage-flows-limit").inputValue(), "50");
  await page.getByTestId("usage-tab-overview").click();
  assert.equal(await page.locator("#usageFilters").isVisible(), true);
  assert.equal(await page.locator('#usageFilters [name="projectId"]').inputValue(), node.projects[1].id);
  assert.equal(await page.locator('#usageFilters [name="difficulty"]').inputValue(), "10");
  await page.locator('#usageFilters [name="projectId"]').selectOption(node.projects[2].id);
  await page.locator('#usageFilters [name="difficulty"]').selectOption("1");
  await page.getByTestId("usage-tab-insights").click();
  assert.equal(await page.getByTestId("usage-flows-limit").inputValue(), "50");

  // A preview arriving after its scope changed must not restore an obsolete Run button.
  let releasePreview!: () => void;
  const previewGate = new Promise<void>((resolve) => { releasePreview = resolve; });
  await page.route("**/api/usage/analysis/preview?*", async (route) => {
    const response = await route.fetch();
    await previewGate;
    await route.fulfill({ response });
  });
  const pendingPreview = page.waitForRequest((request) => request.url().includes("/analysis/preview?"));
  await page.getByTestId("usage-analysis").click();
  await pendingPreview;
  await page.getByTestId("usage-flows-limit").selectOption("25");
  const previewReply = page.waitForResponse((response) => response.url().includes("/analysis/preview?"));
  releasePreview();
  await (await previewReply).finished();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByTestId("usage-analysis-results").textContent(), "", "stale preview stays discarded");
  await page.unroute("**/api/usage/analysis/preview?*");

  await page.getByTestId("usage-analysis").click();
  await page.getByTestId("usage-analysis-run").waitFor();
  let releaseAnalysis!: () => void;
  const analysisGate = new Promise<void>((resolve) => { releaseAnalysis = resolve; });
  await page.route("**/api/usage/analysis", async (route) => {
    const response = await route.fetch();
    await analysisGate;
    await route.fulfill({ response });
  });
  const pendingAnalysis = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/usage/analysis");
  await page.getByTestId("usage-analysis-run").click();
  await pendingAnalysis;
  await page.getByTestId("usage-flows-project").selectOption(node.projects[1].id);
  const analysisReply = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/usage/analysis");
  releaseAnalysis();
  await (await analysisReply).finished();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByTestId("usage-analysis-results").textContent(), "", "stale analysis must not show evidence or drafts for another project");

  // Local selections survive closing, while old previews and results do not.
  await page.getByTestId("usage-close").click();
  await page.getByTestId("usage-open").click();
  await page.getByTestId("usage-tab-insights").click();
  assert.equal(await page.getByTestId("usage-flows-project").inputValue(), node.projects[1].id);
  assert.equal(await page.getByTestId("usage-analysis-results").textContent(), "");
  for (const view of ["flows", "cluster"]) {
    await page.getByTestId(`usage-insight-view-${view}`).click();
    await page.setViewportSize({ width: 390, height: 650 });
    const controls = page.getByTestId(`usage-${view}-controls`);
    assert.equal(await controls.evaluate((element) => element.scrollWidth <= element.clientWidth), true, `${view} controls fit mobile width`);
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  assert.deepEqual(errors, []);
});
