import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("typing a slash opens harness-specific skill autocomplete", async () => {
  const [html, app, styles] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  assert.match(html, /id="commandAutocomplete"[^>]*role="listbox"[^>]*data-testid="chat-command-autocomplete"/);
  assert.match(html, /id="messageInput"[^>]*aria-controls="commandAutocomplete"[^>]*aria-autocomplete="list"/);
  assert.match(app, /function renderCommandAutocomplete\(\)/);
  assert.match(app, /command\.harness === state\.engine/);
  assert.match(app, /void loadCommands\(\)/);
  assert.match(app, /\/commands\?harness=/);
  assert.match(styles, /\.command-autocomplete \{/);
});

test("command autocomplete supports keyboard navigation and selection", async () => {
  const app = await readFile("public/app.js", "utf8");
  const handlerStart = app.indexOf('elements.messageInput.addEventListener("keydown"');
  const handler = app.slice(handlerStart, app.indexOf("\n});", handlerStart) + 4);

  assert.ok(handlerStart > -1, "the message input has no keydown handler");
  assert.match(handler, /commandAutocompleteOpen\(\)/);
  assert.match(handler, /\["ArrowUp", "ArrowDown"\]\.includes\(event\.key\)/);
  assert.match(handler, /event\.key === "Tab" \|\| event\.key === "Enter"/);
  assert.match(handler, /event\.key === "Escape"/);
  assert.match(handler, /selectCommandSuggestion\(\)/);
});

test("selecting a skill inserts the syntax expected by the active agent", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /skillInvocation\(skill\)/);
  assert.match(app, /`\/skill:\$\{skill\.name\} `/);
  assert.match(app, /`\/\$\{skill\.name\} `/);
  assert.match(app, /setInputValue\(suggestion\.invocation\)/);
});
