import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("markdown files open in a pretty, still-editable editor", async () => {
  const [app, serviceWorker] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/sw.js", "utf8"),
  ]);

  // The mode has to be applied to the editor, not merely fetched: autoLoadMode
  // only loads the script.
  assert.match(app, /fileEditor\.setOption\("mode", markdown \? \{ name: spec\.mode, highlightFormatting: true \} : spec\?\.mime \?\? spec\?\.mode \?\? null\)/);
  assert.match(app, /fileEditor\.setOption\("lineWrapping", markdown\)/);
  assert.match(app, /fileEditor\.getWrapperElement\(\)\.classList\.toggle\("file-editor-markdown", markdown\)/);
  assert.match(app, /if \(spec\) window\.CodeMirror\.autoLoadMode\(fileEditor, spec\.mode\)/);

  // A fresh dialog must not inherit the previous file's markdown presentation.
  const reset = app.slice(app.indexOf("function resetFileEditor()"), app.indexOf("async function openFileAction("));
  assert.match(reset, /fileEditor\.setOption\("lineWrapping", false\)/);
  assert.match(reset, /classList\.remove\("file-editor-markdown"\)/);

  assert.ok(serviceWorker.includes('"/vendor/codemirror/mode/markdown/markdown.js"'), "markdown mode must be cached for offline editing");
});

test("the file dialog grows when editing and styles markdown tokens", async () => {
  const styles = await readFile("public/styles.css", "utf8");
  const editing = styles.match(/\.file-editor-card:has\(#fileEditorView:not\(\[hidden\]\)\) \{ width: min\((\d+)px/);
  assert.ok(editing, "editing state must set its own width");
  assert.ok(Number(editing[1]) >= 1100, "editing dialog should be wider than the picker");
  assert.match(styles, /\.file-editor-card \.CodeMirror \{[^}]*max-height: min\(8\d?dvh/);

  for (const token of ["cm-header-1", "cm-strong", "cm-em", "cm-link", "cm-quote", "cm-formatting"]) {
    assert.ok(styles.includes(`.file-editor-markdown .${token}`), `missing markdown styling for ${token}`);
  }
});
