import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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

