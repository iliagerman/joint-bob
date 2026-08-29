import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// A fresh Claude chat used to report id "default" / label "Claude Code", so the
// toolbar named no model and the model dialog highlighted nothing.
test("a fresh Claude session defaults to a real, selectable model", async () => {
  const [server, app] = await Promise.all([
    readFile("src/server.ts", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);

  const emptyStart = server.indexOf("function emptyClaudeState(");
  const emptyEnd = server.indexOf("\n}", emptyStart);
  assert.ok(emptyStart >= 0 && emptyEnd >= 0, "Missing emptyClaudeState");
  assert.match(server.slice(emptyStart, emptyEnd), /model: CLAUDE_DEFAULT_MODEL\b/);
  assert.match(server, /const CLAUDE_DEFAULT_MODEL = "claude-opus-5";/);
  assert.doesNotMatch(server, /"Claude Code"/);

  const statusStart = server.indexOf("function claudeStatus(");
  const statusEnd = server.indexOf("\n}", statusStart);
  const status = server.slice(statusStart, statusEnd);
  const modelBlock = status.slice(status.indexOf("model: {"), status.indexOf("thinkingLevel:"));
  assert.match(modelBlock, /id: connection\.claude\.model \?\? CLAUDE_DEFAULT_MODEL/);
  assert.match(modelBlock, /label: CLAUDE_MODEL_LABELS\.get\(connection\.claude\.model \?\? CLAUDE_DEFAULT_MODEL\)/);
  assert.doesNotMatch(modelBlock, /"default"/);

  // Every id the client offers must be one the server knows how to label.
  const labelIds = [...server.matchAll(/^\s{2}\["([a-z0-9-]+)", "Claude [^"]+"\],$/gm)].map((match) => match[1]);
  const optionIds = [...app.matchAll(/\{ id: "([a-z0-9-]+)", label: "[^"]+" \}/g)].map((match) => match[1]);
  assert.ok(labelIds.length >= 4, "Missing CLAUDE_MODEL_LABELS entries");
  assert.deepEqual(optionIds, labelIds);
  assert.ok(optionIds.includes("claude-opus-5"));
});
