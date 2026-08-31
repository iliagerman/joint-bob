import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("creating a conversation asks for a name before it opens", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);

  assert.match(html, /<dialog id="newSessionNameDialog" data-testid="new-session-name-dialog">/);
  assert.match(html, /<form method="dialog" class="dialog-card" id="newSessionNameForm">/);
  assert.match(html, /id="newSessionNameInput"[^>]*data-testid="new-session-name-input"/);
  assert.match(html, /id="cancelNewSessionNameButton"[^>]*data-testid="new-session-name-cancel-button"/);
  assert.match(html, /data-testid="new-session-name-start-button"/);

  assert.match(html, /id="newSessionNodeSelect"[^>]*data-testid="new-session-node-select"/);
  for (const id of ["newSessionNameDialog", "newSessionNameForm", "newSessionNameInput", "newSessionNodeSelect", "cancelNewSessionNameButton"]) {
    assert.match(app, new RegExp(`${id}: document\\.querySelector\\("#${id}"\\)`));
  }
  assert.match(app, /elements\.newSessionButton\.addEventListener\("click", \(\) => openNewSessionNameDialog\(null, "New Pi conversation"\)\);/);
  assert.match(app, /elements\.newClaudeSessionButton\.addEventListener\("click", \(\) => openNewSessionNameDialog\("claude:new", "New Claude conversation"\)\);/);
  assert.match(app, /elements\.cancelNewSessionNameButton\.addEventListener\("click", \(\) => elements\.newSessionNameDialog\.close\(\)\);/);

  const openDialog = app.slice(app.indexOf("function openNewSessionNameDialog("));
  const openDialogBody = openDialog.slice(0, openDialog.indexOf("\n}"));
  assert.ok(openDialogBody.length > 0, "Missing openNewSessionNameDialog");
  assert.match(openDialogBody, /state\.newSessionDraft = \{ sessionPath, defaultTitle \};/);
  assert.match(openDialogBody, /elements\.newSessionNameInput\.value = "";/);
  assert.match(openDialogBody, /state\.sessionNodes\.map\(\(node\)/);
  assert.match(openDialogBody, /elements\.newSessionNodeSelect\.value = localSessionNode\(\)\?\.id/);
  assert.match(openDialogBody, /elements\.newSessionNameDialog\.showModal\(\);/);
});

test("the picked name is displayed right away and saved once the transcript exists", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /^  pendingSessionTitle: null,$/m);
  assert.match(app, /^  newSessionDraft: null,$/m);

  const submitStart = app.indexOf('elements.newSessionNameForm.addEventListener("submit"');
  assert.ok(submitStart >= 0, "Missing new session name form submit handler");
  const submit = app.slice(submitStart, app.indexOf("\n});", submitStart));
  assert.match(submit, /event\.preventDefault\(\);/);
  assert.match(submit, /elements\.newSessionNameDialog\.close\(\);/);
  assert.match(submit, /openSession\(draft\.sessionPath, title \|\| draft\.defaultTitle\);/);
  assert.match(submit, /if \(!node \|\| !node\.online \|\| !node\.mapped\)/);
  assert.match(submit, /state\.activeNodeId = node\.id;/);
  assert.match(submit, /state\.activeSessionId = crypto\.randomUUID\(\);/);
  assert.match(submit, /addOptimisticSession\(state\.activeSessionId, draft\.sessionPath, title \|\| draft\.defaultTitle, color\);/);
  assert.ok(submit.indexOf("state.activeSessionId = crypto.randomUUID();") < submit.indexOf("openSession(draft.sessionPath"));
  assert.match(submit, /openSession\(draft\.sessionPath, title \|\| draft\.defaultTitle\);/);
  assert.match(submit, /state\.pendingSessionTitle = title \|\| null;/);

  // A fresh open of another conversation drops the pending name; a reconnect keeps it.
  const openStart = app.indexOf("function openSession(");
  assert.ok(openStart >= 0, "Missing openSession");
  const preserveBlock = app.slice(app.indexOf("if (!preserveChat) {", openStart), app.indexOf("state.activeSessionPath = sessionPath", openStart));
  assert.match(preserveBlock, /state\.pendingSessionTitle = null;/);

  // "ready" must not replace the picked name with the placeholder title, and it
  // is where the name is saved: the conversation has an id there, and waiting for
  // the first turn to end loses the name if that turn fails or is abandoned.
  const ready = app.slice(app.indexOf('if (payload.type === "ready")'), app.indexOf('if (payload.type === "ownership")'));
  assert.match(ready, /const pendingTitle = state\.pendingSessionTitle;/);
  assert.match(ready, /state\.pendingSessionTitle = null;/);
  assert.match(ready, /saveSessionTitle\(payload\.sessionId, state\.engine, pendingTitle\)/);
  assert.match(ready, /\.then\(\(\) => refreshSessionsQuietly\(\)\)/);
  assert.match(ready, /elements\.sessionTitle\.textContent = pendingTitle\s*\?\s*pendingTitle\s*:/);
  assert.doesNotMatch(app, /\bloadSessions\s*\(/);
});
