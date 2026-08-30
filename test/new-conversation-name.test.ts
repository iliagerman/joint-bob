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

  for (const id of ["newSessionNameDialog", "newSessionNameForm", "newSessionNameInput", "cancelNewSessionNameButton"]) {
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
  assert.match(submit, /state\.pendingSessionTitle = title \|\| null;/);

  // A fresh open of another conversation drops the pending name; a reconnect keeps it.
  const openStart = app.indexOf("function openSession(");
  assert.ok(openStart >= 0, "Missing openSession");
  const preserveBlock = app.slice(app.indexOf("if (!preserveChat) {", openStart), app.indexOf("state.activeSessionPath = sessionPath", openStart));
  assert.match(preserveBlock, /state\.pendingSessionTitle = null;/);

  // "ready" must not replace the picked name with the placeholder title.
  const ready = app.slice(app.indexOf('if (payload.type === "ready")'), app.indexOf('if (payload.type === "ownership")'));
  assert.match(ready, /elements\.sessionTitle\.textContent = state\.pendingSessionTitle\s*\?\s*state\.pendingSessionTitle\s*:/);

  const applyStart = app.indexOf("function applyPendingSessionTitle()");
  assert.ok(applyStart >= 0, "Missing applyPendingSessionTitle");
  const apply = app.slice(applyStart, app.indexOf("\n}", applyStart));
  assert.match(apply, /\["new", "claude:new"\]\.includes\(state\.activeSessionPath\)/);
  assert.match(apply, /state\.pendingSessionTitle = null;/);
  assert.match(apply, /renameSession\(state\.activeSessionPath, title\)/);

  const agentEndStart = app.indexOf('if (payload.type === "agent_end") {');
  assert.ok(agentEndStart >= 0, "Missing agent_end branch");
  const agentEnd = app.slice(agentEndStart, app.indexOf('if (payload.type === "queueUpdate")', agentEndStart));
  assert.match(agentEnd, /applyPendingSessionTitle\(\);/);
});
