import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { nativeUiFixture } from "./native-ui-fixture.js";

const status = { branch: "main", ahead: 0, behind: 0, detached: false, staged: [], unstaged: [
  { path: "app.ts", kind: "modified", staged: false },
], untracked: [], clean: false };
const patch = [
  "diff --git a/app.ts b/app.ts",
  "--- a/app.ts",
  "+++ b/app.ts",
  "@@ -1,3 +1,4 @@",
  " keep",
  "-old",
  "+new",
  "+added",
  " tail",
].join("\n");

async function routeFixtures(page: Page) {
  await page.route("**/api/projects/*/git/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/status")) return route.fulfill({ json: status });
    if (url.pathname.endsWith("/scope")) return route.fulfill({ json: { paths: ["app.ts"], lastHarness: "claude" } });
    if (url.pathname.endsWith("/diff")) return route.fulfill({ json: { patch, binary: false, truncated: false } });
    return route.fulfill({ status: 404, json: { error: "Unexpected Git request" } });
  });
  await page.route("**/api/harnesses", (route) => route.fulfill({ json: { harnesses: [
    { id: "pi", label: "Pi", runtimeConfigured: true, ready: true, defaults: { modelId: "gpt-6-sol", thinkingLevel: "medium" }, configuration: { fixedProvider: "openai-codex", thinkingLevels: ["low", "xhigh"] } },
    { id: "claude", label: "Claude", runtimeConfigured: true, ready: true, defaults: { modelId: "opus", thinkingLevel: "medium" }, configuration: { fixedProvider: "claude", thinkingLevels: ["low", "high", "xhigh"] } },
  ] } }));
  await page.route("**/api/models", (route) => route.fulfill({ json: { models: [
    { harnessId: "pi", id: "gpt-6-sol", label: "GPT-6 Sol", provider: "openai-codex", thinkingLevels: ["low", "xhigh"] },
    { harnessId: "claude", id: "opus", label: "Opus 5.5", provider: "claude", thinkingLevels: ["low", "high", "xhigh"] },
    { harnessId: "claude", id: "claude-sonnet-5-5", label: "Sonnet 5.5", provider: "claude", thinkingLevels: ["low", "high", "xhigh"] },
  ] } }));
}

async function signIn(page: Page, url: string, username: string, password: string) {
  await page.goto(url);
  await page.getByTestId("login-username-input").fill(username);
  await page.getByTestId("login-password-input").fill(password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
}

test("Git review fills most of the screen and shows diffs side by side", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await routeFixtures(page);
  await signIn(page, node.url, environment.username, environment.password);
  await page.getByTestId("chat-git-button").click();
  await page.getByTestId("git-review-file").first().click();
  await page.getByTestId("git-diff-row").first().waitFor();
  const viewport = page.viewportSize()!;
  const card = await page.locator(".git-review-card").boundingBox();
  assert.ok(card && card.width >= viewport.width * 0.9 && card.height >= viewport.height * 0.85, "dialog takes most of the screen");
  const rows = await page.getByTestId("git-diff-row").evaluateAll((items) => items.map((row) => [...row.querySelectorAll(".git-diff-cell")].map((cell) => cell.textContent)));
  assert.deepEqual(rows, [
    ["1", "keep", "1", "keep"],
    ["2", "old", "2", "new"],
    ["", "", "3", "added"],
    ["3", "tail", "4", "tail"],
  ]);
});

test("Ask AI composer fits the Git dialog without clipping or empty space below", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await routeFixtures(page);
  await signIn(page, node.url, environment.username, environment.password);
  await page.getByTestId("chat-git-button").click();
  await page.getByTestId("git-review-file").first().click();
  await page.getByTestId("git-review-ask-button").click();
  const card = await page.locator(".git-review-card").boundingBox();
  const form = await page.getByTestId("git-review-ask-form").boundingBox();
  const question = await page.getByTestId("git-review-question").boundingBox();
  const submit = await page.getByTestId("git-review-ask-submit").boundingBox();
  const model = await page.getByTestId("git-review-model").boundingBox();
  const generate = await page.getByTestId("git-review-generate").boundingBox();
  assert.ok(card && form && question && submit && model && generate);
  assert.ok(model.y > card.y + card.height / 2, "reviewer selectors sit near the composer, not the dialog header");
  assert.ok(question.y - (model.y + model.height) < 120, "model selector stays close to the question");
  assert.ok(Math.abs(model.y + model.height - (generate.y + generate.height)) < 3, "generate button stays beside reviewer selectors");
  assert.ok(form.y + form.height <= card.y + card.height, "Ask AI form stays inside the dialog");
  assert.ok(card.y + card.height - (form.y + form.height) < 4, "no empty strip below Ask AI form");
  assert.ok(question.y + question.height <= form.y + form.height, "question stays visible");
  assert.ok(submit.y + submit.height <= form.y + form.height, "Ask button stays visible");
  await page.setViewportSize({ width: 600, height: 700 });
  const mobileCard = await page.locator(".git-review-card").boundingBox();
  const mobileForm = await page.getByTestId("git-review-ask-form").boundingBox();
  const mobileSubmit = await page.getByTestId("git-review-ask-submit").boundingBox();
  const mobileModel = await page.getByTestId("git-review-model").boundingBox();
  assert.ok(mobileCard && mobileForm && mobileSubmit && mobileModel);
  assert.ok(mobileModel.y < mobileForm.y && mobileForm.y - (mobileModel.y + mobileModel.height) < 80, "mobile reviewer selectors sit beside the composer");
  assert.ok(mobileCard.y + mobileCard.height - (mobileForm.y + mobileForm.height) < 4, "mobile composer reaches dialog bottom");
  assert.ok(mobileSubmit.y + mobileSubmit.height <= mobileForm.y + mobileForm.height, "mobile Ask button stays visible");
});

test("Settings default Git reviewer overrides the conversation-based choice", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await routeFixtures(page);
  await signIn(page, node.url, environment.username, environment.password);
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-git").click();
  assert.equal(await page.getByTestId("settings-git-reviewer-harness").inputValue(), "");
  await page.getByTestId("settings-git-reviewer-harness").selectOption("claude");
  await page.getByTestId("settings-git-reviewer-model").selectOption("claude-sonnet-5-5");
  await page.getByTestId("settings-git-reviewer-thinking").selectOption("high");
  await page.waitForFunction(async () => (await (await fetch("/api/preferences")).json()).gitReviewer?.thinkingLevel === "high");
  await page.getByTestId("settings-cancel-button").click();
  await page.getByTestId("chat-git-button").click();
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("#gitReviewThinking")?.value === "high");
  assert.equal(await page.getByTestId("git-review-harness").inputValue(), "claude");
  assert.equal(await page.getByTestId("git-review-model").inputValue(), "claude-sonnet-5-5");
  await page.getByTestId("git-review-close-button").click();
  await page.reload();
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-git").click();
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("#settingsGitReviewerModel")?.value === "claude-sonnet-5-5");
  assert.equal(await page.getByTestId("settings-git-reviewer-model").inputValue(), "claude-sonnet-5-5");
});
