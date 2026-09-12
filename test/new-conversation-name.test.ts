import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appSource } from "./source.js";

test("creating a conversation asks for a name before it opens", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    appSource(),
  ]);

  assert.match(html, /<dialog id="newSessionNameDialog" data-testid="new-session-name-dialog">/);
  assert.match(html, /<form method="dialog" class="dialog-card wizard-card" id="newSessionNameForm" novalidate>/);
  assert.match(html, /id="newSessionNameInput"[^>]*data-testid="new-session-name-input"/);
  assert.match(html, /id="cancelNewSessionNameButton"[^>]*data-testid="new-session-name-cancel-button"/);
  assert.match(html, /data-testid="new-session-name-start-button"/);

  assert.match(html, /id="newSessionNodeSelect"[^>]*data-testid="new-session-node-select"/);
  for (const id of ["newSessionNameDialog", "newSessionNameForm", "newSessionNameInput", "newSessionNodeSelect", "cancelNewSessionNameButton"]) {
    assert.match(app, new RegExp(`${id}: document\\.querySelector\\("#${id}"\\)`));
  }
  assert.match(app, /elements\.newSessionButton\.addEventListener\("click", \(\) => openNewSessionNameDialog\(null, "New Pi conversation"\)\.catch/);
  assert.match(app, /elements\.newClaudeSessionButton\.addEventListener\("click", \(\) => openNewSessionNameDialog\("claude:new", "New Claude conversation"\)\.catch/);
  assert.match(app, /elements\.cancelNewSessionNameButton\.addEventListener\("click", \(\) => elements\.newSessionNameDialog\.close\(\)\);/);

  const openDialog = app.slice(app.indexOf("function openNewSessionNameDialog("));
  const openDialogBody = openDialog.slice(0, openDialog.indexOf("\n}"));
  assert.ok(openDialogBody.length > 0, "Missing openNewSessionNameDialog");
  assert.match(openDialogBody, /state\.newSessionDraft = \{ sessionPath, defaultTitle, sourceTaskId \};/);
  assert.match(openDialogBody, /elements\.newSessionNameInput\.value = sourceTaskId \? defaultTitle : "";/);
  assert.match(openDialogBody, /state\.sessionNodes\.map\(\(node\)/);
  assert.match(openDialogBody, /elements\.newSessionNodeSelect\.value = localSessionNode\(\)\?\.id/);
  assert.match(openDialogBody, /elements\.newSessionNameDialog\.showModal\(\);/);
  assert.match(openDialogBody, /showWizardStep\(1\);/);
});

test("the creation dialog is a three-step wizard that walks on the keyboard alone", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    appSource(),
  ]);

  // Name plus colour, then classification, then node plus secrets — one decision per step.
  for (const step of [1, 2, 3]) {
    assert.match(html, new RegExp(`data-testid="new-session-step-${step}"`));
    assert.match(html, new RegExp(`class="wizard-panel" data-step="${step}"`));
  }
  const panels = html.slice(html.indexOf('data-testid="new-session-panel-1"'), html.indexOf("</dialog>", html.indexOf("newSessionNameForm")));
  const panelTwo = panels.indexOf('data-testid="new-session-panel-2"');
  const panelThree = panels.indexOf('data-testid="new-session-panel-3"');
  assert.ok(panels.indexOf('data-testid="new-session-color-swatches"') < panelTwo, "colour belongs to the name step");
  assert.ok(panels.indexOf('id="newSessionClassification"') > panelTwo && panels.indexOf('id="newSessionClassification"') < panelThree, "classification is its own step");
  assert.ok(panels.indexOf('id="newSessionNodeSelect"') > panelThree, "node and secrets are the last step");
  assert.ok(panels.indexOf('data-testid="conversation-secrets-list"') > panelThree, "node and secrets are the last step");
  // Steps 2 and 3 start folded away, so the dialog opens on one question.
  assert.match(html, /data-testid="new-session-panel-2" hidden/);
  assert.match(html, /data-testid="new-session-panel-3" hidden/);
  assert.match(html, /data-testid="new-session-back-button"/);
  assert.match(html, /data-testid="new-session-next-button"/);

  const showStep = app.slice(app.indexOf("function showWizardStep("));
  const showStepBody = showStep.slice(0, showStep.indexOf("\n}"));
  assert.ok(showStepBody.length > 0, "Missing showWizardStep");
  assert.match(showStepBody, /panel\.hidden = Number\(panel\.dataset\.step\) !== wizardStep;/);
  assert.match(showStepBody, /elements\.newSessionBackButton\.disabled = wizardStep === 1;/);
  assert.match(showStepBody, /elements\.newSessionNextButton\.disabled = wizardStep === WIZARD_STEPS\.length;/);
  // Every step hands the cursor to its own first control, so no step needs the mouse.
  assert.match(showStepBody, /current\.focus\(\)\?\.focus\(\);/);

  const keydownStart = app.indexOf('elements.newSessionNameForm.addEventListener("keydown"');
  assert.ok(keydownStart >= 0, "Missing wizard keyboard handler");
  const keydown = app.slice(keydownStart, app.indexOf("\n});", keydownStart));
  // Enter walks forward; the last step, or Cmd/Ctrl+Enter, is what submits.
  assert.match(keydown, /if \(event\.metaKey \|\| event\.ctrlKey \|\| wizardStep === WIZARD_STEPS\.length\) return;/);
  assert.match(keydown, /showWizardStep\(wizardStep \+ 1\);/);
  assert.match(app, /elements\.newSessionBackButton\.addEventListener\("click", \(\) => showWizardStep\(wizardStep - 1\)\);/);
  assert.match(app, /elements\.newSessionNextButton\.addEventListener\("click", \(\) => showWizardStep\(wizardStep \+ 1\)\);/);

  // A required free-text label on a hidden step cannot be pointed at, so the
  // submit path reveals that step before it validates.
  assert.match(app, /if \(classification\.needsOther\(\)\) showWizardStep\(2\);/);
  assert.match(app, /needsOther\(\) \{/);
});

test("the picked name is displayed right away and saved once the transcript exists", async () => {
  const app = await appSource();

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
  assert.match(submit, /const sessionId = crypto\.randomUUID\(\);/);
  assert.match(submit, /state\.activeSessionId = sessionId;/);
  assert.match(submit, /addOptimisticSession\(sessionId, draft\.sessionPath, title \|\| draft\.defaultTitle, color, label\);/);
  assert.ok(submit.indexOf("state.activeSessionId = sessionId;") < submit.indexOf("openSession(draft.sessionPath"));
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
  assert.match(ready, /saveSessionTitle\(state\.activeConversationId \|\| payload\.sessionId, state\.engine, pendingTitle\)/);
  assert.match(ready, /\.then\(\(\) => refreshSessionsQuietly\(\)\)/);
  assert.match(ready, /elements\.sessionTitle\.textContent = pendingTitle\s*\?\s*pendingTitle\s*:/);
  assert.doesNotMatch(app, /\bloadSessions\s*\(/);
});
