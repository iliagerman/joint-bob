import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function signIn(page: Page, url: string, username: string, password: string) {
  await page.goto(url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(username);
  await page.getByTestId("login-password-input").fill(password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden" });
  await page.locator(".project-card").first().waitFor({ state: "visible" });
  await page.getByTestId("settings-open-button").waitFor({ state: "attached" });
}

async function openHarnessSettings(page: Page) {
  await page.getByTestId("settings-open-button").click();
  await page.locator("#settingsDialog[open]").waitFor();
  await page.getByTestId("settings-tab-engines").click();
}

async function waitForHarnesses(page: Page) {
  await page.waitForFunction(async () => (await import("/app/state.js")).state.harnesses.some((harness) => harness.id === "kiro"));
}

test("slow harness metadata does not hide projects", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  let releaseHarnesses!: () => void;
  const harnessGate = new Promise<void>((resolve) => { releaseHarnesses = resolve; });
  const harnessRequest = page.waitForRequest("**/api/harnesses");
  await page.route("**/api/harnesses", async (route) => {
    await harnessGate;
    await route.continue();
  });

  try {
    await signIn(page, node.url, environment.username, environment.password);
    await harnessRequest;
    await page.getByText("Internal Assistant", { exact: true }).waitFor();
  } finally {
    releaseHarnesses();
    await waitForHarnesses(page);
  }
});

test("new conversation controls follow registered harnesses and align toolbar tasks", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.route("**/api/harnesses", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.harnesses.push({ id: "cursor", label: "Cursor", newSessionPath: "cursor:new", runtimeConfigured: true });
    await route.fulfill({ response, json: body });
  });
  await signIn(page, node.url, environment.username, environment.password);
  await waitForHarnesses(page);
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();

  const buttons = page.locator("[data-new-session-harness]");
  await buttons.first().waitFor();
  assert.deepEqual(await buttons.evaluateAll((items) => items.map((item) => item.getAttribute("aria-label"))), [
    "New Pi conversation", "New Claude conversation", "New Kiro conversation", "New Cursor conversation",
  ]);
  assert.deepEqual(await buttons.evaluateAll((items) => items.map((item) => item.querySelector("svg")?.classList.contains("new-chat-harness-icon"))), [true, true, true, true]);
  assert.equal(await buttons.evaluateAll((items) => items.every((item) => [...item.childNodes].every((node) => node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()))), true, "desktop harness controls use icons without chat labels");

  await page.locator("#sessionList .session-card").first().click();
  const geometry = await page.evaluate(() => {
    const tasks = document.querySelector("#backgroundTasksButton")!.getBoundingClientRect();
    const terminal = document.querySelector("#openTerminalButton")!.getBoundingClientRect();
    return { taskTop: tasks.top, taskHeight: tasks.height, terminalTop: terminal.top, terminalHeight: terminal.height };
  });
  assert.equal(geometry.taskTop, geometry.terminalTop, "Tasks aligns with adjacent toolbar buttons");
  assert.equal(geometry.taskHeight, geometry.terminalHeight, "Tasks has the same height as adjacent toolbar buttons");
});

test("mobile uses one new conversation button with a dynamic harness dialog", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, node.url, environment.username, environment.password);
  await waitForHarnesses(page);
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();

  await page.getByTestId("new-conversation-mobile-button").click();
  await page.getByTestId("choice-dialog").waitFor({ state: "visible" });
  assert.deepEqual(await page.getByTestId("choice-option").locator(".choice-option-label").allTextContents(), ["Pi", "Claude", "Kiro"]);
  // The picker is a logo beside a small name, not a logo stacked above one.
  const pickerRows = await page.getByTestId("choice-option").evaluateAll((rows) => rows.map((row) => {
    const icon = row.querySelector(".choice-option-icon")!.getBoundingClientRect();
    const label = row.querySelector(".choice-option-label")!.getBoundingClientRect();
    return { sameRow: label.top < icon.bottom && icon.top < label.bottom, height: row.getBoundingClientRect().height };
  }));
  assert.equal(pickerRows.length, 3);
  for (const row of pickerRows) {
    assert.equal(row.sameRow, true, "the agent logo and its name share one row");
    assert.ok(row.height < 56, `an agent option stays compact, got ${row.height}px`);
  }
  await page.locator('#choiceDialog input[value="kiro"]').check();
  await page.getByTestId("choice-accept-button").click();
  await page.getByTestId("new-session-name-dialog").waitFor({ state: "visible" });
  assert.equal(await page.evaluate(async () => (await import("/app/state.js")).state.newSessionDraft.sessionPath), "kiro:new");
});

