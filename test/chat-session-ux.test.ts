import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("an empty connected conversation stays usable until its first message is saved", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /activeNode\?\.local[\s\S]*!socketOpen\(\)[\s\S]*activeSessionExists/);
  assert.match(app, /dispatchComposerInput\(message, state\.attachments\.length > 0/);
  assert.match(app, /if \(route === "command"\) return;\s*if \(!sent\) \{\s*toast\("Conversation is not connected yet"\);\s*return;\s*\}/);
});

test("ticket chat controls hand off ownership instead of reconnecting", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /chatNodeSelect\.disabled = !state\.activeProjectId \|\| !state\.sessionNodes\.length/);
  assert.doesNotMatch(app, /chatNodeSelect\.disabled = [^;]*selectedSession/);
  assert.doesNotMatch(app, /chatNodeSelect\.disabled = Boolean\(state\.activeTaskId\)/);
  assert.match(app, /Send a message first, then continue this ticket on another node/);
  assert.match(app, /if \(state\.activeTaskId\) \{[\s\S]*await continueTaskOnNode\(task, destination\)/);
  assert.match(app, /await continueTaskOnNode\(task, destination\)/);
  assert.match(app, /if \(!task\.sessionPath\) throw new Error\("Send a message first, then continue this ticket on another node"\);[\s\S]*const body = await handoffTaskToPeer\(task, destination\);/);
  assert.match(app, /tasks\/\$\{encodeURIComponent\(task\.id\)\}\/handoff/);
  assert.match(app, /openSession\(body\.task\.sessionPath, task\.title, false, true\)/);
});

test("chat names its controls and continues conversations through takeover", async () => {
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
  // Copy-based continuation is gone; the lock banner's takeover is the only path.
  assert.doesNotMatch(html, /id="transferSessionButton"/);
  assert.doesNotMatch(html, /id="sessionTransferDialog"/);
  assert.doesNotMatch(html, /id="sessionTakeOwnershipButton"/);
  assert.doesNotMatch(html, /Continue on/);
  assert.doesNotMatch(app, /openSessionTransferDialog|continueSessionOnNode|transferActiveSession|transferSessionFromRow/);
  assert.doesNotMatch(app, /sessions\/transfer/);
  assert.doesNotMatch(app, /transferSessionPath/);
  assert.doesNotMatch(server, /cluster\/sessions\/transfer/);
  assert.doesNotMatch(server, /cluster\/sessions\/receive/);
  assert.match(app, /const TAKE_OWNERSHIP_WAIT_SECONDS = 5/);
  assert.match(app, /function countdownOwnershipWait/);
  assert.match(app, /function takeLockedConversationOwnership\(\)[\s\S]*state\.sessionNodes\.find\(\(node\) => node\.id === state\.activeNodeId\)/);
  assert.match(app, /conversationLockStatus\.textContent = "Taking ownership…";[\s\S]*await api\(/);
  assert.match(app, /sessions\/take-ownership/);
  assert.match(app, /New \$\{harness\.label\} conversation/);
  assert.match(app, /state\.activeTaskId = session\.taskId \|| null/);
  assert.match(app, /openSession\(session\.path, shortSessionTitle\(session\), false, Boolean\(state\.activeTaskId\)\)/);
  assert.match(app, /dataset\.testid = "session-agent-label"/);
  assert.match(app, /session\.agentLabel/);
  assert.match(app, /session\.agentModel/);
  assert.match(server, /\(!config \|\| config\.engine === "pi"\) && shared/);
});

test("ordinary node selection does not open a new conversation", async () => {
  const app = await readFile("public/app.js", "utf8");
  const start = app.indexOf('elements.chatNodeSelect.addEventListener("change"');
  const handler = app.slice(start, app.indexOf('elements.chatHarnessSelect.addEventListener', start));
  assert.match(handler, /if \(!activeChatSession\(\)\) \{\s*state\.activeSessionId = null;\s*return;/);
});

test("removing a conversation uses its identity", async () => {
  const app = await readFile("public/app.js", "utf8");
  const start = app.indexOf("async function removeSessionFromRow");
  const handler = app.slice(start, app.indexOf("function clearThinkingBubble", start));
  assert.match(handler, /sessionId=\$\{encodeURIComponent\(session\.id\)\}&engine=\$\{sessionEngine\(session\)\}/);
  assert.doesNotMatch(handler, /sessionPath=\$\{encodeURIComponent\(session\.path\)\}/);
});

test("switching projects discards in-flight responses from the previous project", async () => {
  const app = await readFile("public/app.js", "utf8");

  // selectProject clears the old list up front and abandons a late response.
  assert.match(app, /state\.sessionNodes = \[\];\s*state\.sessions = \[\];/);
  assert.match(app, /if \(state\.activeProjectId === projectId\) setListLoading\("sessions", false\);/);
  assert.match(app, /if \(state\.activeProjectId !== projectId\) return;\s*state\.sessions = body\.sessions;/);

  // refreshSessionsQuietly and loadTasks capture the project id instead of
  // re-reading it after the await.
  assert.match(app, /async function refreshSessionsQuietly\(\) \{\s*\/\/ The pane frame hosts one conversation[\s\S]*?if \(state\.canvasPaneMode\) return;\s*const projectId = state\.activeProjectId;/);
  assert.match(app, /async function loadTasks\(\) \{\s*if \(state\.canvasPaneMode\) return;\s*const projectId = state\.activeProjectId;/);
  assert.doesNotMatch(app, /encodeURIComponent\(state\.activeProjectId\)\}\/sessions`\)/);
  assert.doesNotMatch(app, /encodeURIComponent\(state\.activeProjectId\)\}\/tasks`\)/);
});

test("the chat header keeps a Joint Bob rename over the engine's own session name", async () => {
  const app = await readFile("public/app.js", "utf8");

  // Status updates and sessionInfoChanged carry the engine's live session name
  // (for example a generated one), which must not clobber the title the
  // conversations list shows for a renamed conversation.
  assert.match(app, /function syncChatTitleFromSessions\(engineName\) \{\s*const session = state\.sessions\.find\(\(item\) => item\.path === state\.activeSessionPath\);\s*elements\.sessionTitle\.textContent = session \? shortSessionTitle\(session\) : engineName;\s*\}/);
  assert.match(app, /if \(status\.sessionName\) syncChatTitleFromSessions\(status\.sessionName\);/);
  assert.match(app, /sessionInfoChanged" && payload\.name\) syncChatTitleFromSessions\(payload\.name\);/);
  assert.doesNotMatch(app, /elements\.sessionTitle\.textContent = status\.sessionName/);
  assert.doesNotMatch(app, /sessionInfoChanged[\s\S]{0,80}elements\.sessionTitle\.textContent = payload\.name/);
});
