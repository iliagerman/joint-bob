import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("GitHub PR and pipeline tabs show list-first navigation and mobile workflow jobs", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t, () => ({ GH_TOKEN: "", GITHUB_TOKEN: "" }));
  const writes: unknown[] = [];
  const pull = { number: 42, title: "Fix retry handling", body: "Check error cases", state: "open", user: { login: "test-user" }, head: { ref: "fix/retry", sha: "a".repeat(40) }, base: { ref: "main" }, changed_files: 1 };
  const run = { id: 99, name: "CI", run_number: 16, head_branch: "main", status: "completed", conclusion: "failure", created_at: "2026-09-30T12:00:00Z" };
  await page.route("**/api/projects/*/git/github*", async (route) => {
    const request = route.request();
    const params = new URL(request.url()).searchParams;
    if (request.method() === "POST") { const action = request.postDataJSON(); writes.push(action); if (action.action === "close") pull.state = "closed"; if (action.action === "reopen") pull.state = "open"; if (action.action === "merge") pull.state = "closed"; return route.fulfill({ json: { id: 1, number: 43 } }); }
    if (params.get("op") === "pulls") return route.fulfill({ json: { repository: { owner: "test", repo: "repo" }, pulls: params.get("state") === pull.state ? [pull] : [] } });
    if (params.get("op") === "pull") return route.fulfill({ json: { pull, comments: [{ user: { login: "reviewer" }, body: "Please test cancellation" }], reviews: [], inline: [], files: [{ filename: "src/retry.ts", additions: 2, deletions: 1, status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }], truncated: { comments: false, reviews: false, inline: false, files: false } } });
    if (params.get("op") === "runs") return route.fulfill({ json: { runs: { workflow_runs: [run] } } });
    if (params.get("op") === "run") return route.fulfill({ json: { run, jobs: [
      { id: 12, name: "build (node 20)", status: "completed", conclusion: "success", steps: [{ name: "Compile", status: "completed", conclusion: "success" }] },
      { id: 13, name: "build (node 22)", status: "completed", conclusion: "failure", steps: [{ name: "Test", status: "completed", conclusion: "failure" }] },
      { id: 14, name: "summary", status: "completed", conclusion: "skipped", steps: [] },
      { id: 15, name: "release", status: "in_progress", conclusion: null, steps: [{ name: "Run tests", status: "in_progress", conclusion: null }] },
    ], groups: [{ key: "build", needs: [], jobIds: [12, 13] }, { key: "summary", needs: ["build"], jobIds: [14, 15] }], truncated: false } });
    if (params.get("op") === "log") return route.fulfill({ json: { text: "FAIL src/retry.ts", truncated: false } });
    return route.fulfill({ status: 400, json: { error: "Unexpected fixture request" } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(node.url);
  try { await page.locator("#loginDialog[open]").waitFor({ timeout: 5_000 }); }
  catch (error) { t.diagnostic(JSON.stringify({ errors, state: await page.evaluate(() => ({ ready: document.readyState, login: document.querySelector("#loginDialog")?.getAttribute("open"), html: document.body?.textContent?.slice(0, 150) })) })); throw error; }
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  await page.getByTestId("chat-git-button").click();
  await page.getByTestId("git-review-tab-pulls").click();
  await page.getByTestId("git-hosting-pull-row").waitFor();
  assert.equal(await page.getByText("All pull requests").count(), 1);
  await page.getByTestId("git-hosting-pull-row").click();
  await page.getByText("Please test cancellation").waitFor();
  await page.locator(".git-hosting-draft").fill("Looks good");
  await page.getByTestId("git-hosting-approve").click();
  await page.getByTestId("confirm-accept-button").click();
  await page.waitForFunction(() => document.querySelector("#gitReviewStatus")?.textContent?.includes("Submitted"));
  assert.deepEqual(writes, [{ action: "review", number: 42, body: "Looks good", event: "APPROVE" }]);
  await page.getByTestId("git-hosting-explain-pull").click();
  await page.getByTestId("git-review-tab-story").waitFor();
  assert.equal(await page.getByTestId("git-review-tab-story").getAttribute("aria-selected"), "true");
  assert.match(await page.locator("#gitReviewGenerate").innerText(), /PR #42/);
  await page.getByTestId("git-review-tab-pulls").click();
  await page.getByTestId("git-hosting-pull-row").click();
  await page.getByTestId("git-hosting-close").click();
  await page.getByTestId("confirm-accept-button").click();
  await page.getByTestId("git-hosting-reopen").click();
  await page.getByTestId("confirm-accept-button").click();
  await page.getByTestId("git-hosting-merge-squash").click();
  await page.getByTestId("confirm-accept-button").click();
  await page.waitForFunction(() => document.querySelector("#gitReviewStatus")?.textContent?.includes("Merged"));
  assert.deepEqual(writes.slice(1), [{ action: "close", number: 42 }, { action: "reopen", number: 42 }, { action: "merge", number: 42, sha: "a".repeat(40), method: "squash" }]);
  await page.getByTestId("git-hosting-back").click();
  await page.getByTestId("git-hosting-new-pull").click();
  await page.getByLabel("Pushed head branch").fill("fix/retry");
  await page.getByLabel("Base branch").fill("main");
  await page.getByLabel("PR title").fill("Fix retries");
  await page.getByLabel("PR description").fill("Adds tests");
  await page.getByText("Draft PR", { exact: true }).click();
  await page.getByTestId("git-hosting-create-pull").click();
  const createResponse = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/git/github") && response.request().method() === "POST" && response.request().postDataJSON().action === "create");
  await page.getByTestId("confirm-accept-button").click();
  await createResponse;
  assert.deepEqual(writes.at(-1), { action: "create", head: "fix/retry", base: "main", title: "Fix retries", body: "Adds tests", draft: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("git-review-tab-pipelines").click();
  await page.getByTestId("git-hosting-run-row").waitFor();
  assert.equal(await page.getByText("All pipeline runs").count(), 1);
  assert.equal(await page.getByTestId("git-review-tab-pipelines").isVisible(), true);
  await page.getByTestId("git-hosting-run-row").click();
  await page.locator('.git-hosting-graph-group[data-group="build"]').waitFor();
  assert.equal(await page.locator(".git-hosting-graph-job").count(), 4);
  assert.equal(await page.getByTestId("git-hosting-nav-job-15").innerText(), "◌ release", "a running job is not shown as passed");
  assert.equal(await page.getByTestId("git-hosting-graph-job-15").innerText(), "◌ release");
  assert.equal(await page.getByTestId("git-hosting-nav-job-12").innerText(), "✓ build (node 20)");
  await page.getByTestId("git-hosting-job-log").click();
  await page.getByText("FAIL src/retry.ts").waitFor();
  await page.getByTestId("git-hosting-back").click();
  await page.getByTestId("git-hosting-run-row").waitFor();
});
