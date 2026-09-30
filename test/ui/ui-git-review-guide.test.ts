import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("conversation Git review hides other files and orders guided comments with opposite reviewer", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const requests: unknown[] = [];
  let lastHarness = "claude";
  const status = { branch: "main", ahead: 0, behind: 0, detached: false, staged: [
    { path: "mine.ts", kind: "modified", staged: true },
  ], unstaged: [
    { path: "other.ts", kind: "modified", staged: false },
  ], untracked: [
    { path: "important.ts", kind: "untracked", staged: false },
  ], clean: false };
  await page.route("**/api/projects/*/git/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/status")) return route.fulfill({ json: status });
    if (url.pathname.endsWith("/scope")) return route.fulfill({ json: { paths: ["mine.ts", "important.ts"], lastHarness } });
    if (url.pathname.endsWith("/guide")) {
      const body = route.request().postDataJSON();
      requests.push(body);
      return route.fulfill({ json: { thread: { id: "test-guide" }, fingerprint: "fixture", patches: { "mine.ts": "@@ -1 +1 @@\n-old\n+new", "important.ts": "@@ -1 +1 @@\n-old\n+new" }, guide: { summary: "Test change", items: [{ path: "important.ts", priority: "high", title: "Important change", explanation: "This changes behavior", checks: "Run test" }, { path: "mine.ts", priority: "low", title: "Minor change", explanation: "This is minor", checks: "Run test" }] } } });
    }
    if (url.pathname.endsWith("/diff")) return route.fulfill({ json: { patch: "+new", binary: false, truncated: false } });
    return route.fulfill({ status: 404, json: { error: "Unexpected Git request" } });
  });
  await page.route("**/api/harnesses", (route) => route.fulfill({ json: { harnesses: [
    { id: "pi", label: "Pi", runtimeConfigured: true, ready: true, defaults: { modelId: "gpt-6-sol", thinkingLevel: "medium" }, configuration: { fixedProvider: "openai-codex", thinkingLevels: ["low", "xhigh"] } },
    { id: "claude", label: "Claude", runtimeConfigured: true, ready: true, defaults: { modelId: "claude-opus-5-5", thinkingLevel: "medium" }, configuration: { fixedProvider: "claude", thinkingLevels: ["low", "xhigh"] } },
  ] } }));
  await page.route("**/api/models", (route) => route.fulfill({ json: { models: [
    { harnessId: "pi", id: "gpt-6-sol", label: "GPT-6 Sol", provider: "openai-codex", thinkingLevels: ["low", "xhigh"] },
    { harnessId: "claude", id: "claude-opus-5-5", label: "Opus 5.5", provider: "claude", thinkingLevels: ["low", "xhigh"] },
  ] } }));
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  await page.getByTestId("chat-git-button").click();
  await page.getByTestId("git-review-file").first().waitFor();
  assert.equal(await page.getByTestId("git-review-file").count(), 2);
  assert.match(await page.getByTestId("git-review-list").innerText(), /mine.ts/);
  assert.doesNotMatch(await page.getByTestId("git-review-list").innerText(), /other.ts/);
  assert.equal(await page.getByTestId("git-review-harness").inputValue(), "pi");
  assert.equal(await page.getByTestId("git-review-model").inputValue(), "gpt-6-sol");
  assert.equal(await page.getByTestId("git-review-thinking").inputValue(), "xhigh");
  lastHarness = "pi";
  await page.getByTestId("git-review-refresh-scope").click();
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("#gitReviewHarness")?.value === "claude");
  assert.equal(await page.getByTestId("git-review-model").inputValue(), "claude-opus-5-5");
  assert.equal(await page.getByTestId("git-review-thinking").inputValue(), "xhigh");
  lastHarness = "claude";
  await page.getByTestId("git-review-refresh-scope").click();
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("#gitReviewHarness")?.value === "pi");
  await page.getByTestId("git-review-generate").click();
  await page.getByTestId("git-review-guide").getByText("Important change", { exact: false }).waitFor();
  assert.deepEqual(await page.locator(".git-review-file-name").allTextContents(), ["important.ts", "mine.ts"]);
  assert.deepEqual(await page.locator(".git-review-priority").allTextContents(), ["HIGH", "LOW"]);
  const [{ conversationId, ...request }] = requests as Array<{ conversationId: string; scope: string; paths: string[]; harnessId: string; provider: string; modelId: string; thinkingLevel: string }>;
  assert.ok(conversationId, "review stays attached to the active conversation");
  assert.deepEqual(request, { scope: "conversation", paths: ["mine.ts", "important.ts"], harnessId: "pi", provider: "openai-codex", modelId: "gpt-6-sol", thinkingLevel: "xhigh" });
  assert.match(await page.getByTestId("git-review-diff").innerText(), /\+new/);
  await page.getByTestId("git-review-all-changes").check();
  assert.equal(await page.getByTestId("git-review-file").count(), 3);
  assert.equal(await page.getByTestId("git-review-guide").isVisible(), false);
});