test("mobile chat toolbar keeps model, reasoning and tasks on one row", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page, node.url, environment.username, environment.password);
  await waitForHarnesses(page);
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  await page.locator("#chatToolbar").waitFor({ state: "visible" });

  const layout = await page.evaluate(() => {
    const tasksIcon = document.querySelector(".background-tasks-icon")!;
    const tasksLabel = document.querySelector(".background-tasks-label")!;
    const reasoning = document.querySelector("#chatModeControl") as HTMLElement;
    return {
      model: document.querySelector("#modelButton")!.getBoundingClientRect().bottom,
      // Harnesses without a reasoning control hide the whole label.
      reasoning: reasoning.hidden ? null : document.querySelector("#reasoningLevelSelect")!.getBoundingClientRect().bottom,
      tasks: document.querySelector("#backgroundTasksButton")!.getBoundingClientRect().bottom,
      iconShown: getComputedStyle(tasksIcon).display !== "none",
      labelShown: getComputedStyle(tasksLabel).display !== "none",
    };
  });
  if (layout.reasoning !== null) assert.equal(layout.reasoning, layout.model, "reasoning sits on the model's row");
  assert.equal(layout.tasks, layout.model, "tasks sits on the model's row instead of a third row");
  assert.equal(layout.iconShown, true, "tasks shows its icon on mobile");
  assert.equal(layout.labelShown, false, "tasks drops its word on mobile");
});

test("model picker renders provider presentation metadata", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await waitForHarnesses(page);

  const iconMarkup = await page.evaluate(async () => {
    const { brandIcon } = await import("/app/icons.js");
    return {
      openai: brandIcon("openai", "model-group-icon").outerHTML,
      custom: brandIcon("custom", "model-group-icon").outerHTML,
    };
  });
  await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    state.engine = "pi";
    state.models = [
      { harnessId: "pi", provider: "openai-codex", id: "gpt", label: "GPT model", providerLabel: "GPT", providerIcon: "openai" },
      { harnessId: "pi", provider: "fixture-provider", id: "fixture", label: "Fixture model", providerLabel: "Independent", providerIcon: "custom" },
    ];
    const modelButton = document.querySelector("#modelButton")!;
    modelButton.removeAttribute("disabled");
    modelButton.click();
  });
  await page.locator("#modelDialog[open]").waitFor({ state: "visible" });

  const headings = page.locator("#modelDialogList .model-dialog-group");
  assert.deepEqual(await headings.allTextContents(), ["GPT", "Independent"]);
  assert.deepEqual(await headings.locator("svg").evaluateAll((icons) => icons.map((icon) => icon.outerHTML)), [iconMarkup.openai, iconMarkup.custom]);
  await page.getByTestId("model-option-fixture-provider-fixture").click();
  await page.locator("#modelDialog[open]").waitFor({ state: "hidden" });

  await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    state.models = [{ harnessId: "pi", provider: "openai-codex", id: "gpt", label: "GPT model", providerLabel: "GPT", providerIcon: "openai" }];
    const modelButton = document.querySelector("#modelButton")!;
    modelButton.removeAttribute("disabled");
    modelButton.click();
  });
  await page.locator("#modelDialog[open]").waitFor({ state: "visible" });
  assert.equal(await page.locator("#modelDialogList .model-dialog-group").innerText(), "GPT");
});

