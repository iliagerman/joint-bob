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
  await page.route("**/api/projects/*/git/github*", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    const repository = url.searchParams.get("repository");
    const project = projects.find((item) => url.pathname.includes(item.id));
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
  await page.getByTestId("project-issues-projects").selectOption(projects.map((project) => project.id));
  await page.getByTestId("project-issues-apply").click();
  await page.getByTestId("project-issues-errors").getByText(/GitHub request failed/).waitFor();
  assert.equal(await page.getByTestId("project-issue-row").count(), 2, "shared repository issues are deduplicated");
  assert.match(await page.getByTestId("project-issue-row").filter({ hasText: "client issue" }).innerText(), new RegExp(projects[1].name));
  await page.getByTestId("project-issues-more").click();
  await page.getByTestId("project-issue-row").filter({ hasText: "Older issue" }).waitFor();
  await page.getByTestId("project-issues-state").selectOption("closed");
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="project-issue-row"]')].length === 2 && [...document.querySelectorAll('[data-testid="project-issue-row"]')].every((row) => row.textContent?.includes("closed")));
  await page.getByTestId("project-issues-search").fill("server");
  assert.equal(await page.getByTestId("project-issue-row").count(), 1);
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await page.getByTestId("project-issues-dialog").boundingBox();
  assert.ok(bounds && bounds.width <= 390, `issues fit mobile: ${JSON.stringify(bounds)}`);
  assert.ok(requests.every((request) => request.includes("repository=")), "every issue request names its repository");
  assert.deepEqual(errors, []);
});
