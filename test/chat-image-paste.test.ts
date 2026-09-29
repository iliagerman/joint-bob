import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appSource } from "./source.js";

test("pasted text still reaches the composer when the clipboard also carries an image", async () => {
  const app = await appSource();
  const handler = /elements\.messageInput\.addEventListener\("paste",[\s\S]*?\n\}\);/.exec(app)?.[0];

  assert.ok(handler);
  assert.match(handler, /if \(!images\.length\) return;/);
  assert.match(handler, /if \(!event\.clipboardData\.getData\("text\/plain"\)\) event\.preventDefault\(\);/);
});

test("file picker accepts every file type", async () => {
  const html = await readFile("public/index.html", "utf8");
  const input = /<input[^>]+id="attachmentInput"[^>]*>/.exec(html)?.[0];

  assert.ok(input, "index.html must include the attachment input");
  assert.doesNotMatch(input, /\saccept=/);
});

