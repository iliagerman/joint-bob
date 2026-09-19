import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("project and conversation schedules, edit, pause, history, delete and Cron filter", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator('#loginDialog[open]').waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3);
  await page.locator('[aria-label="Actions for Internal Assistant"]').click();
  await page.locator('[data-testid="project-cron-button"]').click();
  await page.waitForFunction(() => document.querySelector("#cronDialog").open && document.querySelector("#cronForm").elements.ownerNodeId.options.length > 0);
  const desktopDialog = await page.evaluate(() => {
    const card = document.querySelector("#cronDialog > .dialog-card");
    if (!card) return null;
    const rect = card.getBoundingClientRect();
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, background: getComputedStyle(card).backgroundColor };
  });
  assert.ok(desktopDialog, "Scheduled tasks should use the standard dialog card");
  assert.ok(desktopDialog.left >= 12 && desktopDialog.right <= 1428 && desktopDialog.top >= 12 && desktopDialog.bottom <= 888, `Desktop dialog escaped viewport: ${JSON.stringify(desktopDialog)}`);
  assert.notEqual(desktopDialog.background, "rgba(0, 0, 0, 0)", "Scheduled tasks dialog needs an opaque app surface");
  await page.locator("#cronNew").click();
  assert.equal(await page.evaluate(`(() => {
    const form = document.querySelector("#cronForm"), f = form.elements;
    f.name.value = "Project browser cron"; f.prompt.value = "Scheduled project prompt";
    f.frequency.value = "weekly"; f.frequency.dispatchEvent(new Event("change", { bubbles: true }));
    f.engine.value = "claude"; f.engine.dispatchEvent(new Event("change", { bubbles: true }));
    f.model.value = "claude|sonnet"; f.model.dispatchEvent(new Event("change", { bubbles: true }));
    f.reasoning.value = "high"; f.timezone.value = "UTC"; f.enabled.checked = false;
    if (f.pauseOnFailure.checked) throw Error("Pause on failure must default off");
    f.pauseOnFailure.checked = true;
    if (document.querySelector("#cronWeekdayLabel").hidden || document.querySelector("#cronTimeLabel").hidden || !document.querySelector("#cronMinuteLabel").hidden) throw Error("Weekly controls incorrect");
    if (f.engine.disabled || f.model.value !== "claude|sonnet" || f.reasoning.value !== "high") throw Error("Project execution settings unavailable");
    form.requestSubmit(); return true;
  })()`), true);
  await page.waitForFunction(() => document.querySelector("#cronList").textContent.includes("Project browser cron") && document.querySelector("#cronList").textContent.includes("New conversation") && document.querySelector("#cronList").textContent.includes("sonnet") && document.querySelector("#cronList").textContent.includes("high") && document.querySelector("#cronList").textContent.includes("Paused"));
  assert.equal(await page.getByTestId("cron-run").isVisible(), true, "Paused schedules need a Run now action");
  await page.locator('[data-testid="cron-edit"]').click();
  assert.equal(await page.getByTestId("cron-form").isVisible(), true, "Edit schedule should open the editor");
  assert.equal(await page.evaluate(`(() => {
    const form = document.querySelector("#cronForm"), f = form.elements;
    if (f.frequency.value !== "weekly" || f.timezone.value !== "UTC" || f.enabled.checked || !f.pauseOnFailure.checked) throw Error("Saved schedule not restored");
    if (f.engine.value !== "claude" || f.model.value !== "claude|sonnet" || f.reasoning.value !== "high") throw Error("Saved execution settings not restored");
    f.name.value = "Edited project cron"; f.frequency.value = "daily";
    f.frequency.dispatchEvent(new Event("change", { bubbles: true }));
    if (!document.querySelector("#cronWeekdayLabel").hidden) throw Error("Daily schedule shows weekday");
    form.requestSubmit(); return true;
  })()`), true);
  await page.waitForFunction(() => document.querySelector("#cronList").textContent.includes("Edited project cron"));
  await page.locator('[data-testid="cron-toggle"]').click();
  await page.waitForFunction(() => document.querySelector("#cronList").textContent.includes("Next run"));
  await page.locator('[data-testid="cron-toggle"]').click();
  await page.waitForFunction(() => document.querySelector("#cronList").textContent.includes("Paused"));
  await page.locator('[data-testid="cron-history"]').click();
  await page.waitForFunction(() => document.querySelector("#cronList pre")?.textContent === "Not run yet");
  await page.locator("#cronClose").click();
  await page.locator("#projectList .list-row", { hasText: "Internal Assistant" }).locator("button").first().click();
  await page.locator('[data-filter="all"]').click();
  await page.waitForFunction(() => [...document.querySelectorAll("#sessionList .list-row")].some(row => row.textContent.includes("Short one")));
  await page.locator("#sessionList .list-row", { hasText: "Short one" }).locator(".row-menu-button").click();
  await page.locator('[data-testid="session-cron-button"]').click();
  await page.waitForFunction(() => document.querySelector("#cronDialog").open && document.querySelector("#cronList").textContent.includes("No scheduled tasks"));
  await page.locator("#cronNew").click();
  assert.equal(await page.evaluate(`(() => {
    const form = document.querySelector("#cronForm"), f = form.elements;
    if (!f.engine.disabled || f.engine.value !== "pi") throw Error("Conversation harness should be visible and fixed");
    if (!f.model.options.length || f.reasoning.options.length < 2 || f.reasoning.disabled) throw Error("Conversation execution settings unavailable");
    f.reasoning.value = "high"; f.intervalHours.value = "3";
    f.name.value = "Conversation browser cron"; f.prompt.value = "Scheduled append";
    f.timezone.value = "UTC"; f.enabled.checked = false;
    form.requestSubmit(); return true;
  })()`), true);
  await page.waitForFunction(() => document.querySelector("#cronList").textContent.includes("Conversation browser cron") && document.querySelector("#cronList").textContent.includes("Existing conversation") && document.querySelector("#cronList").textContent.includes("Every 3 hours") && document.querySelector("#cronList").textContent.includes("high") && document.querySelector("#cronList").textContent.includes("Paused"));
  await page.locator("#cronClose").click();
  await page.locator('[data-testid="chats-filter-cron-button"]').click();
  await page.waitForFunction(() => document.querySelectorAll("#sessionList .list-row").length === 1 && document.querySelector("#sessionList .list-row").textContent.includes("Short one"));
  await page.locator("#sessionList .list-row", { hasText: "Short one" }).click();
  await page.locator("#messages .message.assistant", { hasText: "Understood." }).waitFor();
  assert.deepEqual(await page.locator("#messages .message.user .message-content").allTextContents(), ["Single short line."], "A person's own messages must stay visible in a scheduled conversation");
  assert.deepEqual(await page.locator("#messages .message.assistant .message-content").allTextContents(), ["Understood."], "Scheduled transcripts should show only final reports");
  await page.goto(node.url);
  await page.waitForFunction(() => document.querySelector("[data-filter-count=cron]").textContent === "1");
  await page.locator('[aria-label="Actions for Internal Assistant"]').click();
  await page.locator('[data-testid="project-cron-button"]').click();
  await page.waitForFunction(() => document.querySelectorAll("#cronList .cron-task").length === 2);
  await page.locator("#cronList .cron-task", { hasText: "Edited project cron" }).getByTestId("cron-delete").click();
  await page.locator('#confirmDialog[open]').waitFor();
  await page.locator("#confirmAcceptButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#cronList .cron-task").length === 1);
  assert.equal(await page.evaluate('document.querySelector("#cronList").textContent.includes("Conversation browser cron") && !document.querySelector("#cronList").textContent.includes("Edited project cron")'), true);

  await page.setViewportSize({ width: 390, height: 500 });
  const mobileTask = await page.evaluate(() => {
    const card = document.querySelector("#cronDialog > .dialog-card");
    const task = document.querySelector("#cronList .cron-task");
    const actions = [...document.querySelectorAll("#cronList .cron-task-actions button")];
    if (!card || !task || actions.length !== 5) return null;
    const cardRect = card.getBoundingClientRect();
    const taskRect = task.getBoundingClientRect();
    return { withinCard: taskRect.left >= cardRect.left && taskRect.right <= cardRect.right, actionHeights: actions.map(button => button.getBoundingClientRect().height) };
  });
  assert.ok(mobileTask?.withinCard, `Mobile scheduled task escaped its card: ${JSON.stringify(mobileTask)}`);
  assert.ok(mobileTask.actionHeights.every(height => height >= 40), `Mobile task actions need touch targets: ${JSON.stringify(mobileTask.actionHeights)}`);

  await page.getByTestId("cron-edit").click();
  const mobileDialog = await page.evaluate(() => {
    const card = document.querySelector("#cronDialog > .dialog-card");
    const form = document.querySelector("#cronForm");
    if (!card || !form) return null;
    const rect = card.getBoundingClientRect();
    const style = getComputedStyle(card);
    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, overflowY: style.overflowY, scrolls: card.scrollHeight > card.clientHeight };
  });
  assert.ok(mobileDialog, "Mobile schedule editor should keep the standard dialog card");
  assert.ok(mobileDialog.left >= 8 && mobileDialog.right <= 382 && mobileDialog.top >= 8 && mobileDialog.bottom <= 492, `Mobile dialog escaped viewport: ${JSON.stringify(mobileDialog)}`);
  assert.equal(mobileDialog.overflowY, "auto");
  assert.equal(mobileDialog.scrolls, true, "Long schedule editor should scroll inside the dialog");
  await page.getByTestId("cron-save").scrollIntoViewIfNeeded();
  assert.equal(await page.getByTestId("cron-save").isVisible(), true, "Save action should remain reachable on a short mobile viewport");
});

test("scheduled tasks dialog shows a loading spinner until tasks arrive", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator('#loginDialog[open]').waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3);

  // Delay the task listing so the loading state stays observable, and prove the
  // list never renders its empty placeholder before the response arrives.
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/cron", async route => {
    if (route.request().method() !== "GET") return route.continue();
    await gate;
    return route.continue();
  });

  await page.locator('[aria-label="Actions for Internal Assistant"]').click();
  await page.locator('[data-testid="project-cron-button"]').click();
  await page.getByTestId("cron-loading").waitFor();
  assert.equal(await page.getByTestId("cron-loading").isVisible(), true, "Dialog should show a spinner while tasks load");
  assert.equal(await page.evaluate('document.querySelector("#cronList").textContent.includes("No scheduled tasks")'), false, "Empty placeholder must not flash before tasks load");
  assert.equal(await page.evaluate('Boolean(document.querySelector("#cronList .queued-force-spinner"))'), true, "Loading indicator needs a spinner");

  release();
  await page.waitForFunction(() => document.querySelector("#cronList").textContent.includes("No scheduled tasks"));
  assert.equal(await page.getByTestId("cron-loading").count(), 0, "Spinner must clear once tasks resolve");
});
