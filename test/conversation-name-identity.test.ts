import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("conversation names are stored under the conversation id, not its file path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-conversation-name-identity-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousNamesPath = process.env.PI_MOBILE_WEB_NAMES_PATH;
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  process.env.PI_MOBILE_WEB_NAMES_PATH = path.join(root, "names.json");
  try {
    const suffix = `${Date.now()}-${Math.random()}`;
    const names = await import(new URL(`../src/names.ts?conversation-name-identity=${suffix}`, import.meta.url).href);

    await names.setSessionTitle("7a10a958-69e1-43e6-9381-615eda349de6", "Outlook schedule");
    const overrides = await names.sessionTitleOverrides();
    // The key is the bare conversation id: no directory, no ".jsonl", no "claude:" prefix.
    assert.equal(overrides["7a10a958-69e1-43e6-9381-615eda349de6"], "Outlook schedule");
    assert.equal(overrides["7a10a958-69e1-43e6-9381-615eda349de6.jsonl"], undefined);

    // A rename wins over whatever the harness later names the same conversation.
    await names.ensureSessionTitle("7a10a958-69e1-43e6-9381-615eda349de6", "Harness title");
    assert.equal((await names.sessionTitleOverrides())["7a10a958-69e1-43e6-9381-615eda349de6"], "Outlook schedule");

    // An unnamed conversation still takes the harness title.
    await names.ensureSessionTitle("11111111-2222-3333-4444-555555555555", "Harness title");
    assert.equal((await names.sessionTitleOverrides())["11111111-2222-3333-4444-555555555555"], "Harness title");
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousNamesPath === undefined) delete process.env.PI_MOBILE_WEB_NAMES_PATH;
    else process.env.PI_MOBILE_WEB_NAMES_PATH = previousNamesPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("a Claude conversation is identified by its run id, like a Pi conversation", async () => {
  const claude = await readFile("src/claude-service.ts", "utf8");

  // The summary id is the conversation identity used for ownership, renames and
  // the active-row highlight, so it must be the bare run id on both engines.
  assert.match(claude, /id: path\.basename\(filePath, "\.jsonl"\)/);
});

test("the conversation list applies renames by conversation id", async () => {
  const harnesses = await readFile("src/harnesses.ts", "utf8");

  assert.match(harnesses, /overrides\[session\.id\] \?\? session\.title/);
  assert.doesNotMatch(harnesses, /sessionKey/);
});

test("renaming a conversation does not require it to be in the conversation list", async () => {
  const server = await readFile("src/server.ts", "utf8");

  const start = server.indexOf('app.put("/api/projects/:projectId/sessions/title"');
  assert.notEqual(start, -1, "the rename endpoint was not found");
  const handler = server.slice(start, server.indexOf("app.delete(", start));

  // A conversation named at creation has no transcript on disk yet, so a lookup
  // through listHarnessSessions would 404 exactly when the name is first set.
  assert.doesNotMatch(handler, /listHarnessSessions/);
  assert.match(handler, /setSessionTitle\(payload\.sessionId, payload\.title\)/);
  assert.match(handler, /requireLocalConversationOwner\(payload\.engine, payload\.sessionId\)/);
});

test("a name typed for a new conversation is saved as soon as the conversation has an id", async () => {
  const app = await readFile("public/app.js", "utf8");

  // Deferring the save to agent_end loses the name whenever the first turn
  // fails, is aborted, or the tab is closed before it ends.
  assert.doesNotMatch(app, /applyPendingSessionTitle/);
  assert.match(app, /function saveSessionTitle\(/);
  assert.match(app, /body: JSON\.stringify\(\{ sessionId, engine, title \}\)/);
});
