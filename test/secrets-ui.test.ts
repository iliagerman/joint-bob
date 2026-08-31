import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("secret accounts have an accessible node-local UI using authenticated api calls", async () => {
  const [html, app, styles, worker] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("public/sw.js", "utf8"),
  ]);
  assert.match(html, /data-settings-tab="github"[^>]*>Secrets/);
  assert.match(html, /data-testid="secret-account-list"/);
  assert.match(html, /data-testid="secret-account-dialog"/);
  assert.match(html, /data-testid="secret-scope-dialog"/);
  assert.match(html, /File entries store their content privately/);
  assert.match(app, /async function api\(path, options = \{\}\)/);
  assert.match(app, /api\("\/api\/secrets"\)/);
  assert.match(app, /api\(`\/api\/secrets\/scopes/);
  assert.match(app, /AWS_ACCESS_KEY_ID/);
  assert.match(app, /AWS_SECRET_ACCESS_KEY/);
  assert.match(app, /GOOGLE_APPLICATION_CREDENTIALS/);
  assert.match(app, /workspace-secrets-button/);
  assert.match(app, /project-secrets-button/);
  for (const testid of ["secret-variable-name-input", "secret-variable-kind-select", "secret-variable-value-input", "secret-variable-remove-button", "secret-account-edit-button", "secret-account-delete-button", "secret-scope-account-checkbox"]) assert.ok(app.includes(testid));
  for (const selector of [".secret-account-list", ".secret-account-row", ".secret-account-meta", ".secret-variable-row", ".secret-scope-list"]) assert.ok(styles.includes(selector));
  assert.match(worker, /const CACHE_NAME = "joint-bob-v71";/);
});

test("every secret provider carries a brand icon in the list, the picker, and the scope dialog", async () => {
  const [html, app, styles] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);
  assert.match(html, /<option value="github">GitHub<\/option>/);
  assert.match(html, /data-testid="secret-account-provider-icon"/);
  assert.match(app, /function providerIcon\(provider\)/);
  for (const provider of ["aws", "google", "github", "custom"]) assert.ok(new RegExp(`\\b${provider}:\\s*\\[`).test(app), `providerIconPaths is missing ${provider}`);
  assert.match(app, /data-testid="secret-account-provider-badge"|secret-account-provider-badge/);
  for (const selector of [".secret-provider-icon", ".secret-provider-icon.aws", ".secret-provider-icon.google", ".secret-provider-icon.github", ".secret-provider-icon.custom"]) assert.ok(styles.includes(selector), `styles are missing ${selector}`);
});

test("GitHub is a built-in provider whose preset is an API token", async () => {
  const [app, server, secrets] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("src/server.ts", "utf8"),
    readFile("src/secrets.ts", "utf8"),
  ]);
  assert.match(app, /GH_TOKEN/);
  assert.match(app, /GITHUB_TOKEN/);
  assert.match(server, /z\.enum\(\["aws", "google", "github", "custom"\]\)/);
  assert.match(secrets, /"aws" \| "google" \| "github" \| "custom"/);
});

test("the GitHub credential group surfaces are gone, replaced by workspace-scoped accounts", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);
  for (const removed of ["githubGroupDialog", "githubSyncDialog", "githubGroupList", "projectGithubDialog", "project-github-button"]) {
    assert.doesNotMatch(html, new RegExp(removed), removed);
    assert.doesNotMatch(app, new RegExp(removed), removed);
  }
  assert.doesNotMatch(app, /\/api\/github-auth/);
  assert.match(html, /<legend>Workspaces<\/legend>/);
  assert.match(app, /api\("\/api\/workspaces"\)/);
});

test("accounts attach at all three scopes and carry a replication toggle", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);
  for (const testid of ["workspace-secrets-button", "project-secrets-button", "conversation-secrets-checkbox"]) {
    assert.ok(app.includes(testid), testid);
  }
  assert.match(html, /data-testid="secret-account-replicate-toggle"/);
  assert.match(app, /secretAccountReplicateInput\.checked/);
  assert.match(app, /api\("\/api\/secrets\/sync"/);
  assert.match(html, /data-testid="secret-sync-dialog"/);
});

test("the new-conversation dialog picks the accounts the conversation starts with", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);
  assert.match(html, /data-testid="conversation-secrets-list"/);
  // The environment is composed once at spawn, so the picks travel with the socket.
  assert.match(app, /newSessionSecretAccountIds/);
  assert.match(app, /searchParams\.set\("secretAccountIds"/);
});

test("switching provider replaces the previous provider preset instead of keeping it", async () => {
  const app = await readFile("public/app.js", "utf8");
  const handler = /secretAccountProviderInput\.addEventListener\("change",[\s\S]*?\n\}\);/.exec(app)?.[0] ?? "";
  assert.ok(handler, "provider change handler is missing");
  // The old guard bailed out whenever the previous preset had added a second row,
  // which is exactly why AWS fields survived a switch to Google.
  assert.doesNotMatch(handler, /secretVariableRows\.children\.length > 1/);
  assert.match(handler, /applySecretProviderPreset|secretProviderPresets/);
  assert.match(app, /function secretProviderPresets\(provider\)/);
});

test("Google accounts paste service account JSON into a private file entry", async () => {
  const [app, html] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/index.html", "utf8"),
  ]);
  assert.match(app, /Paste the Google service account JSON/);
  assert.match(app, /JSON\.parse/);
  assert.match(app, /Google credentials must be valid JSON/);
  assert.match(html, /data-testid="secret-account-provider-hint"/);
});
