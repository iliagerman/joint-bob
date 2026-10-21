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
  await page.waitForFunction(async () => {
    const { state } = await import("/app/state.js");
    return state.preferencesLoaded && state.harnesses.some((harness) => harness.id === "pi" && harness.label === "Pi");
  });
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
    if (request.method() === "GET" && url.pathname === "/api/usage/days") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ days: dayRows, coverage: { missing: 0, refreshing: false, refreshedAt: "2025-06-16T12:00:00.000Z" } }) });
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
    assert.equal(await costsOpener.locator("svg").count(), 1);
  }
  assert.equal((await opener.textContent())?.includes("Costs"), false, "toolbar icon opener has no visible Costs text");
  assert.equal((await focusOpener.textContent())?.includes("Costs"), true, "mobile controls label Costs like their neighbors");
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
  assert.equal(await costsBadge.textContent(), "⇧C");
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
    // Skills & time has a strip and a ledger of its own, hidden while the overview is open.
    for (const region of await dialog.locator(".usage-toolbar:visible, .usage-strip:visible, .usage-ledger:visible, .usage-breakdown:visible").all()) {
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
  const compareRequest = page.waitForRequest((request: any) => new URL(request.url()).pathname === "/api/usage/days" && new URL(request.url()).searchParams.get("from") === isoDate(new Date(today.getFullYear(), today.getMonth() - 3, 1)));
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
  await hover.hover();
  await month.locator(".usage-compare-tooltip:not([hidden])").waitFor();
  assert.equal(await month.locator(".usage-compare-tooltip span").count(), 4, "the hover lists every period");
  assert.equal(await dialog.locator(".usage-card").evaluate((element: HTMLElement) => element.scrollHeight <= element.clientHeight + 1), true, "the comparison fits without scrolling");
  await dialog.getByTestId("usage-tab-overview").click();
  await page.locator('#usageRefresh:enabled').waitFor();

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

test("skills and time reads the seeded node's reports, by day and hour, and asks before local analysis", { timeout: 240_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await login(page, environment, node.url);
  await page.getByTestId("usage-open").click();
  const dialog = page.getByTestId("usage-dialog");
  await dialog.getByTestId("usage-tab-insights").click();
  await dialog.getByTestId("usage-insight-stats").getByText("Skills used").waitFor();
  const body = dialog.getByTestId("usage-insight-body");
  await body.getByText(/No agent loaded a skill|No usage in this scope/).or(body.getByTestId("usage-insight-row").first()).waitFor();
  await dialog.getByTestId("usage-insight-view-unused").click();
  await body.getByText("Every installed skill was loaded in this period.").or(body.getByTestId("usage-insight-row").first()).waitFor();
  for (const view of ["days", "hours"]) {
    await dialog.getByTestId(`usage-insight-view-${view}`).click();
    await body.getByText("No requests in this period.").or(body.getByTestId("usage-insight-row").first()).waitFor();
  }
  assert.equal(await dialog.getByTestId("usage-insight-view-cluster").count(), 0, "a node in no cluster has no cluster report to offer");
  await dialog.getByTestId("usage-insight-view-flows").click();
  await dialog.getByTestId("usage-analysis").click();
  assert.equal(await dialog.getByTestId("usage-flows-project").evaluate((select: HTMLSelectElement) => select.validity.valueMissing), true);
  assert.equal(await dialog.getByTestId("usage-analysis-run").count(), 0, "analysis requires a project in its own controls");
  await dialog.getByTestId("usage-flows-project").selectOption(node.projects[0].id);
  await dialog.getByTestId("usage-analysis").click();
  await dialog.getByTestId("usage-analysis-run").waitFor();
  await dialog.getByTestId("usage-analysis-run").click();
  await dialog.getByTestId("usage-analysis-results").getByText(/No repeated title patterns|candidate/).first().waitFor();
  assert.deepEqual(errors, []);
});

test("skills and time lists one row per skill, says what stands out, and pages instead of scrolling", { timeout: 240_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await login(page, environment, node.url);

  const skill = (name: string, turns: number, overrides: Record<string, unknown> = {}) => ({
    id: name, name, version: "unknown", associatedTurns: turns, observedReads: turns, explicitInvocations: 0, conversations: Math.ceil(turns / 2),
    associatedRequests: turns * 20, pricedRequests: turns * 20, apiEquivalentCostUsd: turns * 2, toolCalls: turns * 10, toolErrors: Math.round(turns / 2),
    medianDurationMs: 60_000, timedTurns: turns, firstUsedAt: "2026-10-01T08:00:00.000Z", lastUsedAt: "2026-10-12T08:00:00.000Z",
    models: [{ modelId: "model-one", requests: turns * 15, toolErrors: 0, knownCostUsd: turns * 1.5 }, { modelId: "model-two", requests: turns * 5, toolErrors: 0, knownCostUsd: turns * 0.5 }],
    tokens: { input: turns * 1000, output: turns * 500, cacheRead: turns * 9000, cacheWrite: 0, reasoning: 0 }, p90DurationMs: 120_000,
    engines: [{ engine: "pi", turns }], projects: [{ projectId: "p1", turns, conversations: Math.ceil(turns / 2), knownCostUsd: turns * 2 }],
    daily: [{ key: "2026-10-10", turns: Math.ceil(turns / 2), knownCostUsd: turns }, { key: "2026-10-12", turns: Math.floor(turns / 2), knownCostUsd: turns }],
    topConversations: [{ projectId: "p1", conversationId: "c1", turns, knownCostUsd: turns * 2 }], ...overrides,
  });
  const skills = {
    skills: [
      skill("ponytail", 118, { explicitInvocations: 4 }), skill("caveman", 100),
      skill("flaky", 12, { toolCalls: 120, toolErrors: 30 }), skill("slow", 9, { medianDurationMs: 600_000 }),
      ...Array.from({ length: 20 }, (_, index) => skill(`skill-${String(index + 1).padStart(2, "0")}`, 3)),
    ],
    scopeRequests: 10_000, unattributedRequests: 4000,
    withSkill: { turns: 300, requests: 6000, pricedRequests: 6000, costUsd: 600, toolCalls: 3000, toolErrors: 150, timedTurns: 280, medianDurationMs: 120_000 },
    withoutSkill: { requests: 4000, pricedRequests: 4000, costUsd: 400, toolCalls: 2000, toolErrors: 100 },
    turnTiming: { timedTurns: 500, medianDurationMs: 60_000 }, coverage: { missing: 3 },
    projectNames: { p1: "Billing" }, conversationTitles: { c1: "Fix the invoice export" },
  };
  const installed = [
    { name: "ponytail", description: "Write less code", origin: "user", path: "/skills/ponytail", harnesses: ["pi"] },
    { name: "never-loaded", description: "A skill nobody loads", origin: "user", path: "/skills/never-loaded", harnesses: ["pi"] },
    { name: "idle-too", description: "Also idle", origin: "shared", path: "/skills/idle-too", harnesses: ["claude", "pi"] },
  ];
  const day = (apiCostUsd: number, requests: number, partial = false) => ({ apiCostUsd, requests, partial });
  let timingFails = false;
  const hourRequests: string[] = [];
  await page.route("**/api/usage/skills?*", (route: any) => route.fulfill({ json: skills }));
  await page.route("**/api/usage/skills/content?*", (route: any) => new URL(route.request().url()).searchParams.get("name") === "ponytail"
    ? route.fulfill({ json: { name: "ponytail", description: "Write less code", origin: "user", harnesses: ["pi"], copies: [{ origin: "user", harnesses: ["pi"] }], path: "/skills/ponytail", content: "---\nname: ponytail\n---\nWrite less code.", truncated: false, bytes: 40, lines: 4, modifiedAt: "2026-10-01T00:00:00.000Z", files: ["scripts/"] } })
    : route.fulfill({ status: 404, json: { error: "That skill is not installed on this node" } }));
  await page.route("**/api/resources/inventory*", (route: any) => route.fulfill({ json: { nodes: [{ node: { id: "this", name: "This", local: true, online: true }, inventory: { skills: installed, mcpServers: [], harnesses: [] } }] } }));
  await page.route("**/api/usage/timing?*", (route: any) => timingFails ? route.fulfill({ status: 500, json: { error: "Timing broke" } }) : route.fulfill({ json: {
    days: [
      { key: "2026-10-11", turns: 58, failed: 0, medianAgentMs: 112_000, medianQueueMs: null, medianToolMs: 1000, toolTimedRequests: 1272, toolRequestsUnknown: 4 },
      { key: "2026-10-12", turns: 101, failed: 2, medianAgentMs: 57_000, medianQueueMs: 2000, medianToolMs: 1000, toolTimedRequests: 1805, toolRequestsUnknown: 9 },
    ],
    totals: { turns: 159, failed: 2, medianAgentMs: 74_000, medianQueueMs: 2000, medianToolMs: 1000 }, unknownHistoricalTiming: 3998,
  } }));
  await page.route("**/api/usage/days?*", (route: any) => {
    const hourly = new URL(route.request().url()).searchParams.get("bucket") === "hour";
    if (hourly) hourRequests.push(route.request().url());
    return route.fulfill({ json: { coverage: { missing: 0, refreshedAt: null, refreshing: false }, days: hourly
      ? [{ key: "2026-10-11T09+03:00", totals: day(10, 100) }, { key: "2026-10-12T09+03:00", totals: day(30, 200) }, { key: "2026-10-12T22+03:00", totals: day(60, 300) }]
      : [{ key: "2026-10-11", totals: day(113.93, 1345, true) }, { key: "2026-10-12", totals: day(254.46, 1965) }] } });
  });

  await page.getByTestId("usage-open").click();
  const dialog = page.getByTestId("usage-dialog");
  await dialog.getByTestId("usage-tab-insights").click();
  const body = dialog.getByTestId("usage-insight-body");
  const rows = body.getByTestId("usage-insight-row");
  const names = () => rows.locator(".usage-name").allTextContents();
  await rows.first().waitFor();
  await dialog.getByTestId("usage-insight-stats").getByText("3 installed here").waitFor();

  const stats = dialog.getByTestId("usage-insight-stats").locator(".usage-stat");
  assert.deepEqual(await stats.locator("strong").allTextContents(), ["24", "300", "$600", "5.0%", "1m 00s", "2"]);
  assert.deepEqual(await stats.locator("small").allTextContents(), ["3 installed here", "60% of requests", "60% of $1,000", "5.0% without a skill", "2m 00s with a skill", "of 159 turns · 2s queued"]);
  const findings = dialog.getByTestId("usage-finding");
  assert.deepEqual(await findings.locator(".usage-finding-kind").allTextContents(), ["Most used", "Fails more", "Slower", "Not used"]);
  assert.equal(await findings.nth(1).locator(".usage-finding-text").textContent(), "25% of tool calls fail in turns that load flaky, against 5.0% across all turns with a skill.");

  // One row per skill, most used first; the list pages, and neither it nor the dialog scrolls.
  assert.deepEqual((await names()).slice(0, 4), ["ponytail", "caveman", "flaky", "slow"]);
  assert.equal(await page.evaluate(async () => (await import('/app/state.js')).state.harnesses.find((harness) => harness.id === 'pi')?.label), "Pi", "the loaded harness metadata supplies Pi's display name");
  assert.equal(await rows.first().locator(".usage-name-detail").textContent(), "59 conversations · Pi · typed 4×");
  assert.deepEqual(await body.locator("thead th").allTextContents(), ["Skill", "Turns", "Of skill turns", "Trend", "Cost", "Per turn", "Requests", "Tokens", "Cache", "Failed tools", "Median turn", "Projects", "Last used"]);
  assert.deepEqual(await rows.first().locator("td").allTextContents(), ["ponytail59 conversations · Pi · typed 4×", "118", "39%", "", "$236", "$2", "2,360", "1.24M", "90%", "5.0%", "1m 00s", "1", "Oct 12"]);
  const shown = await rows.count();
  assert.ok(shown >= 3 && shown < 24, `the list pages to what fits: ${shown} rows`);
  assert.equal(await dialog.locator("#usageInsightCount").textContent(), `1–${shown} of 24 skills`);
  assert.equal(await dialog.locator("#usageInsightSort").textContent(), "Sorted by turns, highest first");
  const overflow = () => dialog.evaluate((element: HTMLElement) => {
    const host = element.querySelector("#usageInsightBody") as HTMLElement, card = element.querySelector(".usage-card") as HTMLElement;
    const last = [...host.querySelectorAll("tbody tr")].at(-1)!.getBoundingClientRect(), box = host.getBoundingClientRect();
    return { card: card.scrollHeight - card.clientHeight, cutOff: last.bottom - box.bottom };
  });
  assert.deepEqual(await overflow().then((over: { card: number; cutOff: number }) => [over.card <= 1, over.cutOff <= 1]), [true, true], "the dialog does not scroll and the last row is whole");
  await page.setViewportSize({ width: 1100, height: 700 });
  await until(async () => (await rows.count()) < shown, "a shorter window shows fewer rows");
  await until(async () => { const over = await overflow(); return over.card <= 1 && over.cutOff <= 1; }, "the shorter window still fits without scrolling");
  await page.setViewportSize({ width: 1440, height: 900 });
  await until(async () => (await rows.count()) === shown, "the rows return with the height");
  await dialog.getByTestId("usage-insight-page-next").click();
  assert.ok(!(await names()).includes("ponytail"), "the next page shows other skills");
  assert.match(await dialog.getByTestId("usage-insight-pagination").locator("span").textContent() ?? "", /^Page 2 of \d+$/);

  // A finding opens the skill's own page, which replaces the totals while it is open.
  await findings.nth(1).click();
  const detail = dialog.getByTestId("usage-skill-detail");
  await detail.getByRole("heading", { name: "flaky" }).waitFor();
  assert.equal(await dialog.getByTestId("usage-insight-stats").isVisible(), false);
  const tiles = detail.locator(".usage-skill-tiles .usage-stat");
  assert.deepEqual(await tiles.locator("span").allTextContents().then((labels: string[]) => labels.slice(0, 8)), ["Turns", "Conversations", "Requests", "Cost", "Cost per turn", "Tokens", "Cache read", "Failed tools"]);
  assert.deepEqual(await tiles.locator("strong").allTextContents().then((values: string[]) => values.slice(0, 8)), ["12", "6", "240", "$24", "$2", "126.0K", "90%", "25%"]);
  assert.equal(await tiles.nth(7).locator("small").textContent(), "30 of 120 calls · 5.0% across all skill turns");
  await detail.getByText("Fix the invoice export").waitFor();
  await detail.getByText("Billing").first().waitFor();
  assert.deepEqual(await detail.locator(".usage-split-legend span").allTextContents(), ["model-one", "model-two"]);
  assert.equal(await detail.locator(".usage-skill-chart rect").count(), 3, "two days of use and the empty day between them");
  await detail.getByTestId("usage-skill-tab-contents").click();
  await detail.getByText("That skill is not installed on this node").waitFor();
  await detail.getByTestId("usage-skill-back").click();
  assert.equal(await dialog.getByTestId("usage-insight-stats").isVisible(), true);
  await rows.filter({ hasText: "ponytail" }).first().locator("[data-select]").click();
  await detail.getByTestId("usage-skill-tab-contents").click();
  await detail.getByTestId("usage-skill-text").getByText("Write less code.").waitFor();
  assert.match(await detail.locator(".usage-skill-meta").textContent() ?? "", /4 lines · 0\.0 KB/);
  assert.match(await detail.locator(".usage-source").textContent() ?? "", /Beside it: scripts\//);
  await detail.getByTestId("usage-skill-back").click();
  await dialog.getByText("Select a skill for its statistics and contents.").waitFor();

  await body.locator('[data-sort="cost"]').click();
  assert.equal((await names())[0], "ponytail");
  await body.locator('[data-sort="cost"]').click();
  assert.equal((await names())[0], "skill-01", "ascending, ties in name order");
  assert.equal(await dialog.locator("#usageInsightSort").textContent(), "Sorted by cost, lowest first");

  await dialog.getByTestId("usage-insight-view-unused").click();
  assert.deepEqual(await names(), ["idle-too", "never-loaded"]);
  assert.deepEqual(await rows.first().locator("td").allTextContents(), ["idle-too", "Also idle", "Managed", "Claude, Pi"]);

  await dialog.getByTestId("usage-insight-view-days").click();
  assert.deepEqual((await rows.first().locator("td").allTextContents()).map((text: string) => text.trim()).slice(1), ["$254.46", "69%", "1,965", "101", "2", "57s", "2s", "1s"]);
  assert.match((await names())[0], /Oct 12/, "latest day first");
  assert.equal(await rows.nth(1).locator(".usage-partial").count(), 1, "a day with unpriced requests is marked as a lower bound");
  assert.equal(await rows.nth(1).locator("td").nth(7).textContent(), "—", "no queue time was recorded that day");
  await dialog.getByTestId("usage-insight-focus").getByText("Daily cost").waitFor();

  assert.equal(hourRequests.length, 0, "hours are read only when asked for");
  await dialog.getByTestId("usage-insight-view-hours").click();
  await rows.first().waitFor();
  assert.deepEqual(await names(), ["09:00 – 09:59", "22:00 – 22:59"]);
  assert.deepEqual((await rows.first().locator("td").allTextContents()).slice(1), ["$40", "40%", "300", "2"]);

  // One report failing leaves the others standing.
  timingFails = true;
  await dialog.getByTestId("usage-project-filter").selectOption(node.projects[0].id);
  await dialog.getByTestId("usage-insight-stats").getByText("unavailable", { exact: true }).waitFor();
  assert.deepEqual((await stats.locator("strong").allTextContents()).slice(0, 2), ["24", "300"]);
  await dialog.getByTestId("usage-insight-view-days").click();
  assert.deepEqual((await rows.first().locator("td").allTextContents()).map((text: string) => text.trim()).slice(1), ["$254.46", "69%", "1,965", "—", "—", "—", "—", "—"]);
  assert.deepEqual(errors, []);
});

test("suggestions stay unread until asked, then list skills to remove and kinds of work to add, with a reviewed draft", { timeout: 240_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await login(page, environment, node.url);
  let suggestionRequests = 0;
  const drafts: any[] = [];
  let releaseInventory!: () => void;
  const inventoryGate = new Promise<void>((resolve) => { releaseInventory = resolve; });
  t.after(() => releaseInventory());
  const inventoryRequested = page.waitForRequest('**/api/resources/inventory*');
  await page.route('**/api/resources/inventory*', async (route) => {
    await inventoryGate;
    await route.fulfill({ json: { nodes: [] } });
  });
  const empty = { skills: [], scopeRequests: 0, unattributedRequests: 0, withSkill: { turns: 0, requests: 0, pricedRequests: 0, costUsd: 0, toolCalls: 0, toolErrors: 0, timedTurns: 0, medianDurationMs: null },
    withoutSkill: { requests: 0, pricedRequests: 0, costUsd: 0, toolCalls: 0, toolErrors: 0 }, turnTiming: null, coverage: { missing: 0 } };
  await page.route("**/api/usage/skills?*", (route: any) => route.fulfill({ json: empty }));
  await page.route("**/api/usage/skills/suggestions?*", (route: any) => {
    suggestionRequests++;
    return route.fulfill({ json: {
      installedSkills: 9, conversationsConsidered: 120, truncated: false,
      removals: [
        { kind: "unused", name: "old-skill", reason: "No agent has loaded it in the 120 days of usage recorded on this node.", turns: 0, lastUsedAt: null, knownCostUsd: 0 },
        { kind: "overlap", name: "copy-skill", other: "main-skill", reason: "Its description is 80% the same as main-skill.", turns: 2, lastUsedAt: "2026-10-01T00:00:00.000Z", knownCostUsd: 3 },
        ...Array.from({ length: 4 }, (_, index) => ({ kind: "failing", name: `flaky-${index}`, reason: "30% of tool calls fail.", turns: 12, lastUsedAt: "2026-10-12T00:00:00.000Z", knownCostUsd: 10 })),
      ],
      creations: [{ phrase: "deploy staging", kind: "script", confidence: 0.45, conversations: 4, projects: 1, days: 4, knownCostUsd: 8, requests: 40, firstAt: "2026-10-01T00:00:00.000Z", lastAt: "2026-10-12T00:00:00.000Z", coveredBy: "ship-it",
        examples: [{ projectId: "p1", projectName: "Billing", conversationId: "a", title: "Deploy staging cluster", knownCostUsd: 2 }], draftProjectId: "p1", draftProjectName: "Billing", draftEvidenceIds: ["a", "b", "c"] }],
    } });
  });
  await page.route("**/api/usage/analysis/drafts", (route: any) => { drafts.push(route.request().postDataJSON()); return route.fulfill({ status: 201, json: { id: "d1", ...drafts.at(-1), reviewedSha256: "f".repeat(64), status: "draft" } }); });
  await page.getByTestId("usage-open").click();
  const dialog = page.getByTestId("usage-dialog");
  await dialog.getByTestId("usage-tab-insights").click();
  await dialog.getByTestId("usage-insight-view-suggest").click();
  await dialog.getByTestId("usage-suggest-run").waitFor();
  assert.equal(suggestionRequests, 0, "nothing is read until the person asks");
  await dialog.getByTestId("usage-suggest-run").click();
  const removals = dialog.getByTestId("usage-suggest-removals");
  await removals.getByTestId("usage-suggest-removal").first().waitFor();
  assert.equal(suggestionRequests, 1);
  assert.equal(await removals.getByTestId("usage-suggest-removal").count(), 3, "three to a page");
  assert.deepEqual(await removals.locator(".usage-suggest-kind").allTextContents(), ["Unused", "Overlaps", "Fails often"]);
  await removals.getByText("Page 1 of 2").waitFor();
  await removals.locator('[data-suggest-page="removals:1"]').click();
  assert.equal(await removals.getByTestId("usage-suggest-removal").count(), 3);
  const creations = dialog.getByTestId("usage-suggest-creations");
  await creations.getByText("May already be covered by").waitFor();
  assert.equal(await creations.locator("header .usage-suggest-kind").textContent(), "script · 45%");
  await creations.getByTestId("usage-suggest-draft").click();
  assert.equal(await creations.getByTestId("usage-draft-name").inputValue(), "deploy-staging");
  await creations.getByTestId("usage-draft-content").fill("Run the staging deploy script and check the health endpoint.");
  await inventoryRequested;
  const inventoryLoaded = page.waitForResponse('**/api/resources/inventory*');
  releaseInventory();
  await (await inventoryLoaded).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await creations.getByTestId("usage-draft-content").count(), 1, "a late inventory read must preserve the open suggestion draft");
  assert.equal(await creations.getByTestId("usage-draft-content").inputValue(), "Run the staging deploy script and check the health endpoint.", "a late inventory read must preserve typed draft content");
  await creations.getByTestId("usage-draft-save").click();
  await creations.getByTestId("usage-draft-review").waitFor();
  assert.deepEqual(drafts, [{ projectId: "p1", name: "deploy-staging", kind: "script", content: "Run the staging deploy script and check the health endpoint.", evidenceConversationIds: ["a", "b", "c"] }]);
  // Reading an unused skill opens its page over the suggestions, and Back returns to them.
  await page.route("**/api/usage/skills/content?*", (route: any) => route.fulfill({ status: 404, json: { error: "That skill is not installed on this node" } }));
  await removals.locator('[data-page="x"], [data-suggest-page="removals:-1"]').click();
  await removals.getByTestId("usage-suggest-open").first().click();
  await dialog.getByTestId("usage-skill-detail").getByText("That skill is not installed on this node").waitFor();
  await dialog.getByTestId("usage-skill-back").click();
  await dialog.getByTestId("usage-suggest-removals").waitFor();
});

test("the comparison says what changed against the previous period, by totals, project, model and skill", { timeout: 240_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await login(page, environment, node.url);
  const today = new Date();
  const firstOfMonth = isoDate(new Date(today.getFullYear(), today.getMonth(), 1));
  const totals = (cost: number, requests: number) => ({ apiCostUsd: cost, partial: false, input: 100, output: 50, cacheRead: 900, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0, totalTokens: requests * 1000, pricedRequests: requests, requests, toolCalls: 100, toolErrors: cost > 1000 ? 20 : 5, reasoning: 0, missingRequests: 0, unavailableSessions: 0 });
  const side = (current: boolean) => ({ summary: totals(current ? 1500 : 1000, 100), projects: [{ id: "x", name: "Contigos" }, { id: "y", name: "Guitar" }],
    breakdowns: { projects: [{ key: "x", totals: totals(current ? 1200 : 500, 1) }, { key: "y", totals: totals(current ? 300 : 500, 1) }], models: [{ key: "gpt-big", totals: totals(current ? 1000 : 700, 1) }] }, coverage: { missing: 0 } });
  const isCurrent = (route: any) => new URL(route.request().url()).searchParams.get("from") === firstOfMonth;
  await page.route("**/api/usage/days?*", (route: any) => route.fulfill({ json: { days: [{ key: isoDate(today), totals: { apiCostUsd: 3, partial: false } }], coverage: { missing: 0, refreshedAt: null, refreshing: false } } }));
  await page.route("**/api/usage?*", (route: any) => new URL(route.request().url()).searchParams.get("sections") === "summary,projects,models" ? route.fulfill({ json: side(isCurrent(route)) }) : route.fallback());
  await page.route("**/api/usage/skills?*", (route: any) => route.fulfill({ json: { skills: [{ name: "ponytail", associatedTurns: isCurrent(route) ? 40 : 10 }], withSkill: { turns: isCurrent(route) ? 40 : 10 }, coverage: { missing: 0 } } }));
  await page.route("**/api/usage/timing?*", (route: any) => route.fulfill({ json: { days: [], totals: { turns: isCurrent(route) ? 60 : 50, failed: isCurrent(route) ? 4 : 1, medianAgentMs: 60_000, medianQueueMs: null, medianToolMs: null }, unknownHistoricalTiming: 0 } }));
  await page.getByTestId("usage-open").click();
  const dialog = page.getByTestId("usage-dialog");
  await dialog.getByTestId("usage-tab-compare").click();
  const changes = dialog.getByTestId("usage-changes");
  const headline = changes.getByTestId("usage-changes-headline");
  await headline.waitFor();
  assert.match(await headline.textContent() ?? "", /^Cost is up 50% on .+, same \d+ days?\. Biggest rises: Contigos \(\+\$700\), gpt-big \(\+\$300\)\.$/);
  const totalsRows = changes.getByTestId("usage-changes-totals").locator("tbody tr");
  assert.deepEqual(await totalsRows.first().locator("td").allTextContents(), ["Cost", "$1,500", "$1,000", "▲ 50%"]);
  assert.match(await totalsRows.first().locator("td").nth(3).getAttribute("class") ?? "", /worse/);
  assert.deepEqual(await changes.getByTestId("usage-changes-totals").locator("tbody tr td:first-child").allTextContents(), ["Cost", "Requests", "Tokens", "Cost per request", "Cache read", "Failed tool calls", "Turns", "Median turn", "Failed turns", "Skill turns"]);
  assert.deepEqual(await changes.getByTestId("usage-changes-projects").locator("tbody tr").first().locator("td").allTextContents(), ["Contigos", "$1,200", "$500", "+$700 · ▲ 140%"]);
  assert.deepEqual(await changes.getByTestId("usage-changes-skills").locator("tbody tr").first().locator("td").allTextContents(), ["ponytail", "40", "10", "+30 · ▲ 300%"]);
  await changes.getByTestId("usage-changes-week").click();
  await changes.getByTestId("usage-changes-week").and(page.locator('[aria-pressed="true"]')).waitFor();
});

test("comparison cancels stale scope response without overwriting newer chart", { timeout: 240_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await login(page, environment, node.url);
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let requests = 0;
  await page.route("**/api/usage/days?*", async (route: any) => {
    requests++;
    if (requests === 1) await gate;
    const today = isoDate(new Date());
    try { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ days: [{ key: today, totals: { apiCostUsd: requests === 1 ? 1 : 9, partial: false } }], coverage: { missing: 0, refreshedAt: null, refreshing: false } }) }); }
    catch { /* canceled first request */ }
  });
  await page.getByTestId("usage-open").click();
  const dialog = page.getByTestId("usage-dialog");
  await dialog.getByTestId("usage-tab-compare").click();
  await until(async () => requests === 1, "first comparison request");
  await dialog.getByTestId("usage-project-filter").selectOption(node.projects[0].id);
  await dialog.getByTestId("usage-compare-month-value").getByText("$9").waitFor();
  release?.();
  assert.equal(await dialog.getByTestId("usage-compare-month-value").textContent(), "$9");
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
