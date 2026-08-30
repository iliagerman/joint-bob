import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("every chat message carries a copy button that copies its raw text", async () => {
  const [app, styles] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  const builderStart = app.indexOf("function appendCopyButton(");
  assert.ok(builderStart >= 0, "Missing appendCopyButton");
  const builder = app.slice(builderStart, app.indexOf("\n}", builderStart));
  assert.match(builder, /className = "message-actions"/);
  assert.match(builder, /className = "message-copy"/);
  assert.match(builder, /setAttribute\("aria-label", "Copy message"\)/);
  assert.match(builder, /dataset\.testid = "message-copy-button"/);
  // Reading _raw on click, not at build time, keeps a streamed assistant bubble
  // copyable in full instead of yielding the first delta.
  assert.match(builder, /addEventListener\("click", async \(\) => \{[\s\S]*navigator\.clipboard\.writeText\(bubble\._raw/);
  assert.match(builder, /catch \(error\) \{[\s\S]*toast\(/);

  const appendStart = app.indexOf("function appendMessage(");
  assert.ok(appendStart >= 0, "Missing appendMessage");
  const appendBody = app.slice(appendStart, app.indexOf("\n}", appendStart));
  assert.match(appendBody, /if \(isMarkdown\) appendCopyButton\(bubble\);/);

  assert.match(app, /\n  copy: \[/);
  assert.match(app, /\n  check: \[/);

  assert.match(styles, /\.message-actions \{[^}]*display: flex;[^}]*\}/);
  assert.match(styles, /\.message\.assistant \+ \.message-actions \{[^}]*justify-content: flex-start;[^}]*\}/);
  assert.match(styles, /\.message-copy \{[^}]*min-height: 28px;[^}]*\}/);
  assert.match(styles, /\.message-copy-icon \{[^}]*\}/);
});
