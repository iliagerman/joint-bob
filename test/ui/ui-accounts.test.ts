import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  await page.getByTestId("settings-tab-account").click();
  await page.getByTestId("my-nodes-row").first().waitFor();
  assert.equal(await page.getByTestId("my-nodes-status").first().textContent(), "Home", "My nodes starts with this, their home");
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

test("a local user changes their email from Account settings without changing their account", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 30_000 });

  const before = await page.evaluate(async () => (await fetch("/api/auth/status")).json());
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-account").click();
  const email = page.getByTestId("settings-email-input");
  await email.waitFor({ state: "visible" });
  await page.waitForFunction((expected) => document.querySelector<HTMLInputElement>("#settingsEmail")?.value === expected, `${environment.username}@example.test`);
  assert.equal(await email.inputValue(), `${environment.username}@example.test`);
  await email.fill("Dev.Updated@Example.test");
  await page.getByTestId("settings-change-email-button").click();
  await page.getByTestId("settings-email-status").getByText("Email changed to dev.updated@example.test").waitFor();
  const after = await page.evaluate(async () => (await fetch("/api/auth/status")).json());
  assert.equal(after.accountId, before.accountId, "changing email keeps the account");
  assert.equal(after.email, "dev.updated@example.test");
  assert.equal(await email.inputValue(), "dev.updated@example.test");
  await page.getByTestId("settings-logout-button").click();
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill("DEV.UPDATED@EXAMPLE.TEST");
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).waitFor();
  const signedIn = await page.evaluate(async () => (await fetch("/api/auth/status")).json());
  assert.equal(signedIn.accountId, before.accountId, "the new email signs in to the same account");
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
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden", timeout: 30_000 });

  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-account").waitFor({ state: "visible" });
  for (const tab of ["node", "updates", "resources"]) assert.equal(await page.getByTestId(`settings-tab-${tab}`).isVisible(), false, `no ${tab} tab for a member`);
  const adminOnly = await page.evaluate(() => [...document.querySelectorAll("[data-admin-only]")].filter((element) => (element as HTMLElement).offsetParent !== null).length);
  assert.equal(adminOnly, 0, "no admin-only element is rendered for a member");
  assert.equal(await page.getByTestId("settings-conversation-retention-days").isVisible(), false);
  await page.getByTestId("settings-tab-engines").click();
  assert.equal(await page.locator("[data-testid$='-executable-input']").count(), 0, "no harness paths for a member");

  await page.getByTestId("settings-tab-labels").click();
  await page.locator('[data-testid="settings-save-button"]:enabled').waitFor();
  await page.locator("#settingsConversationLabels").fill("noam-label");
  await page.getByTestId("settings-save-button").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#settingsForm [type='submit']")?.disabled, undefined, { timeout: 40_000 });
  const saving = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/settings/personal" && response.request().method() === "PUT");
  await page.locator("#settingsForm [type='submit']").click();
  const response = await saving;
  assert.equal(response.status(), 200);
  assert.deepEqual(response.request().postDataJSON().conversationLabels, ["noam-label"]);
  assert.deepEqual((await response.json()).conversationLabels, ["Research", "Bug", "Feature", "POC", "Deploy to prod", "Hotfix", "noam-label"]);
  await page.getByText("Settings saved", { exact: true }).waitFor();
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

test("a user message shows who wrote it, live and after a reload", { timeout: 150_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t, (root) => ({ JOINT_BOB_TEST_ENGINE_LOG: path.join(root, "engine.log") }));
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).click();
  await page.getByText("Short one", { exact: true }).click();
  await page.getByTestId("chat-message-input").fill("who wrote this");
  await page.locator("#composer").evaluate((form: HTMLFormElement) => form.requestSubmit());
  await page.locator("#messages").getByText("stubbed response", { exact: true }).last().waitFor();
  const bubble = page.locator("#messages .message.user").filter({ hasText: "who wrote this" }).last();
  assert.equal(await bubble.getByTestId("message-author").textContent(), `${environment.username}@example.test`, "the live bubble names its author");
  await page.reload({ waitUntil: "domcontentloaded" });
  const reloaded = page.locator("#messages .message.user").filter({ hasText: "who wrote this" }).last();
  await reloaded.waitFor();
  assert.equal(await reloaded.getByTestId("message-author").textContent(), `${environment.username}@example.test`, "the reloaded bubble keeps its author");
  assert.equal(await page.locator("#messages .message.user").filter({ hasText: "Single short line" }).getByTestId("message-author").count(), 0, "messages from before authors existed show no name");
});

