import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("pasting an image into the composer adds it as an attachment", async () => {
  const app = await readFile("public/app.js", "utf8");
  const handler = /elements\.messageInput\.addEventListener\("paste",[\s\S]*?\n\}\);/.exec(app)?.[0];

  assert.ok(handler, "app.js must register a paste handler on the message input");
  assert.match(handler, /clipboardData\.files/);
  assert.match(handler, /file\.type\.startsWith\("image\/"\)/);
  assert.match(handler, /event\.preventDefault\(\)/);
  assert.match(handler, /addAttachments\(images\)/);
  assert.match(handler, /toast\(error\.message\)/);
});

test("pasted text still reaches the composer when the clipboard also carries an image", async () => {
  const app = await readFile("public/app.js", "utf8");
  const handler = /elements\.messageInput\.addEventListener\("paste",[\s\S]*?\n\}\);/.exec(app)?.[0];

  assert.ok(handler);
  assert.match(handler, /if \(!images\.length\) return;/);
  assert.match(handler, /if \(!event\.clipboardData\.getData\("text\/plain"\)\) event\.preventDefault\(\);/);
});

test("dropping files on the composer adds them as attachments", async () => {
  const [app, styles] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);
  const dragover = /elements\.composer\.addEventListener\("dragover",[\s\S]*?\n\}\);/.exec(app)?.[0];
  const drop = /elements\.composer\.addEventListener\("drop",[\s\S]*?\n\}\);/.exec(app)?.[0];

  assert.ok(dragover, "the composer must accept dragged files");
  assert.match(dragover, /event\.preventDefault\(\)/);
  assert.match(dragover, /dropEffect = "copy"/);

  assert.ok(drop, "the composer must handle dropped files");
  assert.match(drop, /event\.preventDefault\(\)/);
  assert.match(drop, /addAttachments\(event\.dataTransfer\.files\)/);
  assert.match(drop, /toast\(error\.message\)/);

  assert.match(app, /elements\.composer\.addEventListener\("dragleave"/);
  assert.match(app, /composer\.classList\.(add|remove|toggle)\("dragging"\)/);
  assert.match(styles, /\.composer\.dragging/);
});

test("dropping is ignored while the composer is disabled", async () => {
  const app = await readFile("public/app.js", "utf8");
  const drop = /elements\.composer\.addEventListener\("drop",[\s\S]*?\n\}\);/.exec(app)?.[0];

  assert.ok(drop);
  assert.match(drop, /if \(elements\.attachmentInput\.disabled\) return;/);
});
