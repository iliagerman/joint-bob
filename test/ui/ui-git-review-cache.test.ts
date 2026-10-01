import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("Git review animates while the agent works and restores the saved review on reopen", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const status = { branch: "main", ahead: 0, behind: 0, detached: false, staged: [], unstaged: [
    { path: "app.ts", kind: "modified", staged: false },
  ], untracked: [], clean: false };
  const scopeRequests: string[] = [];
  let guidePosts = 0;
  let releaseScope = () => {};
  let scopeGate = new Promise<void>((resolve) => { releaseScope = resolve; });
  const guide = { summary: "Saved summary", items: [{ path: "app.ts", priority: "high", title: "Saved item", explanation: "Explained", checks: "Run it" }] };
  await page.route("**/api/projects/*/git/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/status")) return route.fulfill({ json: status });
    if (url.pathname.endsWith("/scope")) {
      scopeRequests.push(url.searchParams.get("refresh") ?? "");
      await scopeGate;
      return route.fulfill({ json: { paths: ["app.ts"], lastHarness: "claude" } });
    }
    if (url.pathname.endsWith("/guide-latest")) return route.fulfill({ json: guidePosts ? { thread: { id: "saved" }, scope: "conversation", paths: ["app.ts"], guide, patches: { "app.ts": "@@ -1 +1 @@\n-a\n+b" }, fingerprint: "f" } : { latest: null } });
    if (url.pathname.endsWith("/guide")) {
      guidePosts += 1;
      return route.fulfill({ json: { thread: { id: "saved" }, fingerprint: "f", patches: { "app.ts": "@@ -1 +1 @@\n-a\n+b" }, guide } });
    }
    if (url.pathname.endsWith("/diff")) return route.fulfill({ json: { patch: "@@ -1 +1 @@\n-a\n+b", binary: false, truncated: false } });
    return route.fulfill({ status: 404, json: { error: "Unexpected Git request" } });
  });
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  await page.getByTestId("chat-git-button").click();
  await page.getByTestId("git-review-loading").waitFor();
  assert.match(await page.getByTestId("git-review-loading").innerText(), /coding agent/i);
  releaseScope();
  await page.getByTestId("git-review-file").first().waitFor();
  assert.equal(await page.getByTestId("git-review-loading").count(), 0);
  await page.getByTestId("git-review-generate").click();
  await page.getByTestId("git-review-guide").getByText("Saved item", { exact: false }).waitFor();
  await page.getByTestId("git-review-close-button").click();
  await page.getByTestId("chat-git-button").click();
  await page.getByTestId("git-review-guide").getByText("Saved item", { exact: false }).waitFor();
  assert.equal(guidePosts, 1, "reopening restores the saved review without asking the agent again");
  assert.deepEqual(scopeRequests, ["", ""], "opening uses the cached scope; only Refresh forces a new check");
  scopeGate = new Promise<void>((resolve) => { releaseScope = resolve; });
  await page.getByTestId("git-review-refresh-scope").click();
  await page.getByTestId("git-review-loading").waitFor();
  releaseScope();
  await page.getByTestId("git-review-file").first().waitFor();
  assert.deepEqual(scopeRequests, ["", "", "1"]);
});
