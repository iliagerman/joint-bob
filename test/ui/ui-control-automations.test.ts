import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

const BASE = "/api/control-center/automations";

/** The page's own API client, so the test acts as the signed-in person. */
function call<T = unknown>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
  return page.evaluate(async ({ method, path, body }) => {
    const { api } = await import("/app/api.js");
    return api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }, { method, path, body }) as Promise<T>;
}

/** The row with this text, wherever it is in the pages. Looks from the first page on. */
async function findRow(page: Page, text: string) {
  const row = page.locator('[data-testid="automation-row"]', { hasText: text });
  for (let step = 0; step < 8; step += 1) {
    const previous = page.getByTestId("automations-page-previous");
    if (await previous.count() && await previous.isEnabled()) { await previous.click(); await page.waitForTimeout(80); } else break;
  }
  for (let step = 0; step < 8; step += 1) {
    if (await row.count()) return row.first();
    const next = page.getByTestId("automations-page-next");
    if (!await next.count() || await next.isDisabled()) break;
    await next.click();
    await page.waitForTimeout(80);
  }
  throw new Error(`No row says "${text}"`);
}

const schedule = (projectId: string, name: string, extra: Record<string, unknown> = {}) => ({
  projectId, name, prompt: `Do ${name}`, schedule: { frequency: "daily", time: "02:00", timezone: "UTC" }, ...extra,
});

