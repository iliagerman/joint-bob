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
  assert.match(app, /project-type-secrets-button/);
  assert.match(app, /project-secrets-button/);
  for (const testid of ["secret-variable-name-input", "secret-variable-kind-select", "secret-variable-value-input", "secret-variable-remove-button", "secret-account-edit-button", "secret-account-delete-button", "secret-scope-account-checkbox"]) assert.ok(app.includes(testid));
  for (const selector of [".secret-account-list", ".secret-account-row", ".secret-account-meta", ".secret-variable-row", ".secret-scope-list"]) assert.ok(styles.includes(selector));
  assert.match(worker, /const CACHE_NAME = "joint-bob-v42";/);
});