test("node settings configure or disable automatic context compaction", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await page.getByTestId("settings-open-button").click();
  await page.locator("#settingsDialog[open]").waitFor();

  const enabled = page.getByTestId("settings-auto-compact-enabled");
  const threshold = page.getByTestId("settings-auto-compact-threshold");
  assert.equal(await enabled.isChecked(), true);
  assert.equal(await threshold.inputValue(), "70");
  await threshold.fill("82");
  await page.getByTestId("settings-save-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(async () => (await (await fetch("/api/settings")).json()).autoCompactThreshold), 82);

  await page.getByTestId("settings-open-button").click();
  await page.locator("#settingsDialog[open]").waitFor();
  await enabled.uncheck();
  assert.equal(await threshold.isDisabled(), true);
  await page.getByTestId("settings-save-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(async () => (await (await fetch("/api/settings")).json()).autoCompactThreshold), null);
});

test("node settings leave shell commands unlimited by default and can cap their run time", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await page.getByTestId("settings-open-button").click();
  await page.locator("#settingsDialog[open]").waitFor();

  const enabled = page.getByTestId("settings-shell-timeout-enabled");
  const seconds = page.getByTestId("settings-shell-timeout-seconds");
  assert.equal(await enabled.isChecked(), false);
  assert.equal(await seconds.isDisabled(), true);
  await enabled.check();
  assert.equal(await seconds.isDisabled(), false);
  await seconds.fill("900");
  await page.getByTestId("settings-save-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(async () => (await (await fetch("/api/settings")).json()).shellCommandTimeoutSeconds), 900);

  await page.getByTestId("settings-open-button").click();
  await page.locator("#settingsDialog[open]").waitFor();
  assert.equal(await enabled.isChecked(), true);
  assert.equal(await seconds.inputValue(), "900");
  await enabled.uncheck();
  assert.equal(await seconds.isDisabled(), true);
  await page.getByTestId("settings-save-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" });
  assert.equal(await page.evaluate(async () => (await (await fetch("/api/settings")).json()).shellCommandTimeoutSeconds), null);
});

