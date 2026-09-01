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
  assert.match(reset, /applyFileEditorView\(false, false\)/);

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

test("markdown opens rendered, with a raw toggle and an editable cursor line", async () => {
  const [app, html, styles, serviceWorker] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/index.html", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("public/sw.js", "utf8"),
  ]);

  // One helper owns the presentation so opening a file, resetting the dialog, and
  // hitting the toggle can never disagree about which options are set.
  assert.match(app, /function applyFileEditorView\(markdown, raw\)/);
  assert.match(app, /const rendered = markdown && !raw;/);
  assert.match(app, /fileEditor\.setOption\("lineNumbers", !rendered\)/);
  assert.match(app, /fileEditor\.setOption\("styleActiveLine", rendered \? \{ nonEmpty: true \} : false\)/);
  assert.match(app, /classList\.toggle\("file-editor-rendered", rendered\)/);
  // Markdown files open rendered, never raw.
  assert.match(app, /applyFileEditorView\(markdown, false\)/);
  // The toggle flips only the raw half and keeps the markdown half on.
  assert.match(app, /elements\.fileEditorRawButton\.addEventListener\("click", \(\) => \{/);
  assert.match(app, /applyFileEditorView\(true, !state\.fileEditor\.raw\)/);

  // The addon that marks the cursor's line has to be on the page before app.js runs,
  // otherwise styleActiveLine is an unknown option and nothing ever reveals the source.
  assert.ok(html.includes('/vendor/codemirror/addon/selection/active-line.js'), "index.html must load the active-line addon");
  assert.ok(html.indexOf("addon/selection/active-line.js") < html.indexOf('"/app.js"'), "the addon must load before app.js creates the editor");
  assert.ok(serviceWorker.includes('"/vendor/codemirror/addon/selection/active-line.js"'), "active-line addon must be cached for offline editing");
  assert.match(html, /id="fileEditorRawButton"[^>]*data-testid="file-editor-raw-button"/);

  // Rendered markdown hides its own syntax, except the markers that carry meaning,
  // and the line under the cursor shows the raw source again so it stays editable.
  assert.match(styles, /\.file-editor-rendered \.cm-formatting \{ display: none; \}/);
  assert.match(styles, /\.file-editor-rendered :is\(\.cm-formatting-list, \.cm-formatting-task, \.cm-formatting-code-block\) \{ display: inline; \}/);
  assert.match(styles, /\.file-editor-rendered \.cm-string\.cm-url \{ display: none; \}/);
  assert.match(styles, /\.file-editor-rendered \.CodeMirror-activeline :is\(\.cm-formatting, \.cm-string\.cm-url\) \{ display: inline; \}/);
});
