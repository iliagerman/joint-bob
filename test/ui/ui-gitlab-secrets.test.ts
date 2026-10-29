import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";

test("GitLab is selectable with its Tanuki logo and saves its URL and token", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-gitlab-secrets-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const server = await startDevNode(environment, node);
  let browser: Browser | undefined;
  try {
    browser = await launchChrome({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).waitFor();
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-secrets").click();
    await page.getByTestId("secret-type-select").click();
    await page.getByTestId("secret-type-select-search").fill("gitlab");
    const option = page.getByTestId("secret-type-select-option");
    assert.deepEqual(await option.allTextContents(), ["GitLab"]);
    const logo = await option.locator("svg path").getAttribute("d");
    assert.ok(logo?.startsWith("m23.6004 9.5927"), "GitLab uses the Tanuki mark, not the generic key");
    assert.equal(await option.locator("svg").evaluate((svg) => getComputedStyle(svg).color), "rgb(252, 109, 38)");
    await option.click();
    await page.getByTestId("secret-account-list").getByText("No GitLab accounts.").waitFor();
    await page.getByTestId("secret-account-add-button").click();
    assert.equal(await page.getByTestId("secret-account-provider-input").getAttribute("data-value"), "gitlab");
    assert.equal(await page.getByTestId("secret-account-provider-icon").locator("svg path").getAttribute("d"), logo);
    const names = ["GITLAB_URL", "GITLAB_TOKEN"];
    assert.deepEqual(await page.getByTestId("secret-variable-name-input").evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)), names);
    await page.getByTestId("secret-account-label-input").fill("Test GitLab");
    await page.getByTestId("secret-variable-value-input").nth(0).fill("https://gitlab.example.test");
    await page.getByTestId("secret-variable-value-input").nth(1).fill("synthetic-gitlab-token");
    const created = page.waitForResponse((response) => response.url().endsWith("/api/secrets/accounts") && response.request().method() === "POST");
    await page.getByTestId("secret-account-save-button").click();
    const response = await created;
    assert.equal(response.status(), 201);
    const body = await response.json();
    assert.equal(body.account.provider, "gitlab");
    assert.deepEqual(body.account.variables, names.map((name) => ({ name, kind: "value", configured: true })));
    await page.getByTestId("secret-account-dialog").waitFor({ state: "hidden" });
    const row = page.getByTestId("secret-account-list").locator('[data-provider="gitlab"]');
    await row.getByText("Test GitLab · GitLab").waitFor();
    assert.equal(await row.getByTestId("secret-account-provider-badge").locator("svg path").getAttribute("d"), logo);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
