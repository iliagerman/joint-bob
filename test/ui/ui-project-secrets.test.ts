import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser } from "playwright-core";
import { launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";

test("a secret account created from the project picker belongs to that project only", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-project-secrets-"));
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const project = node.projects[0];
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

    // Create straight from the project's picker: the form opens on top of it.
    await page.locator(`[data-project-id="${project.id}"] [data-testid="project-menu-button"]`).click();
    await page.getByTestId("project-secrets-button").click();
    const picker = page.getByTestId("secret-scope-dialog");
    await picker.waitFor();
    await page.getByTestId("secret-scope-add-button").click();
    const form = page.getByTestId("secret-account-dialog");
    await form.waitFor();
    await page.getByTestId("secret-account-provider-input").selectOption("custom");
    await page.getByTestId("secret-account-label-input").fill("Project token");
    await page.getByTestId("secret-variable-name-input").first().fill("PROJECT_TOKEN");
    await page.getByTestId("secret-variable-value-input").first().fill("synthetic-project-token");
    assert.equal(await page.getByTestId("secret-account-replicate-toggle").isDisabled(), true, "owned accounts cannot replicate");
    const createdResponse = page.waitForResponse((response) => response.url().endsWith("/api/secrets/accounts") && response.request().method() === "POST");
    await page.getByTestId("secret-account-save-button").click();
    const created = await createdResponse;
    assert.equal(created.status(), 201);
    const createdBody = await created.json() as { account: { id: string; projectId?: string } };
    assert.equal(createdBody.account.projectId, project.id);
    const accountId = createdBody.account.id;

    // The picker stays open, now listing the new account already ticked.
    await form.waitFor({ state: "hidden" });
    assert.equal(await picker.isVisible(), true);
    const row = picker.locator(".secret-scope-row", { hasText: "Project token" });
    await row.waitFor();
    assert.equal(await row.getByTestId("secret-scope-account-checkbox").isChecked(), true);
    await page.getByTestId("secret-scope-save-button").click();
    await picker.waitFor({ state: "hidden" });

    const session = await signIn(environment, node);
    const scope = await api<{ accountIds: string[] }>(node, session, "GET", `/secrets/scopes/project/${project.id}`);
    assert.deepEqual(scope.body.accountIds, [accountId]);

    // A workspace picker never offers a project-owned account, but since e6e851d it
    // can create a node-local one: only a project owns what its own picker creates.
    await page.getByTestId("settings-open-button").click();
    await page.getByTestId("settings-tab-workspaces").click();
    await page.getByTestId("workspace-secrets-button").first().click();
    await picker.waitFor();
    assert.equal(await picker.getByText("Project token").count(), 0, "workspace picker hides owned accounts");
    const workspaceLabel = ((await page.locator("#secretScopeTitle").textContent()) ?? "").replace(/^Secret accounts: /, "");
    assert.equal(await page.getByTestId("secret-scope-add-button").innerText(), "New secret account", "the workspace picker offers a node-local create button");
    await page.getByTestId("secret-scope-add-button").click();
    await form.waitFor();
    assert.equal(await page.locator("#secretAccountTitle").textContent(), "Add secret account", "the form is not project-scoped");
    await page.getByTestId("secret-account-provider-input").selectOption("custom");
    await page.getByTestId("secret-account-label-input").fill("Workspace token");
    await page.getByTestId("secret-variable-name-input").first().fill("WORKSPACE_TOKEN");
    await page.getByTestId("secret-variable-value-input").first().fill("synthetic-workspace-token");
    assert.equal(await page.getByTestId("secret-account-replicate-toggle").isDisabled(), false, "a node-local account may replicate");
    const workspaceCreated = page.waitForResponse((response) => response.url().endsWith("/api/secrets/accounts") && response.request().method() === "POST");
    await page.getByTestId("secret-account-save-button").click();
    const workspaceBody = await (await workspaceCreated).json() as { account: { id: string; projectId?: string } };
    assert.equal(workspaceBody.account.projectId, undefined, "a workspace picker creates an unowned account");
    await form.waitFor({ state: "hidden" });
    assert.equal(await picker.isVisible(), true);
    const workspaceRow = picker.locator(".secret-scope-row", { hasText: "Workspace token" });
    await workspaceRow.waitFor();
    assert.equal(await workspaceRow.getByTestId("secret-scope-account-checkbox").isChecked(), true, "the picker ticks what it just created");
    await page.getByTestId("secret-scope-save-button").click();
    await picker.waitFor({ state: "hidden" });

    const workspaces = await api<{ workspaces: Array<{ id: string; label: string }> }>(node, session, "GET", "/workspaces");
    const workspace = workspaces.body.workspaces.find((entry) => entry.label === workspaceLabel);
    assert.ok(workspace, `the picker targeted a seeded workspace (${workspaceLabel})`);
    const workspaceScope = await api<{ accountIds: string[] }>(node, session, "GET", `/secrets/scopes/workspace/${workspace.id}`);
    assert.deepEqual(workspaceScope.body.accountIds, [workspaceBody.account.id]);

    // Settings still lists both, the project one tagged with its project, so either can be edited or deleted.
    await page.getByTestId("settings-tab-secrets").click();
    await page.getByTestId("secret-account-list").getByText(`Project token · Custom · ${project.name}`, { exact: true }).waitFor();
    await page.getByTestId("secret-account-list").getByText("Workspace token · Custom", { exact: true }).waitFor();

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
