import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { api, signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("GitHub access errors let users retry with a scoped secret without exposing tokens or changing attachments", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t, (root) => {
    const preload = path.join(root, "github-fetch.mjs");
    writeFileSync(preload, `
      const original = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (!url.startsWith("https://api.github.com/")) return original(input, init);
        if (new Headers(init?.headers).get("authorization") !== "Bearer synthetic-working-token") return Response.json({}, { status: 404 });
        if (init?.method === "PATCH") return Response.json({ number: 42, state: "closed" });
        if (url.includes("/pulls?")) return Response.json([]);
        if (url.includes("/actions/runs?")) return Response.json({ workflow_runs: [{ id: 99, name: "CI", run_number: 16, head_branch: "main", status: "completed", conclusion: "success", created_at: "2026-09-30T12:00:00Z" }] });
        throw new Error("Unexpected synthetic GitHub request");
      };
    `);
    return { GH_TOKEN: "", GITHUB_TOKEN: "", NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${preload}` };
  });
  const session = await signIn(environment, node);
  const project = node.projects[0];
  await promisify(execFile)("git", ["-C", project.path, "init"]);
  await promisify(execFile)("git", ["-C", project.path, "remote", "add", "origin", "https://github.com/acme/private.git"]);
  const save = async (label: string, value: string, projectId?: string) => {
    const result = await api<{ account: { id: string } }>(node, session, "POST", "/secrets/accounts", { label, provider: "github", ...(projectId ? { projectId } : {}), variables: [{ name: "GH_TOKEN", kind: "value", value }] });
    assert.equal(result.status, 201);
    return result.body.account.id;
  };
  const wrong = await save("Wrong GitHub", "synthetic-wrong-token");
  const working = await save("Work GitHub", "synthetic-working-token");
  const outside = await save("Other project", "synthetic-outside-token", node.projects[1].id);
  assert.equal((await api(node, session, "PUT", `/secrets/scopes/project/${project.id}`, { accountIds: [wrong] })).status, 200);
  const base = `/projects/${project.id}/git/github`;
  assert.equal((await api(node, session, "GET", `${base}?op=runs`)).status, 404);

  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  await page.getByTestId("chat-git-button").click();
  await page.getByTestId("git-review-tab-pipelines").click();
  await page.locator(".git-hosting-error").getByText("GitHub request failed (HTTP 404)", { exact: true }).waitFor();
  const picker = page.getByTestId("git-hosting-account");
  await picker.waitFor();
  assert.deepEqual(await picker.locator("option").allTextContents(), ["Automatic", "Wrong GitHub", "Work GitHub"]);
  await picker.selectOption(working);
  await page.getByTestId("git-hosting-retry").click();
  await page.getByTestId("git-hosting-run-row").waitFor();
  await page.getByTestId("git-review-tab-pulls").click();
  await page.getByText("All pull requests", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("git-hosting-account").inputValue(), working, "selection survives tab switches");

  const choices = await api(node, session, "GET", `${base}?op=accounts`);
  assert.equal(choices.status, 200);
  assert.deepEqual(choices.body, { accounts: [{ id: wrong, label: "Wrong GitHub" }, { id: working, label: "Work GitHub" }] });
  assert.doesNotMatch(JSON.stringify(choices.body), /synthetic-.*-token/);
  assert.equal((await api(node, session, "GET", `${base}?op=runs&accountId=${working}`)).status, 200);
  assert.equal((await api(node, session, "POST", `${base}?accountId=${working}`, { action: "close", number: 42 })).status, 200);
  assert.equal((await api(node, session, "GET", `${base}?op=runs&accountId=${outside}`)).status, 404, "another project's secret must not be used");
  assert.equal((await api(node, session, "POST", `${base}?accountId=${outside}`, { action: "close", number: 42 })).status, 404);
  assert.equal((await api(node, session, "GET", `${base}?op=runs&accountId=invalid`)).status, 400);
  assert.equal((await api(node, session, "POST", `${base}?accountId=invalid`, { action: "close", number: 42 })).status, 400);
  assert.equal((await api(node, session, "GET", `${base}?op=runs&accountId=${working}&accountId=${wrong}`)).status, 400);
  assert.equal((await api(node, session, "POST", `${base}?accountId=${working}&accountId=${wrong}`, { action: "close", number: 42 })).status, 400);
  assert.deepEqual((await api(node, session, "GET", `/secrets/scopes/project/${project.id}`)).body, { accountIds: [wrong] });
  assert.equal((await api(node, session, "GET", `${base}?op=runs`)).status, 404, "explicit choice never changes automatic credentials");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("git-hosting-account").selectOption("");
  await page.getByTestId("git-hosting-retry").waitFor();
  await picker.waitFor();
  const bounds = await picker.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390, "secret picker fits mobile");
  await picker.selectOption(working);
  await page.getByTestId("git-hosting-retry").click();
  await page.getByText("All pull requests", { exact: true }).waitFor();
  await page.getByTestId("git-review-close-button").click();
  await page.evaluate(async (projectId) => {
    const { openGitReview } = await import("/app/git-review.js");
    await openGitReview(null, { tab: "pipelines", context: { projectId } });
  }, node.projects[1].id);
  await page.getByTestId("git-hosting-account").waitFor();
  assert.equal(await page.getByTestId("git-hosting-account").inputValue(), "", "another project never inherits the selected account");
});
