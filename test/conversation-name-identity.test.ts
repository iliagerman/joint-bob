import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

