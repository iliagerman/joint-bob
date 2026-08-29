import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("an empty connected conversation stays usable until its first message is saved", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /activeNode\?\.local[\s\S]*!socketOpen\(\)[\s\S]*activeSessionExists/);
  assert.match(app, /if \(!sendSocket\(payload\)\) \{\s*toast\("Conversation is not connected yet"\);\s*return;\s*\}/);
});

test("ticket chat controls hand off ownership instead of reconnecting", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /chatNodeSelect\.disabled = !state\.activeProjectId/);
  assert.doesNotMatch(app, /chatNodeSelect\.disabled = Boolean\(state\.activeTaskId\)/);
  assert.match(app, /eligibility\.nodes\.map\(\(entry\)/);
  assert.match(app, /entry\.reasons\.join\("; "\)/);
  assert.match(app, /Boolean\(activeTask\.sessionPath && activeTask\.executionState === "idle" && ticketDestinations\?\.length\)/);
  assert.match(app, /Send a message first, then continue this ticket on another node/);
  assert.match(app, /if \(state\.activeTaskId\) \{[\s\S]*await continueTaskOnNode\(task, destination\)/);
  assert.match(app, /await continueTaskOnNode\(task, destination\)/);
  assert.match(app, /if \(!task\.sessionPath\) throw new Error\("Send a message first, then continue this ticket on another node"\);[\s\S]*const body = await handoffTaskToPeer\(task, destination\);/);
  assert.match(app, /tasks\/\$\{encodeURIComponent\(task\.id\)\}\/handoff/);
  assert.match(app, /openSession\(body\.task\.sessionPath, task\.title, false, true\)/);
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
  assert.match(html, /id="sessionTakeOwnershipButton"/);
  assert.match(html, /id="sessionTransferProgress"[^>]*role="status"/);
  assert.match(html, /id="sessionTransferStatus"/);
  assert.match(html, /<progress[^>]*max="5"/);
  assert.match(html, /id="skipSessionTransferWaitButton"/);
  assert.match(app, /const TAKE_OWNERSHIP_WAIT_SECONDS = 5/);
  assert.match(app, /function waitForOwnershipSync/);
  assert.doesNotMatch(app, /ownershipWait\.promise = promise;\s*}\);/);
  assert.match(app, /function setOwnershipTransferControls\(disabled\)[\s\S]*sessionTransferNodeSelect\.disabled = disabled;[\s\S]*querySelector\('\[type="submit"\]'\)\.disabled = disabled;[\s\S]*sessionTakeOwnershipButton\.disabled = disabled;/);
  assert.match(app, /sessionTransferStatus\.textContent = "Taking ownership…";[\s\S]*await api\(/);
  assert.match(app, /const session = activeChatSession\(\);[\s\S]*state\.activeTaskId \|\| state\.engine !== "pi"[\s\S]*!session/);
  assert.match(app, /function skipOwnershipWait/);
  assert.match(app, /skipSessionTransferWaitButton\.addEventListener\("click", skipOwnershipWait\)/);
  assert.match(app, /sessionTakeOwnershipButton\.addEventListener\("click"/);
  assert.match(app, /sessions\/take-ownership/);
  assert.match(app, /state\.activeTaskId \|\| state\.engine !== "pi"/);
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

test("switching projects discards in-flight responses from the previous project", async () => {
  const app = await readFile("public/app.js", "utf8");

  // selectProject clears the old list up front and abandons a late response.
  assert.match(app, /state\.sessionNodes = \[\];\s*state\.sessions = \[\];/);
  assert.match(app, /if \(state\.activeProjectId === projectId\) setListLoading\("sessions", false\);/);
  assert.match(app, /if \(state\.activeProjectId !== projectId\) return;\s*state\.sessions = body\.sessions;/);

  // refreshSessionsQuietly and loadTasks capture the project id instead of
  // re-reading it after the await.
  assert.match(app, /async function refreshSessionsQuietly\(\) \{\s*const projectId = state\.activeProjectId;/);
  assert.match(app, /async function loadTasks\(\) \{\s*const projectId = state\.activeProjectId;/);
  assert.doesNotMatch(app, /encodeURIComponent\(state\.activeProjectId\)\}\/sessions`\)/);
  assert.doesNotMatch(app, /encodeURIComponent\(state\.activeProjectId\)\}\/tasks`\)/);
});
