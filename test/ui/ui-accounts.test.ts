import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { addMember, runOnNode } from "../node-script.js";

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

test("a member sees no admin entries, never calls an admin route, and saves only their own settings", { timeout: 150_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const member = addMember(environment, node, "noam", "noam@example.test");
  const missing: string[] = [];
  const errors: string[] = [];
  page.on("response", (response) => { if (response.url().includes("/api/") && response.status() === 404) missing.push(new URL(response.url()).pathname); });
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  await page.getByTestId("login-username-input").fill("noam@example.test");
  await page.getByTestId("login-password-input").fill(member.oneTimePassword);
  await page.getByTestId("login-submit-button").click();
  await page.getByTestId("login-new-password-input").waitFor({ state: "visible" });
  await page.getByTestId("login-password-input").fill(member.oneTimePassword);
  await page.getByTestId("login-new-password-input").fill("member-chosen-password-1");
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "detached", timeout: 30_000 }).catch(() => undefined);
  await page.waitForFunction(() => !document.querySelector("#loginDialog")?.hasAttribute("open"), undefined, { timeout: 30_000 });

  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-account").waitFor({ state: "visible" });
  for (const tab of ["node", "updates", "resources"]) assert.equal(await page.getByTestId(`settings-tab-${tab}`).isVisible(), false, `no ${tab} tab for a member`);
  const adminOnly = await page.evaluate(() => [...document.querySelectorAll("[data-admin-only]")].filter((element) => (element as HTMLElement).offsetParent !== null).length);
  assert.equal(adminOnly, 0, "no admin-only element is rendered for a member");
  assert.equal(await page.getByTestId("settings-conversation-retention-days").isVisible(), false);
  await page.getByTestId("settings-tab-engines").click();
  assert.equal(await page.locator("[data-testid$='-executable-input']").count(), 0, "no harness paths for a member");

  await page.getByTestId("settings-tab-labels").click();
  await page.locator("#settingsConversationLabels").fill("noam-label");
  await page.locator("#settingsForm [type='submit']").click();
  await page.getByText("Settings saved").waitFor();
  const saved = runOnNode(environment, node, `
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(process.env.JOINT_BOB_DATA_DIR + "/node.db", { readOnly: true });
    process.stdout.write(JSON.stringify({ own: db.prepare("SELECT payload FROM account_settings").all(), node: db.prepare("SELECT value FROM node_settings WHERE key = 'conversationLabels'").get() ?? null }));
  `);
  const { own, node: nodeLabels } = JSON.parse(saved.trim().split("\n").at(-1)!) as { own: Array<{ payload: string }>; node: { value: string } | null };
  assert.ok(own.some((row) => JSON.parse(row.payload).conversationLabels?.includes("noam-label")), "the member's labels are their own");
  assert.ok(!nodeLabels || !nodeLabels.value.includes("noam-label"), "the node's labels are untouched");
  assert.deepEqual(missing, [], "a member's client never asks for an admin route");
  assert.deepEqual(errors, []);
});
