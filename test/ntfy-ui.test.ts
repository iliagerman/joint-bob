import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appSource } from "./source.js";

test("the conversation menu offers ntfy publishing and the settings panel manages services", async () => {
  const app = await appSource();
  assert.match(app, /session-ntfy-button/);
  assert.match(app, /\/api\/ntfy\/services/);
  assert.match(app, /ntfy-service-remove-button/);
});

test("the shell markup ships the ntfy dialog and central service fields", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="ntfyDialog"/);
  assert.match(html, /data-testid="ntfy-topic-input"/);
  assert.match(html, /data-testid="ntfy-service-url-input"/);
  assert.match(html, /data-testid="ntfy-service-token-input"/);
  assert.match(html, /data-testid="ntfy-service-add-button"/);
});

test("the service worker caches the ntfy module", async () => {
  const worker = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");
  assert.match(worker, /"\/app\/ntfy\.js"/);
});
