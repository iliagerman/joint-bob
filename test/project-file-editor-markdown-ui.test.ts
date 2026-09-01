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

test("mode helper addons ship with the shell so an auto-loaded mode cannot blank the editor", async () => {
  const [html, serviceWorker] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/sw.js", "utf8"),
  ]);

  // loadmode.js resolves mode-to-mode dependencies but never addons. A .md file
  // resolves to the gfm mode, which calls CodeMirror.overlayMode as soon as it
  // loads; without the addon that throws inside the editor's render operation
  // and leaves an empty grey panel instead of the file.
  for (const addon of ["overlay", "multiplex", "simple"]) {
    assert.ok(html.includes(`/vendor/codemirror/addon/mode/${addon}.js`), `index.html must load the ${addon} mode addon`);
    assert.ok(serviceWorker.includes(`"/vendor/codemirror/addon/mode/${addon}.js"`), `${addon} addon must be cached for offline editing`);
  }
  assert.ok(html.indexOf("addon/mode/overlay.js") < html.indexOf('"/app.js"'), "addons must load before app.js creates the editor");

  // gfm is the mode markdown actually resolves to, and it layers on markdown and xml.
  for (const mode of ["gfm/gfm", "markdown/markdown", "xml/xml"]) {
    assert.ok(serviceWorker.includes(`"/vendor/codemirror/mode/${mode}.js"`), `${mode} must be cached for offline editing`);
  }
});
