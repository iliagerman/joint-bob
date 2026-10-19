import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { nativeUiFixture } from "./native-ui-fixture.js";

const exec = promisify(execFile);

test("project Git opens without a conversation, switches repositories, and issues combine selected projects", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t, () => ({ GH_TOKEN: "", GITHUB_TOKEN: "" }));
  const projects = node.projects.slice(0, 2);
  for (const project of projects) for (const repository of ["client", "server"]) {
    const cwd = path.join(project.path, repository);
    await mkdir(cwd, { recursive: true });
    await exec("git", ["-C", cwd, "init", "-b", "main"]);
    await writeFile(path.join(cwd, `${repository}.txt`), `${repository} file\n`);
  }
  const requests: string[] = [];
  let editedIssue: Record<string, unknown> | null = null;
  let rejectEdit = true;
  await page.route("**/api/projects/*/git/github*", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    const repository = url.searchParams.get("repository");
    const project = projects.find((item) => url.pathname.includes(item.id));
    if (route.request().method() === "POST") {
      if (rejectEdit) return route.fulfill({ status: 403, json: { error: "You do not have permission to edit this issue" } });
      editedIssue = route.request().postDataJSON();
      return route.fulfill({ json: { issue: { number: 1, title: editedIssue!.title, body: editedIssue!.body, state: editedIssue!.state, user: { login: "tester" }, labels: [], comments: 1, created_at: "2026-10-01T12:00:00Z", updated_at: "2026-10-03T12:00:00Z" } } });
    }
    if (project && url.searchParams.get("op") === "issue") return route.fulfill({ json: {
      repository: { owner: "fixture", repo: repository },
      issue: { number: 1, title: `${repository} issue`, state: "open", html_url: `https://github.com/fixture/${repository}/issues/1`, body: "Full **issue body** text", user: { login: "tester" }, labels: [], assignees: [], comments: 1, created_at: "2026-10-01T12:00:00Z", updated_at: "2026-10-02T12:00:00Z" },
      comments: [{ user: { login: "reviewer" }, body: "A fixture comment", created_at: "2026-10-02T12:00:00Z" }],
      truncated: false,
    } });
    if (!project || url.searchParams.get("op") !== "issues") return route.fulfill({ status: 400, json: { error: "Unexpected fixture request" } });
    if (project.id === projects[1].id && repository === "server") return route.fulfill({ status: 403, json: { error: "GitHub request failed (HTTP 403)" } });
    const secondPage = url.searchParams.get("page") === "2";
    const number = secondPage ? 2 : 1;
    return route.fulfill({ json: {
      repository: { owner: "fixture", repo: repository },
      issues: [{ number, title: secondPage ? "Older issue" : `${repository} issue`, state: url.searchParams.get("state") ?? "open", html_url: `https://github.com/fixture/${repository}/issues/${number}`, user: { login: "tester" }, labels: [{ name: "bug" }], assignees: [], comments: 0, created_at: "2026-10-01T12:00:00Z", updated_at: "2026-10-02T12:00:00Z" }],
      hasMore: !secondPage && repository === "client",
    } });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  const row = page.locator(`[data-project-id="${projects[0].id}"]`);
  await row.getByTestId("project-menu-button").click();
  await page.getByTestId("project-git-button").click();
  await page.getByTestId("git-review-repository").selectOption("client");
  await page.getByTestId("git-review-file").filter({ hasText: "client.txt" }).waitFor();
  await page.getByTestId("git-review-repository").selectOption("server");
  await page.getByTestId("git-review-file").filter({ hasText: "server.txt" }).waitFor();
  assert.equal(await page.getByTestId("git-review-file").filter({ hasText: "client.txt" }).count(), 0);
  await page.getByTestId("git-review-file").filter({ hasText: "server.txt" }).click();
  await page.getByTestId("git-review-diff").getByText("server file", { exact: true }).waitFor();
  const serverGit = path.join(projects[0].path, "server/.git");
  await rename(serverGit, `${serverGit}-unavailable`);
  await page.getByTestId("git-review-repository-refresh").click();
  await page.getByText("Selected repository is no longer available. Choose another repository explicitly.").waitFor();
  assert.equal(await page.getByTestId("git-review-repository").inputValue(), "server", "refresh never silently selects a different repository");
  assert.equal(await page.getByTestId("git-review-file").count(), 0);
  await page.getByTestId("git-review-repository").selectOption("client");
  await page.getByTestId("git-review-file").filter({ hasText: "client.txt" }).waitFor();
  await rename(`${serverGit}-unavailable`, serverGit);
  await page.getByTestId("git-review-close-button").click();
  await row.getByTestId("project-menu-button").click();
  await page.getByTestId("project-issues-button").click();
  await page.getByTestId("project-issue-row").filter({ hasText: "client issue" }).waitFor();
  assert.equal(await page.getByTestId("project-issue-row").count(), 2);
  const icon = page.getByTestId("project-issue-row").first().locator(".project-issue-state svg");
  assert.equal(await icon.evaluate((svg) => svg.namespaceURI), "http://www.w3.org/2000/svg");
  assert.equal(await icon.getAttribute("aria-hidden"), "true");
  assert.equal(await icon.locator("circle").count(), 2, "open issues have a ring and dot");
  await page.getByTestId("project-issues-projects-trigger").click();
  const projectSearch = page.getByTestId("project-issues-projects-search");
  await projectSearch.fill(projects[1].name);
  assert.equal(await page.getByTestId("project-issues-projects-option").count(), 1, "project dropdown filters even a short list");
  await page.getByTestId("project-issues-projects-option").click();
  await projectSearch.fill("no-such-project");
  await page.getByTestId("project-issues-projects-options").getByText("No projects found").waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByTestId("project-issues-dialog").evaluate((element: HTMLDialogElement) => element.open), true, "Escape closes dropdown, not issues");
  assert.match(await page.getByTestId("project-issues-projects-trigger").innerText(), new RegExp(projects[1].name));
  await page.getByTestId("project-issues-apply").click();
  await page.getByTestId("project-issues-errors").getByText(/GitHub request failed/).waitFor();
  assert.equal(await page.getByTestId("project-issue-row").count(), 2, "shared repository issues are deduplicated");
  assert.match(await page.getByTestId("project-issue-row").filter({ hasText: "client issue" }).innerText(), new RegExp(projects[1].name));
  await page.getByTestId("project-issues-more").click();
  await page.getByTestId("project-issue-row").filter({ hasText: "Older issue" }).waitFor();
  await page.getByTestId("project-issues-sort").selectOption("created-asc");
  await page.getByTestId("project-issue-link").first().click();
  await page.getByTestId("project-issue-detail").getByText("Full issue body").waitFor();
  await page.getByTestId("project-issue-detail").getByText("A fixture comment").waitFor();
  assert.match(await page.getByTestId("project-issue-github").getAttribute("href") ?? "", /^https:\/\/github\.com\/fixture\/.+\/issues\/1$/);
  assert.equal(await page.getByTestId("project-issue-start").count(), 1);
  assert.equal(await page.getByTestId("project-issue-start-worktree").count(), 1);
  await page.getByTestId("project-issue-edit").click();
  await page.getByTestId("project-issue-edit-title").fill("Discard this edit");
  await page.getByTestId("project-issue-edit-cancel").click();
  assert.equal(editedIssue, null, "cancel does not mutate GitHub");
  await page.getByTestId("project-issue-edit").click();
  await page.getByTestId("project-issue-edit-title").fill("Edited issue title");
  await page.getByTestId("project-issue-edit-body").fill("Edited **description**");
  await page.getByTestId("project-issue-edit-state").selectOption("closed");
  await page.getByTestId("project-issue-edit-save").click();
  await page.getByTestId("project-issue-edit-error").getByText(/permission/).waitFor();
  assert.equal(await page.getByTestId("project-issue-edit-title").inputValue(), "Edited issue title", "failed saves preserve edits");
  rejectEdit = false;
  await page.getByTestId("project-issue-edit-save").click();
  await page.getByTestId("project-issue-detail").getByRole("heading", { name: "Edited issue title #1" }).waitFor();
  await page.getByTestId("project-issue-detail").getByText("Edited description").waitFor();
  assert.deepEqual(editedIssue, { action: "edit-issue", number: 1, title: "Edited issue title", body: "Edited **description**", state: "closed" });
  await page.getByTestId("project-issue-back").click();
  assert.equal(await page.getByTestId("project-issue-row").filter({ hasText: "Edited issue title" }).count(), 0, "closed edit no longer matches the open filter");
  await page.getByTestId("project-issues-state").selectOption("closed");
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="project-issue-row"]')].length === 2 && [...document.querySelectorAll('[data-testid="project-issue-row"]')].every((row) => row.textContent?.includes("closed")));
  assert.equal(await icon.locator("circle").count(), 1, "closed issues retain their ring");
  assert.equal(await icon.locator("path").getAttribute("d"), "M5.5 8.2l1.8 1.8 3.2-3.5", "closed issues show a checkmark");
  await page.getByTestId("project-issues-search").fill("server");
  assert.equal(await page.getByTestId("project-issue-row").count(), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await page.getByTestId("project-issues-dialog").boundingBox();
  assert.ok(bounds && bounds.width <= 390, `issues fit mobile: ${JSON.stringify(bounds)}`);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("project-issues-search").fill("");
  await page.getByTestId("project-issue-link").first().click();
  await page.getByTestId("project-issue-detail").getByText("Full issue body").waitFor();
  await page.getByTestId("project-issue-start-worktree").click();
  await page.locator("#choiceDialog[open]").waitFor();
  await page.locator('#choiceDialog input[value="pi"]').check();
  await page.getByTestId("choice-accept-button").click();
  await page.locator("#newSessionNameDialog[open]").waitFor();
  assert.equal(await page.locator("#newSessionWorktreeSelect").inputValue(), "new", "starting from an issue preselects a new worktree");
  assert.match(await page.evaluate(async () => (await import("/app/state.js")).state.newSessionDraft.referenceDraft), /Full \*\*issue body\*\*[\s\S]*A fixture comment/);
  await page.keyboard.press("Escape");
  await page.locator("#newSessionNameDialog[open]").waitFor({ state: "hidden" });
  await row.getByTestId("project-menu-button").click();
  await page.getByTestId("project-issues-button").click();
  await page.getByTestId("project-issue-row").filter({ hasText: "client issue" }).getByTestId("project-issue-view").click();
  await page.getByTestId("project-issue-start").click();
  await page.locator('#choiceDialog input[value="pi"]').check();
  await page.getByTestId("choice-accept-button").click();
  await page.locator("#newSessionNameDialog[open]").waitFor();
  assert.notEqual(await page.locator("#newSessionWorktreeSelect").inputValue(), "new", "normal issue conversation does not force a new worktree");
  const draft = await page.evaluate(async () => (await import("/app/state.js")).state.newSessionDraft);
  assert.equal(draft.projectId, projects[0].id);
  assert.match(draft.referenceDraft, /Full \*\*issue body\*\*[\s\S]*A fixture comment/);
  await page.keyboard.press("Escape");
  assert.ok(requests.every((request) => request.includes("repository=")), "every issue request names its repository");
  assert.deepEqual(errors, []);
});
