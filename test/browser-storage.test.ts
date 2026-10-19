import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appSource } from "./source.js";

test("browser storage is limited to legacy migration and request-scoped sign-in dismissal", async () => {
  const source = await appSource();
  const dismissalStart = source.indexOf("function isDismissed(key)");
  const dismissalEnd = source.indexOf("let popup =", dismissalStart);
  assert.ok(dismissalStart >= 0 && dismissalEnd > dismissalStart, "Missing sign-in dismissal helpers");
  const dismissal = source.slice(dismissalStart, dismissalEnd);
  assert.match(source, /const DISMISSAL_PREFIX = "joint-bob\.browser-login-dismissed:"/);
  assert.match(dismissal, /localStorage\.getItem\(DISMISSAL_PREFIX \+ key\) === "1"/);
  assert.match(dismissal, /localStorage\.setItem\(DISMISSAL_PREFIX \+ key, "1"\)/);
  assert.equal((dismissal.match(/\.(?:getItem|setItem|removeItem)\(/g) || []).length, 2);
  assert.match(source, /const requestKey = session => `\$\{session\.nodeId\}:\$\{session\.id\}:\$\{session\.loginRequest\.id\}`/);
  const app = source.slice(0, dismissalStart) + source.slice(dismissalEnd);
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
