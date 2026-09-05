import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("toasts are dismissible and busy-session errors linger for six seconds", async () => {
  const [app, styles] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  const toastStart = app.indexOf("function toast(");
  assert.ok(toastStart >= 0, "Missing toast");
  const toastBody = app.slice(toastStart, app.indexOf("\n}", toastStart));
  assert.match(toastBody, /function toast\(message, duration = 3200\)/);
  assert.match(toastBody, /class = "toast-message"|className = "toast-message"/);
  assert.match(toastBody, /className = "toast-close"/);
  assert.match(toastBody, /setAttribute\("aria-label", "Dismiss"\)/);
  assert.match(toastBody, /data-testid[\s\S]*toast-close-button|setAttribute\("data-testid", "toast-close-button"\)/);
  assert.match(toastBody, /addEventListener\("click", \(\) => \{[\s\S]*node\.remove\(\)/);
  assert.match(toastBody, /querySelectorAll\("\.toast"\)/);
  assert.match(toastBody, /getClientRects\(\)\.length > 0/);
  assert.match(toastBody, /\.toast-message/);

  assert.match(app, /if \(payload\.type === "error"\) \{[\s\S]*toast\(payload\.error, 6000\);[\s\S]*\}/);

  const toastRule = /\n\.toast \{([^}]*)\}/.exec(styles)?.[1] ?? "";
  assert.match(toastRule, /display: flex;/);
  assert.match(toastRule, /align-items: flex-start;/);
  assert.match(toastRule, /top: calc\(12px \+ env\(safe-area-inset-top, 0px\)\);/);
  assert.doesNotMatch(toastRule, /bottom:/);
  assert.match(styles, /\.toast-close \{[^}]*\}/);
});

test("a busy Pi session is reported in words the user can act on", async () => {
  const server = await readFile("src/server.ts", "utf8");

  const helperStart = server.indexOf("function chatErrorMessage(");
  assert.ok(helperStart >= 0, "Missing chatErrorMessage");
  const helper = server.slice(helperStart, server.indexOf("\n}", helperStart));
  assert.match(helper, /already processing/i);
  assert.match(helper, /Pi is still working on your previous message\. Wait for it to finish or press Stop, then send again\./);
  assert.match(server, /const message = chatErrorMessage\(error\);/);
});
