import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("bare URLs in assistant prose become anchors that open in a new tab", async () => {
  const markdown = await readFile("public/markdown.js", "utf8");

  // Plain text is scanned for http(s) URLs before file paths.
  assert.match(markdown, /const URL_RE = /);
  assert.match(markdown, /function urlNodes\(text, resolveFileUrl\)/);
  assert.match(markdown, /dataset\.testid = "chat-auto-link"/);

  // The anchor is a safe new-tab link.
  assert.match(markdown, /function urlNodes[\s\S]*anchor\.target = "_blank"[\s\S]*anchor\.rel = "noopener noreferrer"/);
  // Only protocols safeUrl() allows survive.
  assert.match(markdown, /function urlNodes[\s\S]*const href = safeUrl\(raw\)/);

  // inlineNodes routes plain text through urlNodes, not straight to pathNodes.
  assert.doesNotMatch(markdown, /function inlineNodes[\s\S]*pathNodes\(source\.slice/);
  assert.match(markdown, /function inlineNodes[\s\S]*urlNodes\(source\.slice\(last, match\.index\)/);
  assert.match(markdown, /function inlineNodes[\s\S]*urlNodes\(source\.slice\(last\)/);
});
