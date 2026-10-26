import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "../../src/types.js";
import { api, signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

// A missing picker, saving to the parent scope, or failing to reset after clear breaks this journey.
test("Activity Chat secret picker edits its own attachments and resets on clear", { timeout: 120_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const auth = await signIn(environment, node);
  const project = node.projects[0];
  const sessions = await api<{ sessions: SessionSummary[] }>(node, auth, "GET", `/projects/${project.id}/sessions`);
  const source = sessions.body.sessions.find(item => item.title === "Short one")!;
  const create = async (label: string) => {
    const result = await api<{ account: { id: string } }>(node, auth, "POST", "/secrets/accounts", {
      label, provider: "custom", variables: [{ name: `TEST_${label}`, kind: "value", value: "synthetic" }],
    });
    assert.equal(result.status, 201);
    return result.body.account.id;
  };
  const first = await create("FIRST");
  const extra = await create("EXTRA");
  const scopeUrl = `/secrets/scopes/conversation/${encodeURIComponent(`${source.harnessId}:${source.id}`)}`;
  assert.equal((await api(node, auth, "PUT", scopeUrl, { accountIds: [first] })).status, 200);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).click();
  await page.getByText("Short one", { exact: true }).click();
  await page.getByTestId("chat-message-input").fill("/bob-btw");
  await page.locator("#composer").evaluate((form: HTMLFormElement) => form.requestSubmit());
  const secrets = page.getByTestId("conversation-chat-secrets");
  await page.waitForFunction(() => document.querySelector("#conversationChatSecrets")?.textContent === "Secrets (1)");
  await secrets.click();
  await page.locator("#secretScopeDialog[open]").waitFor();
  const firstCheck = page.locator(`[data-testid="secret-scope-account-checkbox"][value="${first}"]`);
  const extraCheck = page.locator(`[data-testid="secret-scope-account-checkbox"][value="${extra}"]`);
  assert.equal(await firstCheck.isChecked(), true);
  assert.equal(await extraCheck.isChecked(), false);
  await extraCheck.check();
  await page.getByTestId("secret-scope-save-button").click();
  await page.locator("#secretScopeDialog[open]").waitFor({ state: "hidden" });
  assert.equal(await secrets.textContent(), "Secrets (2)");
  assert.deepEqual((await api(node, auth, "GET", scopeUrl)).body.accountIds, [first]);
  await page.getByTestId("conversation-chat-clear").click();
  await page.waitForFunction(() => document.querySelector("#conversationChatSecrets")?.textContent === "Secrets (1)");
  await secrets.click();
  await page.locator("#secretScopeDialog[open]").waitFor();
  assert.equal(await firstCheck.isChecked(), true);
  assert.equal(await extraCheck.isChecked(), false);
  await page.getByTestId("secret-scope-cancel-button").click();
  assert.deepEqual(errors, []);
});
