import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { isoDate } from "../../public/app/usage-periods.js";

async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(message);
}

async function login(page: any, environment: any, url: string): Promise<void> {
  await page.goto(url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByTestId("usage-open").waitFor();
}

test("usage dashboard edits subscription price and manual quota on desktop and mobile", { timeout: 240_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await login(page, environment, node.url);
  await page.getByTestId("usage-open").click();
  await page.getByTestId("usage-dialog").waitFor({ state: "visible" });
  await page.getByTestId("usage-summary").waitFor();
  await page.getByTestId("usage-breakdowns").getByRole("table").first().waitFor();
  assert.ok(await page.getByTestId("usage-breakdowns").getByRole("table").count() >= 1);
  const desktopBox = await page.getByTestId("usage-dialog").locator(".usage-card").boundingBox();
  assert.ok(desktopBox && desktopBox.width >= 900, "costs card must use desktop width");

  await page.getByTestId("usage-tab-subscriptions").click();
  assert.equal(await page.getByTestId("subscription-editor").getAttribute("open"), null);
  await page.getByTestId("subscription-add").click();
  await page.getByTestId("subscription-harness").selectOption("pi");
  await page.getByTestId("subscription-account-label").fill("Work account");
  await page.getByTestId("subscription-plan-name").fill("Max");
  await page.getByTestId("subscription-price").fill("200");
  await page.getByTestId("subscription-more").click();
  await page.getByTestId("quota-add").click();
  await page.getByTestId("quota-label").fill("Monthly messages");
  await page.getByTestId("quota-used").fill("25");
  await page.getByTestId("quota-limit").fill("100");
  await page.getByTestId("quota-reset").fill("2030-01-02T12:00");
  await page.getByTestId("subscription-save").click();
  const card = page.getByTestId("subscription-card").filter({ hasText: "Work account" });
  await card.getByText("$200/month", { exact: true }).waitFor();
  await card.getByText("75 remaining", { exact: false }).waitFor();
  await card.getByText("Manual snapshot", { exact: false }).waitFor();
  await card.getByText("resets", { exact: false }).waitFor();

  await card.getByTestId("subscription-edit").click();
  await page.getByTestId("subscription-price").fill("210");
  await page.getByTestId("subscription-save").click();
  await card.getByText("$210/month", { exact: true }).waitFor();

  await page.getByTestId("subscription-add").click();
  await page.getByTestId("subscription-harness").selectOption("claude");
  await page.getByTestId("subscription-account-label").fill("Second account");
  await page.getByTestId("subscription-plan-name").fill("Plus");
  await page.getByTestId("subscription-price").fill("20");
  await page.getByTestId("subscription-save").click();
  await page.getByTestId("subscription-card").filter({ hasText: "Second account" }).getByText("$20/month", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("subscription-card").count(), 2, "creating after editing must not overwrite the first plan");
  await card.getByText("$210/month", { exact: true }).waitFor();
  await page.locator(".subscription-harness-group").filter({ has: page.getByRole("heading", { name: "Pi", exact: true }) }).getByText("Work account").waitFor();
  await page.locator(".subscription-harness-group").filter({ has: page.getByRole("heading", { name: "Claude", exact: true }) }).getByText("Second account").waitFor();
  await page.getByTestId("usage-tab-overview").click();
  const classificationFilter = page.getByTestId("usage-classification-filter");
  if (await classificationFilter.locator("option").count() > 1) {
    await classificationFilter.selectOption({ index: 1 });
    assert.notEqual(await classificationFilter.inputValue(), "", "existing classification scopes usage");
  }
  await page.getByTestId("usage-close").click();
  await page.getByTestId("usage-open").click();
  await page.getByTestId("usage-tab-subscriptions").click();
  await card.getByText("$210/month", { exact: true }).waitFor();

  await card.getByTestId("subscription-edit").click();
  const optionalDetails = page.getByTestId("subscription-more");
  if (await optionalDetails.getAttribute("open") === null) await optionalDetails.click();

  for (const viewport of [{ width: 390, height: 500 }, { width: 520, height: 700 }]) {
    await page.setViewportSize(viewport);
    const usageCard = page.getByTestId("usage-dialog").locator(".usage-card");
    const box = await usageCard.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width && box.y >= 0 && box.y + box.height <= viewport.height);
    assert.equal(await usageCard.evaluate((element: HTMLElement) => element.scrollWidth <= element.clientWidth), true);

    let visibleControls = 0;
    for (const control of await page.getByTestId("subscription-editor").locator("input, select, button").all()) {
      if (!await control.isVisible()) continue;
      visibleControls += 1;
      const controlBox = await control.boundingBox();
      const cardBox = await usageCard.boundingBox();
      assert.ok(controlBox && cardBox && controlBox.x >= cardBox.x && controlBox.x + controlBox.width <= cardBox.x + cardBox.width);
    }
    assert.ok(visibleControls >= 5, `expected at least five visible editor controls at ${viewport.width}x${viewport.height}`);
    const save = page.getByTestId("subscription-save");
    await save.scrollIntoViewIfNeeded();
    assert.equal(await save.isVisible(), true);
  }
  assert.deepEqual(errors, []);
});

