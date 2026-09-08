import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appSource } from "./source.js";

test("running conversations are reachable from every shared conversation header", async () => {
  const html = await readFile("public/index.html", "utf8");
  // The projects header and the open-chat toolbar carry the trigger; the conversations
  // list header does not, because the list itself already shows what is running.
  assert.equal((html.match(/data-running-conversations-open/g) || []).length, 2);
  for (const testid of ["running-conversations-open-button", "chat-running-conversations-open-button"]) {
    assert.match(html, new RegExp(`data-testid="${testid}"`));
  }
  assert.doesNotMatch(html, /data-testid="chats-running-conversations-open-button"/);
});

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
  assert.match(worker, /joint-bob-v139/);
  assert.match(worker, /"\/app\/running\.js"/);
  const rule = styles.match(/\.running-conversations-list\s*\{[^}]*\}/);
  assert.ok(rule, "Missing running conversations list CSS");
  assert.match(rule[0], /max-height:/);
  assert.match(rule[0], /grid-auto-rows:\s*max-content/);
});
