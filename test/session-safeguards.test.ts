import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isPermissionSafeguardExtension, sessionSafeguardsEnabled } from "../src/pi-service.js";

test("Pi safeguard state defaults on and follows the latest session entry", () => {
  const sessionManager = SessionManager.inMemory("/tmp/session-safeguards");

  assert.equal(sessionSafeguardsEnabled(sessionManager), true);
  sessionManager.appendCustomEntry("joint-bob:safeguards", { enabled: false });
  assert.equal(sessionSafeguardsEnabled(sessionManager), false);
  sessionManager.appendCustomEntry("joint-bob:safeguards", { enabled: true });
  assert.equal(sessionSafeguardsEnabled(sessionManager), true);
});

test("Pi safeguard state survives reopening a persisted session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-session-safeguards-"));
  const cwd = path.join(root, "cwd");
  const sessionDir = path.join(root, "sessions");
  try {
    const sessionManager = SessionManager.create(cwd, sessionDir);
    sessionManager.appendMessage({
      role: "assistant",
      content: [],
      api: "test",
      provider: "test",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    });
    sessionManager.appendCustomEntry("joint-bob:safeguards", { enabled: false });
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) throw new Error("Persisted session file was not created");

    const reopened = SessionManager.open(sessionFile, sessionDir, cwd);
    assert.equal(sessionSafeguardsEnabled(reopened), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid persisted safeguard state fails instead of silently changing protection", () => {
  const sessionManager = SessionManager.inMemory("/tmp/session-safeguards-invalid");
  sessionManager.appendCustomEntry("joint-bob:safeguards", { enabled: "no" });

  assert.throws(() => sessionSafeguardsEnabled(sessionManager), /Invalid session safeguards state/);
});

test("unsafe mode removes only the permission safeguard extension", () => {
  assert.equal(isPermissionSafeguardExtension("/Users/test/.pi/agent/extensions/safe-guard.ts"), true);
  assert.equal(isPermissionSafeguardExtension("/Users/test/.pi/agent/extensions/safe-guard.js"), true);
  assert.equal(isPermissionSafeguardExtension("/Users/test/.pi/agent/extensions/git-guard.ts"), false);
  assert.equal(isPermissionSafeguardExtension("/Users/test/.pi/agent/extensions/block-new-git-branches.ts"), false);
});

test("chat exposes an accessible session safeguard control and socket contract", async () => {
  const [html, app, server, types] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("src/server.ts", "utf8"),
    readFile("src/types.ts", "utf8"),
  ]);

  assert.match(html, /id="safeguardsButton"[^>]*aria-pressed="true"[^>]*data-testid="chat-safeguards-button"/);
  assert.match(app, /type: "setSafeguards", safeguardsEnabled/);
  assert.match(app, /Dangerous shell commands and protected-path writes/);
  assert.match(server, /payload\.type === "setSafeguards"/);
  const safeguardAppend = "appendCustomEntry(\"joint-bob:safeguards\", { enabled });";
  assert.match(server, /appendCustomEntry\("joint-bob:safeguards", \{ enabled \}\)/);
  assert.ok(server.indexOf("session.lastLocalEventAt = Date.now();") < server.indexOf(safeguardAppend));
  assert.match(types, /safeguardsEnabled\?: boolean;/);
});
