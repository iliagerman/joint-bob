import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { type Browser } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

const run = promisify(execFile);

async function storedValuesMatch(home: string, dataDir: string, projectId: string, accountId: string, origin: string | null, password: string): Promise<boolean> {
  const script = origin
    ? `import {websiteCredentialSnapshot} from './src/secrets.ts';const a=websiteCredentialSnapshot(${JSON.stringify(projectId)}).find(a=>a.id===${JSON.stringify(accountId)});const v=Object.fromEntries((a?.variables??[]).map(v=>[v.name,v.value]));console.log(JSON.stringify(Boolean(a&&a.origin===${JSON.stringify(origin)}&&v.LOGIN_USERNAME==='synthetic-user'&&v.LOGIN_PASSWORD===${JSON.stringify(password)})))`
    : `import {genericSecretEnvironment} from './src/secrets.ts';const v=genericSecretEnvironment(${JSON.stringify(projectId)});console.log(JSON.stringify(v.LOGIN_USERNAME==='synthetic-user'&&v.LOGIN_PASSWORD===${JSON.stringify(password)}))`;
  const result = await run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(), env: { ...process.env, HOME: home, JOINT_BOB_DATA_DIR: dataDir },
  });
  return JSON.parse(result.stdout) as boolean;
}

test("website secrets stay masked, origin-bound, editable, and usable in project scope", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-website-secrets-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const projectId = node.projects[0].id;
  const server = await startDevNode(environment, node);
  let browser: Browser | undefined;
  try {
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-secrets").click();
    await page.getByTestId("secret-account-add-button").click();
    await page.getByTestId("secret-account-provider-input").selectOption("custom");
    const origin = page.getByTestId("secret-account-origin-input");
    await origin.fill("https://mobile.example");
    assert.equal(await page.getByTestId("secret-account-replicate-toggle").isDisabled(), true);
    await page.getByTestId("secret-account-label-input").fill("Mobile login");
    const names = page.getByTestId("secret-variable-name-input");
    const values = page.getByTestId("secret-variable-value-input");
    await names.first().fill("LOGIN_USERNAME");
    await values.first().fill("synthetic-user");
    await page.getByTestId("secret-variable-add-button").click();
    await names.nth(1).fill("LOGIN_PASSWORD");
    await values.nth(1).fill("synthetic-password");
    assert.deepEqual(await values.evaluateAll((items) => items.map((item) => ({ type: (item as HTMLInputElement).type, autocomplete: item.getAttribute("autocomplete") }))), [
      { type: "password", autocomplete: "new-password" }, { type: "password", autocomplete: "new-password" },
    ]);
    const createdResponse = page.waitForResponse((response) => response.url().endsWith("/api/secrets/accounts") && response.request().method() === "POST");
    await page.getByTestId("secret-account-save-button").click();
    const created = await createdResponse;
    assert.equal(created.status(), 201);
    const createdBody = await created.json() as { account: { id: string; websiteOrigin?: string; variables: Array<{ value?: string }> } };
    assert.equal(createdBody.account.websiteOrigin, "https://mobile.example");
    assert.equal(createdBody.account.variables.every((variable) => !("value" in variable)), true, "create response never exposes values");
    const accountId = createdBody.account.id;
    await page.getByText("https://mobile.example", { exact: true }).waitFor();

    const session = await signIn(environment, node);
    const listed = await api<{ accounts: Array<{ id: string; websiteOrigin?: string; variables: Array<{ name: string; configured: boolean; value?: string }> }> }>(node, session, "GET", "/secrets");
    const account = listed.body.accounts.find((item) => item.id === accountId);
    assert.ok(account);
    assert.equal(account.variables.every((item) => item.configured && !("value" in item)), true, "API exposes metadata, never values");

    await page.getByTestId("settings-cancel-button").click();
    await page.locator(`[data-project-id="${projectId}"] [data-testid="project-menu-button"]`).click();
    await page.getByTestId("project-secrets-button").click();
    await page.getByTestId("secret-scope-dialog").getByText("Mobile login — https://mobile.example", { exact: true }).waitFor();
    await page.getByTestId("secret-scope-account-checkbox").check();
    await page.getByTestId("secret-scope-save-button").click();
    const scope = await api<{ accountIds: string[] }>(node, session, "GET", `/secrets/scopes/project/${projectId}`);
    assert.deepEqual(scope.body.accountIds, [accountId]);
    assert.equal(await storedValuesMatch(environment.home, node.dataDir, projectId, accountId, "https://mobile.example", "synthetic-password"), true, "created website values are stored exactly after attachment");

    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-secrets").click();
    await page.getByTestId("secret-account-edit-button").click();
    assert.equal(await origin.inputValue(), "https://mobile.example");
    assert.deepEqual(await values.evaluateAll((items) => items.map((item) => (item as HTMLInputElement).value)), ["", ""]);
    await page.getByTestId("secret-account-save-button").click();
    assert.equal(await storedValuesMatch(environment.home, node.dataDir, projectId, accountId, "https://mobile.example", "synthetic-password"), true, "blank edit preserves both values");
    await page.getByTestId("secret-account-edit-button").click();
    await values.nth(1).fill("rotated-synthetic-password");
    await page.getByTestId("secret-account-save-button").click();
    assert.equal(await storedValuesMatch(environment.home, node.dataDir, projectId, accountId, "https://mobile.example", "rotated-synthetic-password"), true, "rotation preserves username and replaces password");
    await page.getByTestId("secret-account-edit-button").click();
    assert.equal(await values.nth(1).inputValue(), "");

    await page.getByTestId("secret-variable-kind-select").first().selectOption("file");
    await page.getByTestId("secret-account-save-button").click();
    await page.getByText(/Website credentials cannot contain file values/).waitFor();
    assert.equal(await page.getByTestId("secret-account-dialog").isVisible(), true);
    await page.getByTestId("secret-variable-kind-select").first().selectOption("value");
    await origin.fill("https://mobile.example/path");
    const rejected = page.waitForResponse((response) => response.url().includes(`/api/secrets/accounts/${accountId}`) && response.request().method() === "PUT");
    await page.getByTestId("secret-account-save-button").click();
    assert.equal((await rejected).status(), 400, "path origin is rejected");
    assert.equal(await page.getByTestId("secret-account-dialog").isVisible(), true);
    assert.equal(await storedValuesMatch(environment.home, node.dataDir, projectId, accountId, "https://mobile.example", "rotated-synthetic-password"), true, "rejected saves preserve stored values");

    await origin.fill("https://mobile.example");
    assert.deepEqual(await values.evaluateAll((items) => items.map((item) => (item as HTMLInputElement).type)), ["password", "password"]);
    await mkdir("tmp", { recursive: true });
    for (const [width, file] of [[1440, "desktop"], [390, "mobile"]] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByTestId("secret-account-dialog").evaluate((dialog) => { dialog.scrollTop = 0; dialog.querySelector(".dialog-card")!.scrollTop = 0; });
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const geometry = await page.getByTestId("secret-account-dialog").evaluate((dialog) => {
        const box = dialog.getBoundingClientRect();
        const heading = dialog.querySelector("h2")!.getBoundingClientRect();
        return { fits: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && [...dialog.querySelectorAll("input, textarea, select")].every((control) => control.getBoundingClientRect().right <= box.right), headingVisible: heading.top >= box.top && heading.bottom <= box.bottom };
      });
      assert.deepEqual(geometry, { fits: true, headingVisible: true }, `${width}px bound dialog, heading, and fields fit viewport`);
      await page.screenshot({ path: `tmp/website-secrets-${file}.png` });
    }

    await values.first().fill("new-unsaved-synthetic-value");
    await origin.fill("");
    assert.equal(await values.first().inputValue(), "new-unsaved-synthetic-value");
    await origin.fill("https://mobile.example");
    assert.equal(await values.first().inputValue(), "new-unsaved-synthetic-value");
    await page.getByTestId("secret-account-cancel-button").click();
    await page.getByTestId("secret-account-dialog").waitFor({ state: "hidden" });
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="secret-variable-value-input"]')].every((item) => (item as HTMLInputElement).value === ""));
    assert.deepEqual(await values.evaluateAll((items) => items.map((item) => (item as HTMLInputElement).value)), ["", ""], "cancel clears secret controls in the hidden DOM");

    await page.getByTestId("secret-account-edit-button").click();
    await origin.fill("");
    assert.equal(await page.getByTestId("secret-account-replicate-toggle").isEnabled(), true);
    assert.deepEqual(await values.evaluateAll((items) => items.map((item) => item.tagName)), ["TEXTAREA", "TEXTAREA"]);
    const unboundResponse = page.waitForResponse((response) => response.url().includes(`/api/secrets/accounts/${accountId}`) && response.request().method() === "PUT");
    await page.getByTestId("secret-account-save-button").click();
    const unbound = await unboundResponse;
    assert.equal(unbound.status(), 200);
    const unboundBody = await unbound.json() as { account: { websiteOrigin?: string } };
    assert.equal(unboundBody.account.websiteOrigin, undefined);
    await page.getByTestId("secret-account-edit-button").click();
    assert.equal(await origin.inputValue(), "");
    assert.deepEqual(await values.evaluateAll((items) => items.map((item) => (item as HTMLTextAreaElement).value)), ["", ""]);
    assert.equal(await storedValuesMatch(environment.home, node.dataDir, projectId, accountId, null, "rotated-synthetic-password"), true, "unbind exports preserved rotated values to generic environment");
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});

