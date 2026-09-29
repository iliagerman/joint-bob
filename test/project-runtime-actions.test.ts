import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { serverSource } from "./source.js";

test("the vendored terminal bundle stays compatible with Safari", async () => {
  const xterm = await readFile("public/vendor/xterm/xterm.js", "utf8");

  assert.doesNotMatch(xterm, /\?\?=|&&=|\bWeakRef\b/);
});

test("the security policy leaves room for the styles xterm writes at runtime", async () => {
  const server = await serverSource();
  const policy = server.match(/"Content-Security-Policy", `([^`]+)`/)?.[1] ?? "";

  // xterm re-writes a <style> element on every resize and paints ANSI colours
  // through per-cell style attributes. Neither can carry a nonce or a stable
  // hash, so tightening these two directives silently breaks the terminal.
  assert.match(policy, /style-src-elem \$\{inlineStyle\}/);
  assert.match(policy, /style-src-attr \$\{inlineStyle\}/);
  assert.match(server, /const inlineStyle = "'self' 'unsafe-inline'"/);
  // Scripts stay locked down: inline styles are the only relaxation.
  assert.match(policy, /script-src 'self'/);
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/);
});
