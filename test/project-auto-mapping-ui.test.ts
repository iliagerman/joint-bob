import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("project creation, project roots, and imported mappings use node folder pickers", async () => {
  const [html, app, server] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("src/server.ts", "utf8"),
  ]);

  assert.match(html, /data-testid="project-form-browse-button"/);
  assert.match(html, /data-testid="settings-project-root-input"/);
  assert.match(html, /data-testid="settings-project-root-browse-button"/);
  assert.match(app, /openFolderPicker/);
  assert.match(app, /\/api\/cluster\/projects\/discover/);
  assert.match(app, /mapOnPeer/);
  assert.match(app, /Project is not mapped on this node/);
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
