import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("the admin signs in by email, sees the Node tab, and an account without an email is asked for one", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  assert.equal(await page.locator("#loginUsernameText").textContent(), "Username or email");
  assert.equal(await page.getByTestId("login-email-input").isVisible(), false, "signing in asks for no email");
  await page.getByTestId("login-username-input").fill(`${environment.username}@example.test`);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 30_000 });

  await page.getByTestId("settings-open-button").click();
  const nodeTab = page.getByTestId("settings-tab-node");
  await nodeTab.waitFor({ state: "visible" });
  await nodeTab.click();
  await page.getByTestId("node-block-list").getByText("No node is blocked.").waitFor();
  assert.match(await page.getByTestId("node-block-status").textContent() ?? "", /No other node to block/);
  await page.keyboard.press("Escape");

  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  db.prepare("UPDATE users SET email = NULL").run();
  db.close();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  assert.equal(await page.getByTestId("login-submit-button").textContent(), "Save email");
  assert.equal(await page.getByTestId("login-password-input").isVisible(), false, "a signed-in user isn't asked for a password again");
  await page.getByTestId("login-email-input").fill("Dev.New@Example.test");
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 30_000 });
  const saved = new DatabaseSync(path.join(node.dataDir, "node.db"), { readOnly: true });
  assert.equal((saved.prepare("SELECT email FROM users").get() as { email: string }).email, "dev.new@example.test");
  saved.close();
  assert.deepEqual(errors, []);
});

test("a member never sees the Node tab", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  db.prepare("UPDATE users SET role = 'member'").run();
  db.close();
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-account").waitFor({ state: "visible" });
  assert.equal(await page.getByTestId("settings-tab-node").isVisible(), false, "no Node tab for a member");
  assert.equal(await page.getByTestId("settings-panel-node").isVisible(), false);
  const status = await page.evaluate(async () => (await fetch("/api/node-blocks")).status);
  assert.equal(status, 404, "and the server has no such route for a member");
});
