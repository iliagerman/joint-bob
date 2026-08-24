import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("an empty connected conversation stays usable until its first message is saved", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /activeNode\?\.local[\s\S]*!socketOpen\(\)[\s\S]*activeSessionExists/);
  assert.match(app, /if \(!sendSocket\(payload\)\) \{\s*toast\("Conversation is not connected yet"\);\s*return;\s*\}/);
});

test("chat names its controls and exposes conversation transfer", async () => {
  const [html, app, server] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("src/server.ts", "utf8"),
  ]);

  assert.match(html, /<span>Runs on<\/span>[\s\S]*id="chatNodeSelect"/);
  assert.match(html, /<span>Agent<\/span>[\s\S]*id="chatHarnessSelect"/);
  // The chat toolbar no longer carries a conversation picker: the conversations panel owns that.
  assert.doesNotMatch(html, /id="chatSessionSelect"/);
  assert.match(html, /<span>Model<\/span>[\s\S]*id="modelButton"/);
  assert.match(html, /id="transferSessionButton"[^>]*data-testid="chat-transfer-button"/);
  assert.match(html, /id="sessionTransferDialog"[^>]*data-testid="session-transfer-dialog"/);
  assert.match(app, /New \$\{harness\.label\} conversation/);
  assert.match(html, /Continue on another node/);
  assert.match(app, /sourceNodeId:\s*state\.activeNodeId/);
  assert.match(app, /map project first/);
  assert.match(app, /transferSessionPath/);
  assert.match(app, /state\.activeTaskId = session\.taskId \|\| null/);
  assert.match(app, /openSession\(session\.path, shortSessionTitle\(session\), false, Boolean\(state\.activeTaskId\)\)/);
  assert.match(app, /dataset\.testid = "session-agent-label"/);
  assert.match(app, /session\.agentLabel/);
  assert.match(app, /session\.agentModel/);
  assert.match(server, /POST \/cluster\/sessions\/transfer/);
  assert.match(server, /\(!config \|\| config\.engine === "pi"\) && shared/);
  assert.match(server, /sourceNodeId/);
});
