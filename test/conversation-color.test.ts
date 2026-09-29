import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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

