import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { appSource } from "./source.js";

test("the chat menu opens a project file explorer wired to the file dialog", async () => {
  const [app, html, serviceWorker, styles] = await Promise.all([
    appSource(),
    readFile("public/index.html", "utf8"),
    readFile("public/sw.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  assert.match(html, /<button[^>]*id="chatFilesButton"[^>]*data-testid="chat-files-button"/);
  assert.match(html, /<dialog id="projectFilesDialog" data-testid="project-files-dialog">/);
  for (const control of ["project-files-up-button", "project-files-paste-button", "project-files-close-button"]) {
    assert.ok(html.includes(`data-testid="${control}"`), `missing ${control}`);
  }

  assert.match(app, /export async function openProjectExplorer\(\)/);
  assert.ok(app.includes('elements.chatFilesButton.addEventListener("click"'), "the Files button must open the explorer");
  // A folder navigates within the explorer; a file opens the existing view/edit dialog.
  assert.ok(app.includes("loadExplorerDirectory(entry.path)"), "folders must navigate inside the explorer");
  assert.ok(app.includes("openFileAction(entry.path)"), "files must open the existing file dialog");
  // Delete is confirmed as destructive; copy pastes into the folder the explorer is showing.
  assert.ok(app.includes('eyebrow: "Delete file"'), "delete must go through the destructive confirm dialog");
  assert.ok(app.includes("state.fileExplorer.clipboard = entry.path"), "copy must remember the source file");
  assert.ok(app.includes("destinationDir: state.fileExplorer.dir"), "paste must target the open folder");

  assert.ok(serviceWorker.includes('"/app/project-explorer.js"'), "the explorer module must be cached with the shell");
  assert.match(styles, /\.file-explorer-list \{/);
});