test("the Automations tab lists every scheduled task, webhook and Bob report, filters by project, pages, and edits through the existing systems", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const [alpha, beta] = node.projects;
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length >= 2 && !document.body.classList.contains("booting"));
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);

  // What exists before the person opens the tab: tasks in two projects, a webhook, and enough tasks to need a second page.
  const nightly = (await call<{ task: { id: string } }>(page, "POST", `${BASE}/schedule`, schedule(alpha.id, "Nightly release check", { prompt: "Run the release gate, report only" }))).task;
  const slow = (await call<{ task: { id: string } }>(page, "POST", `${BASE}/schedule`, schedule(beta.id, "DB slow query report", { enabled: false }))).task;
  await call(page, "POST", `${BASE}/webhook`, { projectId: alpha.id, name: "GitHub issues", context: "Triage the issue" });
  for (let index = 1; index <= 16; index += 1) await call(page, "POST", `${BASE}/schedule`, schedule(alpha.id, `Zz filler ${String(index).padStart(2, "0")}`));
  const TOTAL = 19;

  await page.getByTestId("projects-open-control-center-button").click();
  await page.getByTestId("control-tab-automations").waitFor();
  // The count shows on the tab as soon as the control center opens.
  await page.waitForFunction((expected) => document.querySelector('[data-testid="control-tab-automations"] .control-tab-badge')?.textContent === String(expected), TOTAL);
  await page.getByTestId("control-tab-automations").click();
  await page.getByTestId("automation-row").first().waitFor();

  // It pages to the height it has and never scrolls.
  const rowsOnPage = await page.getByTestId("automation-row").count();
  assert.ok(rowsOnPage >= 3 && rowsOnPage < TOTAL, `a page holds some of the rows, got ${rowsOnPage}`);
  const fits = await page.getByTestId("automations-list").evaluate((list) => list.scrollHeight <= list.clientHeight + 1 && getComputedStyle(list).overflowY !== "scroll");
  assert.equal(fits, true, "the list fits its box");
  assert.match(await page.getByTestId("automations-page-label").textContent() ?? "", new RegExp(`^1–${rowsOnPage} of ${TOTAL}$`));
  const firstPage = await page.getByTestId("automation-row").first().getAttribute("data-id");
  await page.getByTestId("automations-page-next").click();
  await page.waitForFunction((label) => document.querySelector('[data-testid="automations-page-label"]')?.textContent !== label, `1–${rowsOnPage} of ${TOTAL}`);
  assert.notEqual(await page.getByTestId("automation-row").first().getAttribute("data-id"), firstPage, "the next page shows other rows");
  await page.getByTestId("automations-page-previous").click();
  await page.waitForFunction((id) => document.querySelector('[data-testid="automation-row"]')?.getAttribute("data-id") === id, firstPage);

  // The project filter is the board's: choosing a project here narrows this table and stays chosen on the board.
  await page.getByTestId(`automations-filter-${beta.id}`).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="automation-row"]').length === 1);
  assert.equal(await page.getByTestId("automation-name").first().textContent(), "DB slow query report");
  assert.equal(await page.getByTestId("automation-kind").first().textContent(), "schedule");
  assert.equal(await page.getByTestId("automation-last").first().textContent(), "paused");
  assert.equal(await page.getByTestId("automation-toggle").first().getAttribute("aria-checked"), "false");
  assert.equal(await page.locator('.control-tab-badge').first().textContent(), "1", "the badge follows the filter");
  await page.getByTestId("control-tab-live").click();
  await page.waitForFunction((name) => document.querySelector('[data-testid="control-center-filters"] .control-chip.active')?.textContent === name, beta.name);
  await page.getByTestId("control-tab-automations").click();
  await page.getByTestId("automations-filter-all").click();
  await page.waitForFunction((total) => document.querySelector('[data-testid="control-tab-automations"] .control-tab-badge')?.textContent === String(total), TOTAL);
  await page.getByTestId(`automations-filter-${alpha.id}`).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="automation-row"]').length > 3);
  await page.getByTestId("automations-filter-all").click();

  // Turning a task off is the existing update: the project's own scheduled-task list agrees.
  await (await findRow(page, "Nightly release check")).getByTestId("automation-toggle").click();
  await page.waitForFunction((id) => document.querySelector(`[data-id="${id}"] [data-testid="automation-toggle"]`)?.getAttribute("aria-checked") === "false", nightly.id);
  assert.equal((await call<{ tasks: Array<{ id: string; enabled: boolean }> }>(page, "GET", `/api/projects/${alpha.id}/cron`)).tasks.find((task) => task.id === nightly.id)!.enabled, false);
  await (await findRow(page, "Nightly release check")).getByTestId("automation-toggle").click();
  await page.waitForFunction((id) => document.querySelector(`[data-id="${id}"] [data-testid="automation-toggle"]`)?.getAttribute("aria-checked") === "true", nightly.id);

  // The compact editor starts from what is stored and changes only what the person changes.
  await (await findRow(page, "Nightly release check")).getByTestId("automation-edit").click();
  assert.equal(await page.getByTestId("automation-form-name").inputValue(), "Nightly release check");
  assert.equal(await page.getByTestId("automation-form-prompt").inputValue(), "Run the release gate, report only");
  assert.equal(await page.getByTestId("automation-form-frequency").inputValue(), "daily");
  assert.equal(await page.getByTestId("automation-form-time").inputValue(), "02:00");
  assert.equal(await page.getByTestId("automation-form-project").isDisabled(), true, "a task stays in its project");
  await page.getByTestId("automation-form-name").fill("Weekly release check");
  await page.getByTestId("automation-form-frequency").selectOption("weekly");
  await page.getByTestId("automation-form-weekday").selectOption("5");
  await page.getByTestId("automation-form-time").fill("03:30");
  await page.getByTestId("automation-form-save").click();
  await page.getByTestId("automation-form").waitFor({ state: "hidden" });
  await (await findRow(page, "Weekly release check")).waitFor();
  assert.equal(await (await findRow(page, "Weekly release check")).locator(".automation-when").textContent(), "Fri 03:30");
  const stored = (await call<{ tasks: Array<{ id: string; name: string; prompt: string; schedule: { frequency: string; weekday: number; hour: number; minute: number } }> }>(page, "GET", `/api/projects/${alpha.id}/cron`)).tasks.find((task) => task.id === nightly.id)!;
  assert.deepEqual([stored.name, stored.prompt, stored.schedule.frequency, stored.schedule.weekday, stored.schedule.hour, stored.schedule.minute], ["Weekly release check", "Run the release gate, report only", "weekly", 5, 3, 30]);

  // An edit of something that was deleted meanwhile says so in the form.
  await (await findRow(page, "Weekly release check")).getByTestId("automation-edit").click();
  await call(page, "DELETE", `${BASE}/schedule/${nightly.id}`);
  await page.getByTestId("automation-form-save").click();
  await page.waitForFunction(() => /no longer there/.test(document.querySelector('[data-testid="automation-form-error"]')?.textContent ?? ""));
  await page.getByTestId("automation-form-cancel").click();
  await page.getByTestId("automation-row").first().waitFor();

  // A scheduled task made in the form.
  await page.getByTestId("automations-new-schedule").click();
  await page.getByTestId("automation-form-name").fill("Log check");
  await page.getByTestId("automation-form-project").selectOption(beta.id);
  await page.getByTestId("automation-form-prompt").fill("Look for new errors in the logs");
  await page.getByTestId("automation-form-frequency").selectOption("hourly");
  await page.getByTestId("automation-form-time").fill("09:15");
  await page.getByTestId("automation-form-save").click();
  await page.getByTestId("automation-form").waitFor({ state: "hidden" });
  const logCheck = (await call<{ tasks: Array<{ id: string; name: string; projectId: string; schedule: { frequency: string; minute: number } }> }>(page, "GET", `/api/projects/${beta.id}/cron`)).tasks.find((task) => task.name === "Log check")!;
  assert.deepEqual([logCheck.projectId, logCheck.schedule.frequency, logCheck.schedule.minute], [beta.id, "hourly", 15]);

  // A webhook made in the form shows its secret address once.
  await page.getByTestId("automations-new-webhook").click();
  await page.getByTestId("automation-form-name").fill("Stripe test events");
  await page.getByTestId("automation-form-project").selectOption(alpha.id);
  await page.getByTestId("automation-form-context").fill("Read only, report to me");
  await page.getByTestId("automation-form-save").click();
  await page.getByTestId("automation-reveal").waitFor({ state: "visible" });
  assert.match(await page.getByTestId("automation-reveal").innerText(), /Stripe test events[\s\S]*only time the address is shown/);
  await page.getByTestId("automation-reveal-done").click();
  await page.getByTestId("automations-list").waitFor();
  assert.equal((await call<{ webhooks: Array<{ name: string; context: string }> }>(page, "GET", "/api/webhooks")).webhooks.some((hook) => hook.name === "Stripe test events" && hook.context === "Read only, report to me"), true, "the Webhooks settings list it");

  // Bob's reports: the evening report starts at 19:00 and covers every project when none is chosen.
  await page.getByTestId("automations-new-bob").click();
  await page.getByTestId("automation-form-report").selectOption("evening");
  assert.equal(await page.getByTestId("automation-form-time").inputValue(), "19:00");
  await page.getByTestId("automation-form-save").click();
  await page.getByTestId("automation-form").waitFor({ state: "hidden" });
  await page.getByTestId("automations-filter-all").click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="automation-row"][data-kind="bob"] [data-testid="automation-name"]')].some((name) => name.textContent === "Evening report"));
  const bobRow = page.locator('[data-testid="automation-row"][data-kind="bob"]').first();
  assert.equal(await bobRow.getByTestId("automation-kind").textContent(), "Bob");
  assert.match(await bobRow.innerText(), /All projects[\s\S]*Daily 19:00 · Bob's chat/);
  // Bob's report shows under any project filter.
  await page.getByTestId(`automations-filter-${beta.id}`).click();
  await page.locator('[data-testid="automation-row"][data-kind="bob"]').first().waitFor();
  await page.getByTestId("automations-filter-all").click();

  // Send now puts the report in Bob's chat.
  await bobRow.getByTestId("automation-send").click();
  await page.waitForFunction(async () => (await (await fetch("/api/control-center/bob/messages?importance=reports")).json()).messages.some((message: { via: string }) => /Evening report · sent now/.test(message.via)));

  // Delete asks twice, then removes it from the system that owns it.
  const filler = await findRow(page, "Zz filler 01");
  await filler.getByTestId("automation-delete").click();
  assert.equal((await filler.getByTestId("automation-delete").textContent())?.trim(), "Delete?");
  assert.equal(await page.locator('[data-testid="automation-row"]', { hasText: "Zz filler 01" }).count(), 1, "the first press only asks");
  await filler.getByTestId("automation-delete").click();
  await page.waitForFunction(() => ![...document.querySelectorAll('[data-testid="automation-name"]')].some((name) => name.textContent === "Zz filler 01"));
  assert.equal((await call<{ tasks: Array<{ name: string }> }>(page, "GET", `/api/projects/${alpha.id}/cron`)).tasks.some((task) => task.name === "Zz filler 01"), false);

  // What the compact form leaves out stays in the screens that already have it.
  await page.getByTestId("automations-filter-all").click();
  await (await findRow(page, "Log check")).getByTestId("automation-edit").click();
  await page.getByTestId("automation-form-more").click();
  await page.waitForFunction(() => (document.querySelector("#cronDialog") as HTMLDialogElement | null)?.open === true);
  await page.waitForFunction(() => /Log check/.test(document.querySelector("#cronList")?.textContent ?? ""));
});
