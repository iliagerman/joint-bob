import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function functionSource(app: string, name: string): string {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `Missing ${name}`);
  const end = app.indexOf("\n}\n", start);
  assert.ok(end > start, `Missing end of ${name}`);
  return app.slice(start, end);
}

test("the arrow keys walk the conversation's own prompt history", async () => {
  const app = await readFile("public/app.js", "utf8");

  // History is per conversation, so recalling in one chat never surfaces another chat's prompts.
  assert.match(app, /promptHistory: new Map\(\)/);
  const history = functionSource(app, "sessionHistory");
  assert.match(history, /state\.activeSessionPath/);
  assert.match(history, /state\.promptHistory/);

  const recall = functionSource(app, "recallHistory");
  // Entering history stashes the half-typed line, and walking back past the newest entry restores it.
  assert.match(recall, /state\.historyDraft = elements\.messageInput\.value/);
  assert.match(recall, /state\.historyIndex = -1;\s*setInputValue\(state\.historyDraft\)/);

  const start = app.indexOf('elements.messageInput.addEventListener("keydown"');
  assert.ok(start > -1, "the composer has no keydown handler");
  const handler = app.slice(start, app.indexOf("\n});", start));
  assert.match(handler, /ArrowUp/);
  assert.match(handler, /ArrowDown/);
  // A multi-line draft keeps its own line navigation until the caret cannot move further.
  assert.match(handler, /selectionStart === 0 && selectionEnd === 0/);
  assert.match(handler, /state\.historyIndex !== -1/);
  assert.match(handler, /event\.preventDefault\(\)/);
  // Enter still sends on a hardware keyboard.
  assert.match(handler, /elements\.composer\.requestSubmit\(\)/);

  // A sent prompt joins the history and leaves history-browsing mode.
  const submit = app.slice(app.indexOf('elements.composer.addEventListener("submit"'));
  const submitHandler = submit.slice(0, submit.indexOf("\n});"));
  assert.match(submitHandler, /rememberPrompt\(message\)/);
  assert.match(submitHandler, /state\.historyIndex = -1/);
});

test("an unsent draft stays with the conversation it was typed in", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /drafts: new Map\(\)/);

  const remember = functionSource(app, "rememberDraft");
  assert.match(remember, /state\.drafts\.set\(state\.activeSessionPath, text\)/);
  assert.match(remember, /state\.drafts\.delete\(state\.activeSessionPath\)/);

  const restore = functionSource(app, "restoreDraft");
  assert.match(restore, /state\.drafts\.get\(state\.activeSessionPath\)/);

  // Switching conversations parks the old draft before the new path is adopted,
  // then loads whatever was parked for the conversation being opened.
  const openSession = functionSource(app, "openSession");
  assert.ok(
    openSession.indexOf("rememberDraft()") < openSession.indexOf("state.activeSessionPath = sessionPath"),
    "the outgoing draft must be parked before the new conversation takes over",
  );
  assert.ok(
    openSession.indexOf("restoreDraft()") > openSession.indexOf("state.activeSessionPath = sessionPath"),
    "the incoming draft must be restored after the new conversation takes over",
  );

  // A new conversation gets a real session file once it is created; its draft
  // and history move with it instead of being stranded under "new".
  const retarget = functionSource(app, "setActiveSessionPath");
  assert.match(retarget, /state\.drafts/);
  assert.match(retarget, /state\.promptHistory/);
  assert.doesNotMatch(app, /state\.activeSessionPath = payload\.sessionFile/);
  assert.match(app, /setActiveSessionPath\(payload\.sessionFile\)/);

  // Sending clears the draft so returning to the conversation shows an empty composer.
  const submit = app.slice(app.indexOf('elements.composer.addEventListener("submit"'));
  assert.match(submit.slice(0, submit.indexOf("\n});")), /state\.drafts\.delete\(state\.activeSessionPath\)/);
});
