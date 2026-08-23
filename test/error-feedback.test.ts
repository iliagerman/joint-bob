import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("dialog errors render above the backdrop as readable alerts", async () => {
  const [app, styles] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  assert.match(app, /function toast\(message, duration = 3200\)/);
  assert.match(app, /node\.setAttribute\("role", "alert"\)/);
  assert.match(app, /const openDialog = document\.querySelector\("dialog\[open\]"\);/);
  assert.match(app, /\(openDialog \|\| document\.body\)\.append\(node\)/);
  assert.match(app, /toast\(error\.message, 8000\)/);
  assert.match(styles, /\.toast[^{]*\{[^}]*max-width:\s*min\(560px, calc\(100vw - 32px\)\)[^}]*overflow-wrap:\s*anywhere/);
});
