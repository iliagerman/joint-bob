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
  assert.match(app, /projectTypeInput\.value/);
  assert.match(app, /synced:\s*true/);
  assert.doesNotMatch(app, /api\("\/api\/projects",\s*\{[\s\S]{0,300}path:/);
  assert.match(app, /openFolderPicker/);
  assert.match(app, /\/api\/cluster\/projects\/discover/);
  assert.match(app, /mapOnPeer/);
  assert.match(app, /Project is not mapped on this node/);
  assert.match(app, /replace\(\/\\s\+\/g, "_"\)/);
  assert.doesNotMatch(app, /value === "work" \? "Work" : "Projects"/);
  assert.match(server, /\/api\/cluster\/peers\/:peerId\/filesystem\/directories/);
  assert.match(server, /\/api\/cluster\/peers\/:peerId\/projects\/:projectId\/map/);
});

test("chat keeps node, harness, and session selectors visible", async () => {
  const [html, app] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
  ]);

  assert.doesNotMatch(html, /id="chatToolbar"[^>]*hidden/);
  assert.match(html, /id="chatNodeSelect"[^>]*data-testid="chat-node-select"/);
  assert.match(html, /id="chatHarnessSelect"[^>]*data-testid="chat-harness-select"/);
  assert.match(html, /id="chatSessionSelect"[^>]*data-testid="chat-session-select"/);
  assert.match(app, /searchParams\.set\("nodeId"/);
  assert.match(app, /chatNodeSelect\.addEventListener\("change"/);
  const server = await readFile("src/server.ts", "utf8");
  assert.match(server, /disconnects must not cancel an in-flight turn/);
});
