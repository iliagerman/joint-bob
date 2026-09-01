import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("final assistant turns sit in a card, while tool and bash turns keep their own surfaces", async () => {
  const styles = await readFile("public/styles.css", "utf8");

  // The assistant's own prose gets the same bubble language as the user's, but
  // keeps the full conversation width so fenced code is not squeezed.
  const assistant = styles.match(/\n\.message\.assistant \{[^}]*\}/);
  assert.ok(assistant, "expected a .message.assistant rule");
  assert.match(assistant[0], /background: var\(--panel\)/);
  assert.match(assistant[0], /border-color: var\(--line\)/);
  assert.match(assistant[0], /width: 100%;[^}]*max-width: 100%;/);
  assert.doesNotMatch(assistant[0], /border-color: transparent/);
  assert.doesNotMatch(assistant[0], /background: transparent/);

  // Tool chips, tool output and thinking are separate classes and stay as they were.
  assert.match(styles, /\.message\.tool \{[^}]*background: color-mix\(in srgb, var\(--amber\) 10%, transparent\)/);
  assert.match(styles, /\.message\.tool-output \{[^}]*background: var\(--panel\)/);
  assert.match(styles, /\.message\.thinking \{[^}]*background: transparent/);
});
