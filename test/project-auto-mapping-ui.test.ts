import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("managed home project creation and imported mappings use node folder pickers", async () => {
  const [html, app, server] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("src/server.ts", "utf8"),
  ]);

  assert.equal([...html.matchAll(/data-testid="settings-project-home-input"/g)].length, 1);
  assert.equal([...html.matchAll(/data-testid="settings-project-home-browse-button"/g)].length, 1);
  assert.doesNotMatch(html, /data-testid="settings-project-root-input"/);
  assert.doesNotMatch(html, /data-testid="settings-project-root-browse-button"/);
  assert.doesNotMatch(html, /data-testid="settings-personal-project-root-input"/);
  assert.doesNotMatch(html, /data-testid="settings-personal-project-root-browse-button"/);
  assert.doesNotMatch(html, /data-testid="settings-work-project-root-input"/);
  assert.doesNotMatch(html, /data-testid="settings-work-project-root-browse-button"/);
  assert.match(app, /settings\.projects\.homePath/);
  assert.match(app, /\/projects\//);
  assert.match(app, /projectWorkspaceInput\.value/);
  assert.match(app, /synced:\s*true/);
  assert.match(html, /data-testid="project-form-source-path-input"/);
  assert.match(html, /data-testid="project-form-source-browse-button"/);
  assert.match(html, /id="projectImportModeInput"[^>]*required[^>]*data-testid="project-form-import-mode-select"/);
  assert.match(html, /value="move-link" selected>Move into Joint Bob and leave a symlink/);
  assert.doesNotMatch(html, /value="" selected disabled/);
  assert.match(html, /value="move"/);
  assert.match(html, /value="copy"/);
  assert.match(html, /data-testid="project-edit-type-select"/);
  assert.match(html, /<h2>Edit project<\/h2>[\s\S]*Managed projects move between group folders/);
  assert.match(app, /sourcePath/);
  assert.match(app, /importMode/);
  assert.match(app, /projectSourceBrowseButton/);
  assert.match(server, /importProjectDirectory/);
  assert.doesNotMatch(app, /api\("\/api\/projects",\s*\{[\s\S]{0,300}path:/);
  assert.match(app, /openFolderPicker/);
  assert.match(app, /\/api\/cluster\/projects\/discover/);
  assert.match(app, /mapOnPeer/);
  assert.match(app, /Project is not mapped on this node/);
  assert.ok(app.includes('.replace(/[^a-z0-9._-]+/g, "_")'));
  assert.doesNotMatch(app, /value === "work" \? "Work" : "Projects"/);
  assert.match(server, /\/api\/cluster\/peers\/:peerId\/filesystem\/directories/);
  assert.match(server, /\/api\/cluster\/peers\/:peerId\/projects\/:projectId\/map/);
  assert.match(app, /project-sync-status/);
  for (const label of ["Synced", "Syncing", "Paused", "Error", "Unavailable"]) assert.match(app, new RegExp(label));
  assert.ok(app.includes('status.state === "error" && status.message ? `Error: ${status.message}`'));
  assert.match(app, /refreshProjectsQuietly/);
  assert.match(app, /10_000/);
  assert.match(app, /if \(state\.authenticated && !state\.canvasPaneMode\) startProjectSyncPolling\(\)/);
  assert.match(server, /app\.post\("\/api\/projects\/:projectId\/sync\/rescan"/);
  assert.match(server, /await rescanSyncthingFolder\(project\.syncFolderId\)/);
  assert.match(app, /project-rescan-button/);
  assert.match(app, /`\/api\/projects\/\$\{encodeURIComponent\(project\.id\)\}\/sync\/rescan`/);
  assert.match(app, /toast\(`Rescanning \$\{project\.name\}`\)/);
  assert.match(app, /toast\(`Rescan complete for \$\{project\.name\}`\)/);
});

test("chat keeps node, harness, and session selectors visible", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);

  assert.doesNotMatch(html, /id="chatToolbar"[^>]*hidden/);
  assert.match(html, /id="chatNodeSelect"[^>]*data-testid="chat-node-select"/);
  assert.match(html, /id="chatHarnessSelect"[^>]*data-testid="chat-harness-select"/);
  assert.doesNotMatch(html, /id="chatSessionSelect"/);
  assert.match(app, /searchParams\.set\("nodeId"/);
  assert.match(app, /chatNodeSelect\.addEventListener\("change"/);
  const server = await readFile("src/server.ts", "utf8");
  assert.match(server, /disconnects must not cancel an in-flight turn/);
});
