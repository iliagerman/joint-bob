import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("markdown files open in a syntax-highlighted, wrapped editor", async () => {
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

test("markdown always opens as raw source, with the rendered document beside it on request", async () => {
  const [app, html, styles] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/index.html", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  // One helper owns the presentation so opening a file, resetting the dialog, and
  // hitting the toggle can never disagree about which options are set.
  assert.match(app, /function applyFileEditorView\(markdown, preview\)/);
  // Editing is always on the raw buffer: nothing hides the syntax under the cursor,
  // and the gutter stays put so a line number always means the line it edits.
  assert.match(app, /fileEditor\.setOption\("lineNumbers", true\)/);
  assert.ok(!app.includes("styleActiveLine"), "the editor must not hide markdown syntax while editing");
  assert.ok(!app.includes("file-editor-rendered"), "the in-editor rendered mode is gone");
  // Markdown files open raw, never previewed.
  assert.match(app, /applyFileEditorView\(markdown, false\)/);
  // The toggle flips only the preview half and keeps the markdown half on.
  assert.match(app, /elements\.fileEditorPreviewButton\.addEventListener\("click", \(\) => \{/);
  assert.match(app, /applyFileEditorView\(true, !state\.fileEditor\.preview\)/);
  // The preview is the same renderer the chat uses, and it follows the buffer as it is typed.
  assert.match(app, /renderMarkdown\(elements\.fileEditorPreview, fileEditor\.getValue\(\)\)/);
  assert.match(app, /fileEditor\.on\("changes", /);

  assert.match(html, /id="fileEditorPreviewButton"[^>]*data-testid="file-editor-preview-button"/);
  assert.match(html, /id="fileEditorPreview"[^>]*class="[^"]*message-content md[^"]*"/);
  assert.ok(!html.includes("fileEditorRawButton"), "the raw/rendered toggle is replaced by the preview toggle");

  // Preview sits beside the editor rather than replacing it, so a person reads and edits at once.
  assert.match(styles, /\.file-editor-split:has\(#fileEditorPreview:not\(\[hidden\]\)\) \{ grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\); \}/);
  assert.ok(!styles.includes(".file-editor-rendered"), "the in-editor rendered styling is gone");
});

test("the View link renders a file as a document instead of raw text", async () => {
  const [server, fileView, styles, serviceWorker] = await Promise.all([
    readFile("src/server.ts", "utf8"),
    readFile("public/file-view.js", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("public/sw.js", "utf8"),
  ]);

  // Every response carries `script-src 'self'`, so the page cannot render itself with
  // an inline script: the renderer has to be a real file the shell also caches.
  assert.match(fileView, /import \{ buildCodeBlock, renderMarkdown \} from "\.\/markdown\.js"/);
  assert.match(fileView, /renderMarkdown\(/);
  // Markdown reads as prose; every other text file reads as one highlighted block.
  assert.match(fileView, /buildCodeBlock\(language, source\.textContent\)/);
  assert.ok(serviceWorker.includes('"/file-view.js"'), "the viewer must be cached with the shell");
  assert.match(server, /MARKDOWN_FILE_EXTENSIONS/);
  assert.match(server, /text\/html; charset=utf-8/);

  // The page has to scroll and stay inside a readable column; the app shell body does neither.
  assert.match(styles, /body\.file-view \{[^}]*overflow: auto/);
  assert.match(styles, /\.file-view-page \{[^}]*max-width/);
});