test("usage dashboard groups, filters by cluster, paginates, remains responsive, and preserves snapshots", { timeout: 240_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  const clusterId = "6f1f6a8e-2b0e-4c55-9f53-0d1b6e2a7c11";
  await page.route("**/api/clusters", async (route: any) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const local = body.clusters[0]?.members?.[0]?.nodeId ?? "local-node";
    body.clusters.push({ id: clusterId, name: "Usage cluster", originalNodeId: local, managerNodeId: local, managerEpoch: 1, closed: false, autoShareProjects: false, pendingDeliveries: 0,
      members: [{ clusterId, nodeId: "9b2c7d4e-5f60-4a1b-8c2d-3e4f5a6b7c8d", name: "Peer node", url: "http://127.0.0.1:9", autoShareProjects: false, joinSequence: 2 }] });
    await route.fulfill({ response, json: body });
  });
  await login(page, environment, node.url);

  const unbrokenTitle = "x".repeat(100);
  const conversations = Array.from({ length: 45 }, (_, index) => ({
    conversationId: `conversation-${index + 1}`,
    title: index === 20
      ? `Conversation ${index + 1}: ${unbrokenTitle}`
      : `Conversation ${index + 1}: a long descriptive discussion about preserving complete usage breakdown names`,
  }));
  const totals = (cost: number, requests = 2) => ({
    apiCostUsd: cost, partial: true, input: 100, output: 50, cacheRead: 10,
    cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0, totalTokens: 28413502076,
    pricedRequests: requests, requests, toolCalls: 1, toolErrors: 0, reasoning: 5,
    unavailableSessions: 0,
  });
  let updated = false;
  let gateRefresh = false;
  let releaseRefresh: (() => void) | undefined;
  let usageGets = 0;
  let lastPageSize = 0;
  const today = new Date();
  const dayRows = Array.from({ length: 130 }, (_, index) => ({
    key: isoDate(new Date(today.getFullYear(), today.getMonth(), today.getDate() - index)),
    totals: { ...totals(1), partial: false },
  })).reverse();
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });

  await page.route("**/api/usage**", async (route: any) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/usage/refresh") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }
    if (request.method() !== "GET" || url.pathname !== "/api/usage") return route.continue();
    usageGets += 1;
    if (gateRefresh) { await refreshGate; gateRefresh = false; updated = true; }
    const requestedPage = Number(url.searchParams.get("page") || 1);
    const size = Number(url.searchParams.get("pageSize") || 20);
    if (size > 1) lastPageSize = size;
    const start = (requestedPage - 1) * size;
    const visible = conversations.slice(start, start + size);
    const cost = updated ? 30 : 12;
    const body = {
      projects: [{ id: "project-internal-id", name: "Readable Project" }],
      conversations: visible,
      summary: totals(cost),
      breakdowns: {
        projects: [{ key: "project-internal-id", totals: totals(cost) }],
        conversations: visible.map((item, index) => ({ key: item.conversationId, totals: totals(index + 1, 1) })),
        classifications: [{ key: "feature", totals: totals(3) }],
        difficulties: [{ key: "10", totals: totals(1) }, { key: "3", totals: totals(3) }],
        models: [{ key: "model-a", totals: totals(10) }, { key: "model-b", totals: totals(2) }],
        days: dayRows,
      },
      conversationPagination: { page: requestedPage, pageSize: size, total: 45, totalPages: Math.ceil(45 / size) },
      coverage: { error: "", refreshing: updated, refreshedAt: "2025-06-16T12:00:00.000Z" },
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  const opener = page.getByTestId("usage-open");
  const focusOpener = page.getByTestId("focus-usage-open");
  for (const costsOpener of [opener, focusOpener]) {
    assert.equal(await costsOpener.getAttribute("data-shortcut-hint"), "costs");
    assert.equal((await costsOpener.textContent())?.includes("Costs"), false, "icon opener has no visible Costs text");
    assert.equal(await costsOpener.locator("svg").count(), 1);
  }
  assert.equal(await opener.getAttribute("aria-label"), "Costs", "icon opener has an accessible name");
  const iconBox = await opener.locator("svg").boundingBox();
  assert.ok(iconBox && iconBox.width > 0 && iconBox.height > 0, "costs icon has visible geometry");
  const openerBox = await opener.boundingBox();
  const settingsBox = await page.getByTestId("settings-open-button").boundingBox();
  assert.ok(openerBox && settingsBox && openerBox.width === settingsBox.width, "costs opener matches neighboring icon width");

  await page.keyboard.down("Control");
  await page.keyboard.down("Alt");
  const costsBadge = opener.locator(".shortcut-hint");
  await costsBadge.waitFor({ state: "visible" });
  assert.equal(await costsBadge.textContent(), "C");
  assert.ok((await costsBadge.getAttribute("title"))?.includes("C"), "costs badge title includes its key");
  await page.keyboard.up("Alt");
  await page.keyboard.up("Control");
  await costsBadge.waitFor({ state: "hidden" });

  const firstRequest = page.waitForRequest((request: any) => new URL(request.url()).pathname === "/api/usage");
  await page.keyboard.press("Control+Alt+Shift+C");
  const dialog = page.getByTestId("usage-dialog");
  const opened = new URL((await firstRequest).url()).searchParams;
  assert.equal(opened.get("from"), isoDate(new Date(today.getFullYear(), today.getMonth(), 1)), "the period starts on the first of this month");
  assert.equal(opened.get("utcOffset"), String(-today.getTimezoneOffset()), "dates are the viewer's local days");
  assert.equal(await dialog.getByTestId("usage-period-filter").inputValue(), "month");
  await dialog.waitFor({ state: "visible" });
  await dialog.locator("#usageTrend svg.usage-trend-line").waitFor();
  const firstStat = dialog.locator(".usage-stat strong").first();
  assert.equal(await firstStat.textContent(), "$12");
  assert.equal(await firstStat.locator(".usage-partial").getAttribute("aria-label"), "partial", "partial cost is marked, not spelled out");

  const breakdowns = page.getByTestId("usage-breakdowns");
  assert.equal(await dialog.locator('[data-testid="usage-dimension-projects"]').getAttribute("aria-pressed"), "true");
  await breakdowns.getByText("Readable Project", { exact: true }).waitFor();
  assert.equal(await breakdowns.getByText("project-internal-id", { exact: true }).count(), 0);
  await breakdowns.locator("[data-select]").first().click();
  const splitBar = dialog.locator("#usageTrend .usage-split-bar i");
  await splitBar.nth(1).waitFor();
  assert.equal(await splitBar.count(), 2, "the selected row splits its cost by model above the table");
  assert.equal(await breakdowns.locator("tr.selected").count(), 1);
  const segments = await splitBar.evaluateAll((items: HTMLElement[]) => items.map((item) => getComputedStyle(item).backgroundColor));
  assert.ok(segments.every((colour) => colour !== "rgba(0, 0, 0, 0)" && colour !== "transparent"), "model colours are defined");
  assert.notEqual(segments[0], segments[1]);
  await dialog.getByTestId("usage-split-close").click();
  await dialog.locator("#usageTrend svg.usage-trend-line").waitFor();
  assert.equal(await breakdowns.locator("tr.selected").count(), 0);

  await dialog.getByTestId("usage-dimension-models").click();
  const firstCell = () => breakdowns.locator("tbody tr").first().locator(".usage-name");
  assert.equal(await firstCell().textContent(), "model-a", "rows sort by cost, highest first");
  await breakdowns.locator('[data-sort="cost"]').click();
  assert.equal(await firstCell().textContent(), "model-b", "selecting Cost again reverses the order");
  await dialog.getByTestId("usage-dimension-difficulties").click();
  await breakdowns.locator('[data-sort="name"]').click();
  assert.deepEqual(await breakdowns.locator("tbody .usage-name").allTextContents(), ["Level 3", "Level 10"], "difficulty sorts numerically");

  const clusterTrigger = dialog.getByTestId("usage-cluster-filter-trigger");
  await clusterTrigger.waitFor();
  await clusterTrigger.click();
  const clusterRequest = page.waitForRequest((request: any) => new URL(request.url()).searchParams.get("clusters") === clusterId);
  const clusterOptions = await dialog.getByTestId("usage-cluster-filter-options").locator("[role='option']").all();
  for (const option of clusterOptions) {
    const parts = await option.evaluate((item: HTMLElement) => [...item.children].map((child) => {
      const box = child.getBoundingClientRect(), own = item.getBoundingClientRect();
      return box.top >= own.top - 0.5 && box.bottom <= own.bottom + 0.5 && child.scrollHeight <= child.clientHeight + 1;
    }));
    assert.ok(parts.every(Boolean), "each cluster option keeps its name and detail inside its own row");
  }
  await dialog.getByTestId("usage-cluster-filter-options").getByText("Usage cluster", { exact: true }).click();
  await clusterRequest;
  await dialog.locator("#usageTitle").click();
  await dialog.getByTestId("usage-clear-filters").waitFor();
  const clearedRequest = page.waitForRequest((request: any) => new URL(request.url()).pathname === "/api/usage" && !new URL(request.url()).searchParams.has("clusters"));
  await dialog.getByTestId("usage-clear-filters").click();
  await clearedRequest;

  await page.setViewportSize({ width: 1200, height: 800 });
  await dialog.getByTestId("usage-dimension-days").click();
  const dayTable = breakdowns.locator("tbody tr");
  const footer = dialog.locator(".usage-ledger-foot");
  await until(async () => (await dayTable.count()) > 3 && (await dayTable.count()) < 20, "days page to fit the table");
  const daysPerPage = await dayTable.count();
  assert.equal(await footer.locator("#usageRowCount").textContent(), `1–${daysPerPage} of 130 days`);
  assert.equal(await breakdowns.locator("tbody .usage-name").first().textContent(), dayRows.at(-1)!.key, "days start with the newest");
  await dialog.getByTestId("usage-page-next").click();
  assert.equal(await footer.locator("#usageRowCount").textContent(), `${daysPerPage + 1}–${daysPerPage * 2} of 130 days`, "every grouping pages, not only conversations");
  assert.equal(await breakdowns.locator("tbody .usage-name").first().textContent(), dayRows.at(-1 - daysPerPage)!.key);

  await dialog.getByTestId("usage-dimension-conversations").click();
  const conversationSection = page.getByTestId("usage-conversations-table");
  const rows = () => conversationSection.locator("tbody tr");
  const pagination = page.getByTestId("usage-pagination");
  await until(async () => lastPageSize > 0 && (await rows().count()) === lastPageSize, "conversation page to match the rows that fit");
  const perPage = lastPageSize;
  const pages = Math.ceil(45 / perPage);
  assert.ok(perPage >= 4 && perPage < 20, `about a screen of conversations per page, got ${perPage}`);
  await pagination.getByText(`Page 1 of ${pages}`).waitFor();
  await pagination.locator('[data-page="next"]').click();
  await pagination.getByText(`Page 2 of ${pages}`).waitFor();
  assert.equal(await rows().count(), perPage);
  for (let index = 2; index < pages; index++) await pagination.locator('[data-page="next"]').click();
  await pagination.getByText(`Page ${pages} of ${pages}`).waitFor();
  assert.equal(await rows().count(), 45 - (pages - 1) * perPage);
  await pagination.locator('[data-page="previous"]').click();
  await pagination.getByText(`Page ${pages - 1} of ${pages}`).waitFor();

  for (const viewport of [
    { width: 1100, height: 800 },
    { width: 800, height: 800 },
    { width: 1300, height: 600 },
    { width: 520, height: 700 },
    { width: 390, height: 520 },
  ]) {
    await page.setViewportSize(viewport);
    const fits = viewport.width > 700 && viewport.height >= 560;
    const card = dialog.locator(".usage-card");
    await until(async () => (await rows().count()) === lastPageSize, `rows to settle at ${viewport.width}x${viewport.height}`);
    if (fits) {
      await until(() => card.evaluate((element: HTMLElement) => element.scrollHeight <= element.clientHeight + 1), `the dialog fits without scrolling at ${viewport.width}x${viewport.height}`);
      await until(() => dialog.locator("#usageBreakdowns").evaluate((element: HTMLElement) => element.scrollHeight <= element.clientHeight + 1), `the page of rows fits its table at ${viewport.width}x${viewport.height}`);
      await until(async () => (await rows().count()) === lastPageSize, `rows to settle at ${viewport.width}x${viewport.height}`);
    } else {
      await until(async () => lastPageSize === 10 && (await rows().count()) === 10, `small screens page ten rows and scroll the dialog at ${viewport.width}px`);
    }
    const cardBox = await card.boundingBox();
    assert.ok(cardBox && cardBox.x >= 0 && cardBox.x + cardBox.width <= viewport.width);
    assert.equal(await card.evaluate((element: HTMLElement) => element.scrollWidth <= element.clientWidth), true);
    for (const region of await dialog.locator(".usage-toolbar, .usage-strip, .usage-ledger, .usage-breakdown").all()) {
      const box = await region.boundingBox();
      assert.ok(box && cardBox && box.x >= cardBox.x && box.x + box.width <= cardBox.x + cardBox.width + 1, `region fits the card at ${viewport.width}px`);
      assert.equal(await region.evaluate((element: HTMLElement) => element.scrollWidth <= element.clientWidth + 1), true, `no sideways scrolling at ${viewport.width}px`);
    }
    const clipped = await dialog.evaluate((element: HTMLElement) => [...element.querySelectorAll<HTMLElement>(".usage-breakdown td:not(:first-child), .usage-stat strong")]
      .filter((cell) => cell.scrollWidth > cell.clientWidth + 1).map((cell) => cell.textContent));
    assert.deepEqual(clipped, [], `numbers are never clipped at ${viewport.width}px`);
    const firstRow = rows().first();
    const key = await firstRow.locator("[data-select]").getAttribute("data-select");
    const expectedName = conversations.find((item) => item.conversationId === key)!.title;
    assert.equal(await firstRow.locator(".usage-name").textContent(), expectedName, "the complete conversation name remains in the cell");
    assert.equal(await firstRow.locator("td").first().getAttribute("title"), expectedName);
    if (viewport.width <= 700) {
      const tokensLabel = await firstRow.locator('td[data-label="Tokens"]').evaluate(
        (element: HTMLElement) => getComputedStyle(element, "::before").content,
      );
      assert.ok(tokensLabel.includes("Tokens"), `mobile numeric cell exposes its Tokens label at ${viewport.width}px`);
    }
  }

  await page.setViewportSize({ width: 1200, height: 800 });
  const compareRequest = page.waitForRequest((request: any) => new URL(request.url()).searchParams.get("pageSize") === "1" && new URL(request.url()).searchParams.get("from") === isoDate(new Date(today.getFullYear(), today.getMonth() - 3, 1)));
  await dialog.getByTestId("usage-tab-compare").click();
  assert.equal(new URL((await compareRequest).url()).searchParams.get("to"), isoDate(today), "compare reads the three months before this one");
  assert.equal(await dialog.getByTestId("usage-period-filter").isVisible(), false, "the period filter does not apply to comparisons");
  const month = dialog.getByTestId("usage-compare-month");
  await month.waitFor();
  const dayOfMonth = today.getDate();
  assert.equal(await month.getByTestId("usage-compare-month-value").textContent(), `$${dayOfMonth}`, "one dollar a day so far this month");
  assert.equal(await month.getByTestId("usage-compare-row").count(), 4, "this month and the three before it");
  const previousMonthLength = new Date(today.getFullYear(), today.getMonth(), 0).getDate();
  assert.equal(await month.getByTestId("usage-compare-row-value").nth(1).textContent(), `$${Math.min(dayOfMonth, previousMonthLength)}`, "last month through the same day");
  const week = dialog.getByTestId("usage-compare-week");
  const elapsed = Number((await week.locator("header p").textContent())!.match(/^Day (\d) of 7/)![1]);
  assert.equal(await week.getByTestId("usage-compare-week-value").textContent(), `$${elapsed}`);
  assert.deepEqual(await week.getByTestId("usage-compare-row-value").allTextContents(), Array(4).fill(`$${elapsed}`), "each earlier week through the same weekday");
  const hover = month.getByTestId("usage-compare-hover");
  const hoverBox = (await hover.boundingBox())!;
  await page.mouse.move(hoverBox.x + hoverBox.width / 2, hoverBox.y + hoverBox.height / 2);
  await month.locator(".usage-compare-tooltip:not([hidden])").waitFor();
  assert.equal(await month.locator(".usage-compare-tooltip span").count(), 4, "the hover lists every period");
  assert.equal(await dialog.locator(".usage-card").evaluate((element: HTMLElement) => element.scrollHeight <= element.clientHeight + 1), true, "the comparison fits without scrolling");
  await dialog.getByTestId("usage-tab-overview").click();

  gateRefresh = true;
  await page.locator("#usageRefresh").click();
  await page.getByText("Updating usage…", { exact: true }).waitFor();
  assert.equal(await firstStat.textContent(), "$12", "the previous snapshot stays while refreshing");
  if (page.clock?.install) await page.clock.install();
  releaseRefresh?.();
  await page.waitForFunction(() => document.querySelector(".usage-stat strong")?.textContent === "$30");
  await dialog.evaluate((element: HTMLDialogElement) => {
    (window as any).__usageCloseObserved = false;
    element.addEventListener("close", () => { (window as any).__usageCloseObserved = true; }, { once: true });
  });
  await page.getByTestId("usage-close").click();
  await page.waitForFunction(() => (window as any).__usageCloseObserved === true);
  if (page.clock?.fastForward) await page.clock.fastForward(0);
  const requestsAtClose = usageGets;
  if (page.clock?.fastForward) await page.clock.fastForward(10_000);
  await page.waitForFunction(() => true);
  assert.equal(usageGets, requestsAtClose, "closing the dashboard stops polling");
  assert.deepEqual(errors, []);
});

test("subscription prices save while a real usage read is blocked", { timeout: 240_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await login(page, environment, node.url);

  let releaseUsage: (() => void) | undefined;
  const usageGate = new Promise<void>((resolve) => {
    releaseUsage = resolve;
  });
  await page.route("**/api/usage?*", async (route: any) => {
    const request = route.request();
    const requestUrl = new URL(request.url());
    if (request.method() === "GET" && requestUrl.pathname === "/api/usage") await usageGate;
    await route.continue();
  });

  try {
    await page.getByTestId("usage-open").click();
    await page.getByTestId("usage-dialog").waitFor({ state: "visible" });
    await page.getByTestId("usage-tab-subscriptions").click();
    await page.getByTestId("subscription-add").click();
    await page.getByTestId("subscription-harness").selectOption("pi");
    await page.getByTestId("subscription-account-label").fill("Blocked usage account");
    await page.getByTestId("subscription-plan-name").fill("Concurrent");
    await page.getByTestId("subscription-price").fill("37");
    await page.getByTestId("subscription-save").click();

    const savedCard = page.getByTestId("subscription-card").filter({ hasText: "Blocked usage account" });
    await savedCard.getByText("$37/month", { exact: true }).waitFor();
  } finally {
    releaseUsage?.();
  }
});