test("the admin adds a person in Users, who signs in with the one-time password", { timeout: 150_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t, () => ({ JOINT_BOB_TEST_MULTI_USER_READY: "1" }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-users").click();
  await page.getByTestId("users-row").first().waitFor();
  await page.getByTestId("users-add-username").fill("lior");
  await page.getByTestId("users-add-email").fill("lior@example.test");
  await page.getByTestId("users-add-button").click();
  await page.getByTestId("users-one-time").waitFor({ state: "visible" });
  const oneTime = await page.getByTestId("users-one-time").textContent();
  const password = /: (\S+) —/.exec(oneTime ?? "")?.[1];
  assert.ok(password, `the one-time password is shown once: ${oneTime}`);
  await page.getByTestId("users-row").filter({ hasText: "lior@example.test" }).waitFor();

  const memberContext = await page.context().browser()!.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
  t.after(() => memberContext.close());
  const member = await memberContext.newPage();
  await member.goto(node.url, { waitUntil: "domcontentloaded" });
  await member.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  await member.getByTestId("login-username-input").fill("lior@example.test");
  await member.getByTestId("login-password-input").fill(password!);
  await member.getByTestId("login-submit-button").click();
  await member.getByTestId("login-new-password-input").waitFor({ state: "visible" });
  await member.getByTestId("login-password-input").fill(password!);
  await member.getByTestId("login-new-password-input").fill("lior-chosen-password-1");
  await member.getByTestId("login-submit-button").click();
  await member.waitForFunction(() => !document.querySelector("#loginDialog")?.hasAttribute("open"), undefined, { timeout: 30_000 });
  assert.equal(await member.getByText("Internal Assistant", { exact: true }).count(), 0, "the new person sees none of the admin's projects");

  await page.getByTestId("users-row").filter({ hasText: "lior@example.test" }).getByTestId("users-toggle").click();
  await page.getByTestId("users-row").filter({ hasText: "lior@example.test" }).getByText("Disabled").waitFor();
  assert.deepEqual(errors, []);
});

test("the admin runs the self-test, sees what failed, and turns multi-user mode on once it passes", { timeout: 150_000 }, async (t) => {
  let homes = "";
  const { page, environment, node } = await nativeUiFixture(t, (root) => (homes = path.join(root, "homes"), {
    JOINT_BOB_USERCTL: path.resolve("test/fixtures/fake-userctl.sh"),
    JOINT_BOB_USERCTL_SUDO: "0",
    JOINT_BOB_ACCOUNT_HOME_ROOT: path.join(root, "homes"),
  }));
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-users").click();
  await page.getByTestId("users-self-test-button").waitFor({ state: "visible" });
  assert.match(await page.getByTestId("users-multi-user-status").textContent() ?? "", /helper is installed/);
  assert.equal(await page.getByTestId("users-add-button").isDisabled(), true, "no one can be added before the wall is up");
  assert.equal(await page.getByTestId("users-enable-button").isVisible(), false);

  // The stand-in helper keeps one OS user, so the wall really is down and the test says so.
  await page.getByTestId("users-self-test-button").click();
  await page.getByTestId("users-self-test-findings").waitFor({ state: "visible", timeout: 60_000 });
  assert.match(await page.getByTestId("users-self-test-findings").textContent() ?? "", /Failed: One account can read another's home/);
  assert.match(await page.getByTestId("users-multi-user-status").textContent() ?? "", /didn't pass/);
  assert.equal(await page.getByTestId("users-enable-button").isVisible(), false, "a failed self-test can't be turned on");

  // On a machine where it passes, the admin turns the mode on after confirming in place.
  runOnNode(environment, node, `
    const { recordSelfTest } = await import(${JSON.stringify(path.resolve("src/multi-user.ts"))});
    recordSelfTest(true, [], true);
  `);
  await page.keyboard.press("Escape");
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 30_000 });
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-users").click();
  await page.getByTestId("users-enable-button").waitFor({ state: "visible" });
  // What the admin's agents left in the service account moves with them, as a copy.
  const transcript = path.join(environment.home, ".claude", "projects", "-work", "old-conversation.jsonl");
  await mkdir(path.dirname(transcript), { recursive: true });
  await writeFile(transcript, "{}\n");
  await writeFile(path.join(environment.home, ".claude.json"), JSON.stringify({ mcpServers: {} }));
  await page.getByTestId("users-enable-button").click();
  await page.getByTestId("users-enable-confirm").waitFor({ state: "visible" });
  await page.getByTestId("users-enable-confirm-button").click();
  await page.getByTestId("users-status").getByText("Multi-user mode is on. You can add people now.").waitFor({ timeout: 60_000 });
  assert.match(await page.getByTestId("users-multi-user-status").textContent() ?? "", /Multi-user mode is on/);
  assert.equal(await page.getByTestId("users-mode-actions").isVisible(), false);
  assert.equal(await page.getByTestId("users-add-button").isDisabled(), false, "people can be added now");
  const adminHome = path.join(homes, `jb-${environment.username.toLowerCase()}`);
  assert.equal(await readFile(path.join(adminHome, ".claude", "projects", "-work", "old-conversation.jsonl"), "utf8"), "{}\n", "their transcripts are in their own home");
  assert.ok(await readFile(path.join(adminHome, ".claude", ".claude.json"), "utf8"), "with Claude's settings where their Claude reads them");
  assert.ok(await readFile(transcript, "utf8"), "and the service keeps its copy");
  assert.deepEqual(errors, []);
});
