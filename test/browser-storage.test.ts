import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function functionSource(app: string, name: string, nextName: string): string {
  const start = app.indexOf(`function ${name}`);
  const end = app.indexOf(`function ${nextName}`, start);
  assert.ok(start >= 0, `Missing ${name}`);
  assert.ok(end > start, `Missing end of ${name}`);
  return app.slice(start, end);
}

test("browser storage is limited to one-time legacy preference migration", async () => {
  const app = await readFile("public/app.js", "utf8");
  const migrationStart = app.indexOf("async function migrateLegacyPreferences");
  const migrationEnd = app.indexOf("function showSignedOut", migrationStart);
  assert.ok(migrationStart >= 0, "Missing legacy preference migration");
  assert.ok(migrationEnd > migrationStart, "Missing end of legacy preference migration");
  const migration = app.slice(migrationStart, migrationEnd);

  assert.equal((app.match(/function migrateLegacyPreferences/g) || []).length, 1);
  for (const key of ["piWebTheme", "piWebNotifications", "piWebInstallDismissed", "piWebActiveView", "piWebActiveProjectId", "piWebActiveSessionPath"]) {
    assert.match(app, new RegExp(`"${key}"`));
  }
  assert.doesNotMatch(app, /\.setItem\(/);
  for (const match of app.matchAll(/\.(?:getItem|removeItem)\(/g)) {
    assert.ok(match.index! >= migrationStart && match.index! < migrationEnd, "Web Storage access outside migration");
  }
  assert.doesNotMatch(migration, /(?:credential|password|token)/i);
  assert.match(migration, /\["1", "true", "0", "false"\]\.includes\(legacy\.piWebNotifications\)/);
  assert.match(migration, /\["1", "true"\]\.includes\(legacy\.piWebNotifications\)/);
  assert.match(migration, /\["1", "true", "0", "false"\]\.includes\(legacy\.piWebInstallDismissed\)/);
  assert.match(migration, /\["1", "true"\]\.includes\(legacy\.piWebInstallDismissed\)/);
});

test("preference state changes use the authenticated preferences API", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /function savePreferences\(partial\)[\s\S]*?\/api\/preferences/);
  for (const [name, nextName] of [["setTheme", "notificationsSupported"], ["setMobileView", "selectedProject"], ["selectProject", "socketOpen"], ["openSession", "handleSocketMessage"]]) {
    assert.match(functionSource(app, name, nextName), /savePreferencesInBackground/);
  }
  assert.match(functionSource(app, "enableNotifications", "subscribeToPush"), /savePreferencesInBackground/);
  assert.match(functionSource(app, "disableNotifications", "maybeNotifyTurnComplete"), /savePreferencesInBackground/);
});

test("login is an accessible first-class application screen", async () => {
  const html = await readFile("public/index.html", "utf8");

  assert.match(html, /id="loginDialog"/);
  assert.match(html, /id="loginUsernameInput"[^>]*autocomplete="username"/);
  assert.match(html, /id="loginPasswordInput"[^>]*autocomplete="current-password"/);
  assert.match(html, /id="loginSubmitButton"/);
});
