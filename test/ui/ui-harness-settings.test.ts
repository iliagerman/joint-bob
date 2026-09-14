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
  await page.getByTestId("settings-open-button").waitFor();
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
  assert.equal(await page.locator("#modelDialogList .model-dialog-group").innerText(), "GPT");
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

  await page.getByRole("button", { name: /Internal Assistant \/private\// }).click();
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

  await page.getByRole("button", { name: /Internal Assistant \/private\// }).click();
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
