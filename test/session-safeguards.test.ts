import assert from "node:assert/strict";
import { promises as fsPromises } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { PiSession } from "../src/harnesses/pi/runtime.js";
import { createPiSession, isPermissionSafeguardExtension, sessionSafeguardsEnabled } from "../src/pi-service.js";
import { getProjectResourcePaths, updateProjectResourcePaths } from "../src/settings.js";
import { addProject, removeProject } from "../src/store.js";
import { appSource, serverSource } from "./source.js";

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

test("Pi session stays busy while safeguards rebuild native resources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-safeguards-reload-"));
  const cwd = path.join(root, "project");
  const sessionDir = path.join(root, "sessions");
  const rule = path.join(root, "PROJECT-RULE.md");
  let projectId: string | undefined;
  let previousResources: ReturnType<typeof getProjectResourcePaths> | undefined;
  let session: PiSession | undefined;
  let releaseRule: (() => void) | undefined;
  try {
    await mkdir(cwd, { recursive: true });
    projectId = (await addProject("Safeguards reload", cwd)).id;
    previousResources = getProjectResourcePaths(projectId);
    await writeFile(rule, "Configured project rule\n");
    updateProjectResourcePaths(projectId, { skills: [], prompts: [], rules: [rule], plugins: [] });
    const manager = SessionManager.create(cwd, sessionDir);
    manager.appendMessage({
      role: "assistant", content: [], api: "test", provider: "test", model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    });
    const sessionPath = manager.getSessionFile();
    if (!sessionPath) throw new Error("Persisted session file was not created");
    const options = { cwd, projectId, sessionPath, conversationId: manager.getSessionId(), sessionId: manager.getSessionId() };
    session = new PiSession(options, await createPiSession({ ...options, conversation: { engine: "pi", sessionId: manager.getSessionId() } }));

    const originalReadFile = fsPromises.readFile;
    const ruleBlocked = new Promise<void>((resolve) => { releaseRule = resolve; });
    mock.method(fsPromises, "readFile", async (...args: Parameters<typeof originalReadFile>) => {
      if (path.resolve(String(args[0])) === path.resolve(rule)) await ruleBlocked;
      return originalReadFile(...args);
    });
    syncBuiltinESMExports();

    const changing = session.setSafeguards(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const busyDuringReload = session.isBusy();
    releaseRule();
    releaseRule = undefined;
    await changing;
    assert.equal(busyDuringReload, true);
    assert.equal(session.isBusy(), false);
    assert.equal(session.status().safeguardsEnabled, false);
  } finally {
    releaseRule?.();
    mock.restoreAll();
    syncBuiltinESMExports();
    session?.dispose();
    if (projectId && previousResources) {
      updateProjectResourcePaths(projectId, previousResources);
      await removeProject(projectId);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("session safeguard socket contract stays available without a chat indicator", async () => {
  const [html, app, server, runtime, types] = await Promise.all([
    readFile("public/index.html", "utf8"),
    appSource(),
    serverSource(),
    readFile("src/harnesses/pi/runtime.ts", "utf8"),
    readFile("src/types.ts", "utf8"),
  ]);

  assert.doesNotMatch(html, /safeguardsButton|chat-safeguards-button|Safeguards on|Unsafe mode/);
  assert.doesNotMatch(app, /elements\.safeguardsButton|syncSafeguardsButton|type: "setSafeguards"/);
  assert.match(server, /message\.type === "setSafeguards"[\s\S]*?session\.setSafeguards\(message\.safeguardsEnabled\)/);
  assert.match(runtime, /previous\.reloadingSkills = true;[\s\S]*?appendCustomEntry\("joint-bob:safeguards", \{ enabled \}\)/);
  assert.match(types, /safeguardsEnabled\?: boolean;/);
});