test("harness settings and model picker follow runtime metadata", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await openHarnessSettings(page);

  for (const id of ["pi", "claude", "kiro"]) await page.getByTestId(`harness-tab-${id}`).waitFor();
  await page.getByTestId("harness-tab-kiro").click();
  await page.getByTestId("settings-kiro-default-model").fill("fixture-model");
  await page.getByTestId("settings-kiro-default-thinking").selectOption("high");
  await page.getByTestId("settings-save-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" });

  const defaults = await page.evaluate(async () => (await (await fetch("/api/settings")).json()).conversationDefaults);
  assert.deepEqual(defaults.kiro, { provider: "kiro", modelId: "fixture-model", thinkingLevel: "high" });

  await page.route("**/api/models", (route) => route.fulfill({ json: { models: [
    { provider: "kiro", id: "fixture-model", label: "Kiro default", thinkingLevels: ["default", "high"], harnessId: "kiro" },
    { provider: "claude", id: "sonnet", label: "Claude Sonnet", thinkingLevels: ["high"], harnessId: "claude" },
    { provider: "openai-codex", id: "gpt", label: "Pi GPT", thinkingLevels: ["high"], harnessId: "pi" },
  ] } }));
  await page.reload();
  await page.getByTestId("settings-open-button").waitFor();
  await waitForHarnesses(page);
  await openHarnessSettings(page);
  await page.getByTestId("harness-tab-kiro").click();
  assert.equal(await page.getByTestId("settings-kiro-default-model").inputValue(), "fixture-model");
  assert.equal(await page.getByTestId("settings-kiro-default-thinking").inputValue(), "high");
  for (const id of ["pi", "claude"]) {
    await page.getByTestId(`harness-tab-${id}`).click();
    await page.getByTestId(`settings-${id}-default-model`).waitFor();
  }

  await page.evaluate(async () => {
    document.querySelector("#settingsDialog")?.close();
    const { state } = await import("/app/state.js");
    state.models = (await (await fetch("/api/models")).json()).models;
    state.engine = "kiro";
    (await import("/app/composer-dialogs.js")).openQueuedModelPicker("/", () => {});
  });
  await page.locator("#modelDialog[open]").waitFor();
  await page.locator('[data-testid="model-option-kiro-fixture-model"]').waitFor();
  assert.match(await page.locator("#modelDialogList").innerText(), /Kiro default/);
  assert.equal(await page.getByText("Claude Sonnet", { exact: true }).count(), 0);
  assert.equal(await page.getByText("Pi GPT", { exact: true }).count(), 0);
  await page.locator("#modelDialog").evaluate((dialog: HTMLDialogElement) => dialog.close());

  await page.locator("#projectList .project-card").filter({ has: page.getByText("Internal Assistant", { exact: true }) }).click();
  await page.getByTestId("projects-open-board-button").click();
  await page.getByTestId("task-create-button").click();
  assert.deepEqual(await page.getByTestId("task-form-engine-select").locator("option").allTextContents(), ["Pi", "Claude", "Kiro"]);
  await page.getByTestId("task-form-engine-select").selectOption("kiro");
  const planningModelOptions = page.locator("#taskPlanningModelInput option");
  assert.deepEqual(await planningModelOptions.allTextContents(), ["Use harness defaults", "Kiro default"]);
  const inheritedModelValue = await planningModelOptions.first().getAttribute("value");
  assert.match(inheritedModelValue!, /^kiro\|/);
  const [engine, provider, modelId, effort] = inheritedModelValue!.split("|");
  assert.deepEqual({ engine, provider, modelId, effort }, { engine: "kiro", provider: "", modelId: "", effort: "default" });
  await page.locator("#taskDialog").evaluate((dialog: HTMLDialogElement) => dialog.close());

  await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    await (await import("/app/cron.js")).openScheduledTasks(state.activeProjectId);
  });
  await page.getByTestId("cron-new").click();
  assert.deepEqual(await page.getByTestId("cron-engine").locator("option").allTextContents(), ["Pi", "Claude", "Kiro"]);
  await page.locator("#cronDialog").evaluate((dialog: HTMLDialogElement) => dialog.close());

  await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    state.activeSessionId = crypto.randomUUID();
    (await import("/app/socket.js")).openSession("kiro:new", "New Kiro conversation");
  });
  await page.getByText("Ready for your first message", { exact: true }).waitFor();
  assert.match(await page.getByTestId("chat-message-input").getAttribute("placeholder") || "", /Kiro|work/);
  assert.match(await page.locator("#messages").innerText(), /Kiro will run/);
  assert.doesNotMatch(await page.locator("#messages").innerText(), /Pi will run/);
});

test("listing-only harness metadata does not offer execution or break settings", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.route("**/api/harnesses", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.harnesses.push({ id: "archive", label: "Archive", newSessionPath: "archive:new", runtimeConfigured: false });
    await route.fulfill({ response, json: body });
  });

  await signIn(page, node.url, environment.username, environment.password);
  await waitForHarnesses(page);
  await openHarnessSettings(page);
  for (const id of ["pi", "claude", "kiro"]) await page.getByTestId(`harness-tab-${id}`).waitFor();
  assert.equal(await page.getByTestId("harness-tab-archive").count(), 0);
  await page.locator("#settingsDialog").evaluate((dialog: HTMLDialogElement) => dialog.close());

  await page.locator("#projectList .project-card").filter({ has: page.getByText("Internal Assistant", { exact: true }) }).click();
  assert.equal(await page.locator("#chatHarnessSelect option[value=archive]").count(), 0);

  await page.getByTestId("projects-open-board-button").click();
  await page.getByTestId("task-create-button").click();
  assert.equal(await page.getByTestId("task-form-engine-select").locator("option[value=archive]").count(), 0);
  await page.locator("#taskDialog").evaluate((dialog: HTMLDialogElement) => dialog.close());

  await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    await (await import("/app/cron.js")).openScheduledTasks(state.activeProjectId);
  });
  await page.getByTestId("cron-new").click();
  assert.equal(await page.getByTestId("cron-engine").locator("option[value=archive]").count(), 0);
  await page.locator("#cronDialog").evaluate((dialog: HTMLDialogElement) => dialog.close());
});