test("a website account is created from the workspace picker and attaches to that workspace", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-workspace-secrets-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser: Browser | undefined;
  try {
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();

    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-workspaces").click();
    const workspaceRow = page.getByTestId("workspace-row").first();
    const workspaceId = (await workspaceRow.locator("code").textContent())!.replace(/^\//, "");
    await workspaceRow.getByTestId("workspace-secrets-button").click();
    // The picker creates the account it is missing, instead of sending the user to Settings.
    await page.getByTestId("secret-scope-add-button").click();
    await page.getByTestId("secret-account-provider-input").selectOption("website");
    await page.getByTestId("secret-account-origin-input").fill("https://workspace.example");
    await page.getByTestId("secret-account-label-input").fill("Workspace login");
    const values = page.getByTestId("secret-variable-value-input");
    await values.first().fill("synthetic-user");
    await values.nth(1).fill("synthetic-password");
    const createdResponse = page.waitForResponse((response) => response.url().endsWith("/api/secrets/accounts") && response.request().method() === "POST");
    await page.getByTestId("secret-account-save-button").click();
    const createdBody = await (await createdResponse).json() as { account: { id: string; websiteOrigin?: string } };
    assert.equal(createdBody.account.websiteOrigin, "https://workspace.example");

    // It comes back ticked, so saving the picker attaches it without a second pass.
    const checkbox = page.getByTestId("secret-scope-account-checkbox").first();
    await checkbox.waitFor();
    assert.equal(await checkbox.isChecked(), true);
    await page.getByTestId("secret-scope-save-button").click();
    await page.getByTestId("secret-scope-dialog").waitFor({ state: "hidden" });

    const session = await signIn(environment, node);
    const scope = await api<{ accountIds: string[] }>(node, session, "GET", `/secrets/scopes/workspace/${workspaceId}`);
    assert.deepEqual(scope.body.accountIds, [createdBody.account.id]);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
