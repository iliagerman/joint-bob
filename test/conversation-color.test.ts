import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("a conversation colour persists and can be cleared", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-conversation-color-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  try {
    const names = await import(`../src/names.js?conversation-color=${Date.now()}-${Math.random()}`);
    await names.setSessionColor("conversation-id", "teal");
    assert.equal((await names.sessionColorOverrides())["conversation-id"], "teal");

    await names.setSessionColor("conversation-id", null);
    assert.equal((await names.sessionColorOverrides())["conversation-id"], undefined);
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("conversation creation and the row menu both offer the colour palette", async () => {
  const [html, app, styles, server] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("src/server.ts", "utf8"),
  ]);

  const createForm = html.slice(html.indexOf('id="newSessionNameForm"'), html.indexOf('id="secretAccountDialog"'));
  assert.match(createForm, /data-testid="new-session-color-swatches"/);
  assert.match(html, /data-testid="conversation-color-dialog"/);
  assert.match(html, /data-testid="conversation-color-swatches"/);
  assert.match(app, /testid: "session-color-button"/);
  assert.match(app, /selectedSessionColor\(elements\.newSessionColorSwatches\)/);
  assert.match(app, /saveSessionColor\(payload\.sessionId, state\.engine, pendingColor\)/);
  assert.match(app, /button\.dataset\.color = session\.color/);
  assert.match(styles, /\.session-card\[data-color\]/);
  assert.match(server, /app\.put\("\/api\/projects\/:projectId\/sessions\/color"/);
  assert.match(server, /setSessionColor\(payload\.sessionId, payload\.color\)/);
});
