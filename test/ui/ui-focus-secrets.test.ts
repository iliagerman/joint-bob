import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "../../src/types.js";
import { api, signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("mobile Add secret searches existing accounts and attaches only to the open conversation", { timeout: 120_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  const auth = await signIn(environment, node);
  const project = node.projects[0];
  const sessions = await api<{ sessions: SessionSummary[] }>(node, auth, "GET", `/projects/${project.id}/sessions`);
  const source = sessions.body.sessions.find(item => item.title === "Short one")!;
  const create = async (label: string, projectId?: string) => {
    const result = await api<{ account: { id: string } }>(node, auth, "POST", "/secrets/accounts", {
      label, projectId, provider: "custom", variables: [{ name: "TEST_SECRET", kind: "value", value: "synthetic" }],
    });
    assert.equal(result.status, 201);
    return result.body.account.id;
  };
  const existing = await create("Already attached");
  const added = await create("Project deployment", project.id);
  await create("Other project", node.projects[1].id);
  await create("Global account");
  const projectScopeBefore = (await api(node, auth, "GET", `/secrets/scopes/project/${project.id}`)).body.accountIds;
  const scopeUrl = `/secrets/scopes/conversation/${encodeURIComponent(`${source.harnessId}:${source.id}`)}`;
  await api(node, auth, "PUT", scopeUrl, { accountIds: [existing] });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).click();
  await page.getByText("Short one", { exact: true }).click();
  await page.getByTestId("focus-controls-button").click();
  await page.getByTestId("focus-add-secret").click();
  assert.equal(await page.locator("#secretAccountDialog").isVisible(), false, "does not open account creation");
  const dialog = page.getByTestId("conversation-secret-dialog");
  await dialog.waitFor();
  const picker = page.getByTestId("conversation-secret");
  await picker.click();
  const options = page.getByTestId("conversation-secret-option");
  assert.deepEqual((await options.allTextContents()).sort(), ["Global account", "Project deployment"].sort());
  await page.getByTestId("conversation-secret-search").fill("deployment");
  assert.equal(await options.count(), 1);
  await options.click();
  await page.getByTestId("conversation-secret-cancel").click();
  assert.deepEqual((await api(node, auth, "GET", scopeUrl)).body.accountIds, [existing]);
  await page.getByTestId("focus-controls-button").click();
  await page.getByTestId("focus-add-secret").click();
  await picker.click();
  await page.getByTestId("conversation-secret-search").fill("deployment");
  await options.click();
  await page.getByTestId("conversation-secret-save").click();
  await dialog.waitFor({ state: "hidden" });
  assert.deepEqual((await api(node, auth, "GET", scopeUrl)).body.accountIds.sort(), [existing, added].sort());
  assert.deepEqual((await api(node, auth, "GET", `/secrets/scopes/project/${project.id}`)).body.accountIds, projectScopeBefore);
  assert.equal((await api<{ accounts: unknown[] }>(node, auth, "GET", "/secrets")).body.accounts.length, 4, "no secret account was created");
});
