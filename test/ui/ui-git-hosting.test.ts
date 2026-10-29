import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("GitHub PR and pipeline tabs show list-first navigation and mobile workflow jobs", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t, () => ({ GH_TOKEN: "", GITHUB_TOKEN: "" }));
  const writes: unknown[] = [];
  let runningLog = "pending";
  let releaseLog: (() => void) | undefined;
  let logRequested: (() => void) | undefined;
  const pull = { number: 42, title: "Fix retry handling", body: "Check error cases", state: "open", user: { login: "test-user" }, head: { ref: "fix/retry", sha: "a".repeat(40) }, base: { ref: "main" }, changed_files: 1 };
  const run = { id: 99, name: "CI", run_number: 16, head_branch: "main", status: "completed", conclusion: "failure", created_at: "2026-09-30T12:00:00Z" };
  const jobs = [
    { id: 12, name: "build (node 20)", status: "completed", conclusion: "success", steps: [{ number: 1, name: "Compile", status: "completed", conclusion: "success" }] },
    { id: 13, name: "build (node 22)", status: "completed", conclusion: "failure", steps: [{ number: 1, name: "Compile", status: "completed", conclusion: "success" }, { number: 2, name: "Test", status: "completed", conclusion: "failure" }] },
    { id: 14, name: "summary", status: "completed", conclusion: "skipped", steps: [] },
    { id: 15, name: "release", html_url: "https://github.com/test/repo/actions/runs/99/job/15", status: "in_progress", conclusion: null, steps: [{ number: 1, name: "Run tests", status: "in_progress", conclusion: null }] },
  ];
  await page.route("**/api/projects/*/git/github*", async (route) => {
    const request = route.request();
    const params = new URL(request.url()).searchParams;
    if (request.method() === "POST") { const action = request.postDataJSON(); writes.push(action); if (action.action === "close") pull.state = "closed"; if (action.action === "reopen") pull.state = "open"; if (action.action === "merge") pull.state = "closed"; return route.fulfill({ json: { id: 1, number: 43 } }); }
    if (params.get("op") === "pulls") return route.fulfill({ json: { repository: { owner: "test", repo: "repo" }, pulls: params.get("state") === pull.state ? [pull] : [] } });
    if (params.get("op") === "pull") return route.fulfill({ json: { pull, comments: [{ user: { login: "reviewer" }, body: "Please test cancellation" }], reviews: [], inline: [], files: [{ filename: "src/retry.ts", additions: 2, deletions: 1, status: "modified", patch: "@@ -1 +1 @@\n-old\n+new" }], truncated: { comments: false, reviews: false, inline: false, files: false } } });
    if (params.get("op") === "runs") return route.fulfill({ json: { runs: { workflow_runs: [run] } } });
    if (params.get("op") === "run") return route.fulfill({ json: { run, jobs, groups: [{ key: "build", needs: [], jobIds: [12, 13] }, { key: "summary", needs: ["build"], jobIds: [14, 15] }], truncated: false } });
    if (params.get("op") === "log") {
      const job = jobs.find((item) => item.id === Number(params.get("id")))!;
      if (params.get("id") === "15") {
        if (runningLog === "pending") return route.fulfill({ json: { job, text: "", truncated: false, steps: [], unavailable: "Task logs are not available yet. GitHub publishes downloadable logs after the job finishes." } });
        if (runningLog === "error") return route.fulfill({ status: 502, json: { error: "GitHub log download failed (HTTP 500)" } });
        if (runningLog === "delayed") { logRequested!(); await new Promise<void>((resolve) => { releaseLog = resolve; }); }
        const finishedJob = { ...job, status: "completed", conclusion: "success", steps: [
          { number: 1, name: "Run tests", status: "completed", conclusion: "success" },
          { number: 4, name: "Complete job", status: "completed", conclusion: "success" },
        ] };
        return route.fulfill({ json: { job: finishedJob, text: "release task output\ncleanup output", truncated: false, steps: [{ number: 1, text: "release task output" }, { number: 4, text: "cleanup output" }] } });
      }
      return route.fulfill({ json: { job, text: "compile output\nFAIL src/retry.ts", truncated: false, steps: [{ number: 1, text: "compile output" }, { number: 2, text: "FAIL src/retry.ts" }] } });
    }
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
  assert.equal((await page.getByTestId("git-hosting-graph-job-15").innerText()).replace(/\s+/g, " "), "◌ release");
  assert.equal(await page.getByTestId("git-hosting-nav-job-12").innerText(), "✓ build (node 20)");
  const failedTask = page.locator('[data-testid="git-hosting-step-2"]');
  await failedTask.locator(".git-hosting-log").waitFor();
  assert.match(await failedTask.innerText(), /FAIL src\/retry.ts/);
  assert.doesNotMatch(await failedTask.innerText(), /compile output/);
  const compileTask = page.locator('[data-testid="git-hosting-step-1"]');
  assert.equal(await compileTask.getByRole("button", { name: /Compile/ }).getAttribute("aria-expanded"), "false");
  await compileTask.getByRole("button", { name: /Compile/ }).click();
  assert.equal(await compileTask.locator(".git-hosting-log").innerText(), "compile output\n");
  assert.doesNotMatch(await compileTask.innerText(), /FAIL/);
  assert.equal(await page.getByTestId("git-hosting-job-log").count(), 0, "no combined log below the task list");
  await page.getByTestId("git-hosting-graph-job-15").click();
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const indicators = page.locator(".git-hosting-graph-job.is-running .git-hosting-status-mark, .git-hosting-step.is-running .git-hosting-status-mark" + (width > 700 ? ", .git-hosting-nav-job.is-running .git-hosting-status-mark" : ""));
    assert.equal(await indicators.count(), width > 700 ? 3 : 2, "running jobs and steps have dedicated visible indicators");
    for (const indicator of await indicators.all()) {
      const visual = await indicator.evaluate((element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height, border: parseFloat(style.borderTopWidth), animation: style.animationName };
      });
      assert.ok(visual.width >= 16 && visual.height >= 16, `running indicator must be at least 16px: ${JSON.stringify(visual)}`);
      assert.ok(visual.border >= 2, "running indicator has a clear stroke");
      assert.equal(visual.animation, "git-hosting-spin");
    }
  }
  const runningTask = page.getByTestId("git-hosting-step-1");
  await runningTask.getByRole("button", { name: /Run tests/ }).click();
  await runningTask.getByText(/not available yet/).waitFor();
  const focusedToggle = await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.testid);
  assert.equal(await runningTask.getByRole("link", { name: /GitHub/ }).getAttribute("href"), "https://github.com/test/repo/actions/runs/99/job/15#step:1:1");
  assert.equal(await page.locator("#gitReviewStatus").innerText(), "", "unpublished logs do not become a general output error");
  runningLog = "error";
  await runningTask.getByRole("button", { name: /Reload/ }).click();
  await runningTask.getByText(/HTTP 500/).waitFor();
  const errorLinkCount = await runningTask.getByRole("link", { name: /GitHub/ }).count();
  assert.equal(await page.locator("#gitReviewStatus").innerText(), "", "download errors stay with the expanded task");
  runningLog = "ready";
  await runningTask.getByRole("button", { name: "Try again" }).click();
  await runningTask.locator(".git-hosting-log").waitFor();
  assert.match(await runningTask.innerText(), /release task output/);
  assert.deepEqual({ cleanupTasks: await page.getByTestId("git-hosting-step-4").count(), focusedToggle, errorLinkCount }, {
    cleanupTasks: 1, focusedToggle: "git-hosting-step-toggle-1", errorLinkCount: 1,
  }, "reload discovers cleanup tasks, keyboard focus survives loading, and errors keep the GitHub link");
  await page.getByTestId("git-hosting-step-4").getByRole("button", { name: /Complete job/ }).click();
  assert.match(await page.getByTestId("git-hosting-step-4").innerText(), /cleanup output/);
  runningLog = "delayed";
  const requested = new Promise<void>((resolve) => { logRequested = resolve; });
  await runningTask.getByRole("button", { name: /Reload/ }).click();
  await requested;
  await page.getByTestId("git-hosting-graph-job-12").click();
  const oldResponse = page.waitForResponse((response) => new URL(response.url()).searchParams.get("op") === "log" && new URL(response.url()).searchParams.get("id") === "15");
  releaseLog!();
  await oldResponse;
  await page.getByTestId("git-hosting-step-1").getByRole("button", { name: /Compile/ }).click();
  await page.getByTestId("git-hosting-step-1").locator(".git-hosting-log").waitFor();
  assert.doesNotMatch(await page.locator(".git-hosting-job").innerText(), /release task output|HTTP 500/);
  await page.getByTestId("git-hosting-back").click();
  await page.getByTestId("git-hosting-run-row").waitFor();
});
