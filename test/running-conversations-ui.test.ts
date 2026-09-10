import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appSource } from "./source.js";

test("the running conversations dialog refreshes and opens verified live sessions", async () => {
  const [html, app, styles, worker] = await Promise.all([
    readFile("public/index.html", "utf8"), appSource(), readFile("public/styles.css", "utf8"), readFile("public/sw.js", "utf8"),
  ]);
  assert.match(html, /<dialog id="runningConversationsDialog"[^>]*data-testid="running-conversations-dialog"/);
  assert.match(html, /id="runningConversationsList"[^>]*tabindex="-1"/);
  assert.match(html, /id="closeRunningConversationsButton"/);
  assert.match(app, /api\("\/api\/running"\)/);
  assert.match(app, /selectProject\(group\.projectId\)/);
  assert.match(app, /openListedSession\(session\)/);
  assert.match(app, /That conversation is no longer running/);
  assert.match(app, /"\.\/app\/running\.js"/);
  assert.match(worker, /joint-bob-v160/);
  assert.match(worker, /"\/app\/running\.js"/);
  const rule = styles.match(/\.running-conversations-list\s*\{[^}]*\}/);
  assert.ok(rule, "Missing running conversations list CSS");
  assert.match(rule[0], /max-height:/);
  assert.match(rule[0], /grid-auto-rows:\s*max-content/);
});
