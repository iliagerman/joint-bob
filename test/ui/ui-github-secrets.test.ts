import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

type GithubSummary = { sshHost: string; owners: string[]; protocol: string; hasToken: boolean; hasApp: boolean; appId?: string; installationId?: string; hasSshKey: boolean; publicKey?: string; fingerprint?: string };

test("a GitHub account holds an API token and a generated SSH key with its routing", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-github-secrets-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser: Browser | undefined;
  try {
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
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
    await page.getByTestId("secret-account-provider-input-search").fill("github");
    await page.getByTestId("secret-account-provider-input-search").press("Enter");

    await page.getByTestId("secret-github-fields").waitFor();
    assert.equal(await page.getByTestId("secret-variable-rows").isVisible(), false, "generic variable rows are replaced");
    assert.equal(await page.getByTestId("secret-account-origin-input").isVisible(), false);
    assert.equal(await page.getByTestId("secret-github-protocol-https").isChecked(), true, "token-only default");

    await page.getByTestId("secret-account-label-input").fill("Work GitHub");
    await page.getByTestId("secret-github-token-input").fill("ghp_synthetic_ui_token");
    const generated = page.waitForResponse((response) => response.url().endsWith("/api/secrets/github-ssh-key"));
    await page.getByTestId("secret-github-ssh-key-generate-button").click();
    assert.equal((await generated).status(), 200);
    await page.getByTestId("secret-github-public-key").waitFor();
    const publicKey = await page.locator("#secretGithubPublicKeyText").innerText();
    assert.match(publicKey, /^ssh-ed25519 \S+ joint-bob$/);
    assert.match(await page.getByTestId("secret-github-fingerprint").innerText(), /^New key, stored when you save · SHA256:/);
    assert.match(await page.getByTestId("secret-github-ssh-key-input").inputValue(), /BEGIN OPENSSH PRIVATE KEY/);
    assert.equal(await page.getByTestId("secret-github-protocol-ssh").isChecked(), true, "a new key switches git to SSH");
    await page.getByTestId("secret-github-ssh-host-input").fill("work");
    await page.getByTestId("secret-github-owners-input").fill("acme, widgets");
    await page.screenshot({ path: path.join(root, "github-secret-form.png") });
    if (process.env.JB_UI_SCREENSHOT_DIR) await page.getByTestId("secret-account-dialog").screenshot({ path: path.join(process.env.JB_UI_SCREENSHOT_DIR, "github-secret-form.png") });

    const created = page.waitForResponse((response) => response.url().endsWith("/api/secrets/accounts") && response.request().method() === "POST");
    await page.getByTestId("secret-account-save-button").click();
    const response = await created;
    assert.equal(response.status(), 201);
    const { account } = await response.json() as { account: { id: string; github: GithubSummary } };
    assert.deepEqual({ ...account.github, fingerprint: undefined }, { sshHost: "work", owners: ["acme", "widgets"], protocol: "ssh", hasToken: true, hasApp: false, hasSshKey: true, publicKey, fingerprint: undefined });
    await page.getByTestId("secret-account-dialog").waitFor({ state: "hidden" });
    const row = page.getByTestId("secret-account-list").locator('.secret-account-row[data-provider="github"]');
    await row.getByText(/API token · SSH key SHA256:\S+ · host work · owners acme, widgets · git over SSH/).waitFor();

    // Editing shows the saved settings and public key, never the secrets.
    await row.getByTestId("secret-account-edit-button").click();
    assert.equal(await page.getByTestId("secret-github-token-input").inputValue(), "");
    assert.equal(await page.getByTestId("secret-github-ssh-key-input").inputValue(), "");
    assert.equal(await page.getByTestId("secret-github-ssh-host-input").inputValue(), "work");
    assert.equal(await page.getByTestId("secret-github-owners-input").inputValue(), "acme, widgets");
    assert.equal(await page.locator("#secretGithubPublicKeyText").innerText(), publicKey);
    assert.match(await page.getByTestId("secret-github-fingerprint").innerText(), /^Saved key · SHA256:/);

    // Removing the saved key falls back to HTTPS with the kept token.
    await page.getByTestId("secret-github-ssh-key-remove-button").click();
    assert.equal(await page.getByTestId("secret-github-protocol-https").isChecked(), true);
    const updated = page.waitForResponse((item) => item.url().endsWith(`/api/secrets/accounts/${account.id}`) && item.request().method() === "PUT");
    await page.getByTestId("secret-account-save-button").click();
    const { account: edited } = await (await updated).json() as { account: { github: GithubSummary } };
    assert.deepEqual(edited.github, { sshHost: "work", owners: ["acme", "widgets"], protocol: "https", hasToken: true, hasApp: false, hasSshKey: false });
    await row.getByText("API token · host work · owners acme, widgets · git over HTTPS").waitFor();

    await page.getByTestId("secret-account-add-button").click();
    await page.getByTestId("secret-account-provider-input-search").fill("github");
    await page.getByTestId("secret-account-provider-input-search").press("Enter");
    await page.getByTestId("secret-account-label-input").fill("Automation App");
    await page.getByTestId("secret-github-app-id-input").fill("123");
    await page.getByTestId("secret-github-installation-id-input").fill("456");
    const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await page.getByTestId("secret-github-app-key-input").fill(privateKey);
    const createdApp = page.waitForResponse((item) => item.url().endsWith("/api/secrets/accounts") && item.request().method() === "POST");
    await page.getByTestId("secret-account-save-button").click();
    const { account: app } = await (await createdApp).json() as { account: { id: string; github: GithubSummary } };
    assert.deepEqual(app.github, { sshHost: "github.com", owners: [], protocol: "https", hasToken: false, hasApp: true, appId: "123", installationId: "456", hasSshKey: false });
    const appRow = page.getByTestId("secret-account-list").locator('.secret-account-row[data-provider="github"]', { hasText: "Automation App" });
    await appRow.getByText(/GitHub App 123 \/ installation 456/).waitFor();
    await appRow.getByTestId("secret-account-edit-button").click();
    assert.equal(await page.getByTestId("secret-github-app-key-input").inputValue(), "");
    assert.equal(await page.getByTestId("secret-github-app-id-input").inputValue(), "123");
    assert.equal(await page.getByTestId("secret-github-installation-id-input").inputValue(), "456");
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
