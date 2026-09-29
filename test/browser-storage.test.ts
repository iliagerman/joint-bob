import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appSource } from "./source.js";

test("browser storage is limited to one-time legacy preference migration", async () => {
  const app = await appSource();
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

test("login is an accessible first-class application screen", async () => {
  const html = await readFile("public/index.html", "utf8");

  assert.match(html, /id="loginDialog"/);
  assert.match(html, /id="loginUsernameInput"[^>]*autocomplete="username"/);
  assert.match(html, /id="loginPasswordInput"[^>]*autocomplete="current-password"/);
  assert.match(html, /id="loginSubmitButton"/);
});
