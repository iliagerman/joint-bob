import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getSettings, updateSettings } from "../src/settings.js";
import { initializeKiroSession, readKiroSession } from "../src/harnesses/kiro/storage.js";
import { kiroAgentProfile } from "../src/harnesses/kiro/resources.js";

test("new Kiro transcripts persist V3 while old transcripts remain V2", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kiro-v3-storage-")), previous = getSettings();
  try {
    updateSettings({ runtimes: { ...previous.runtimes, kiro: { ...previous.runtimes.kiro, configPath: root, sessionPath: path.join(root, "sessions") } } });
    const file = await initializeKiroSession({ cwd: root, projectId: "fixture", sessionId: "v3" }, { provider: "kiro", modelId: "default", reasoning: "medium" });
    assert.equal((await readKiroSession(file)).nativeEngine, "v3");
    const header = JSON.parse((await readFile(file, "utf8")).trim());
    delete header.nativeEngine;
    await writeFile(file, JSON.stringify(header) + "\n");
    assert.equal((await readKiroSession(file)).nativeEngine, "v2");
    await writeFile(file, JSON.stringify({ ...header, nativeEngine: "unexpected" }) + "\n");
    await assert.rejects(readKiroSession(file), /Invalid Kiro transcript header/);
  } finally { updateSettings({ runtimes: previous.runtimes }); await rm(root, { recursive: true, force: true }); }
});

test("V3 profiles use current permissions and keep strict resource isolation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kiro-v3-profile-")), previous = getSettings();
  try {
    await mkdir(path.join(root, "sessions"));
    updateSettings({ strictResourceIsolation: true, runtimes: { ...previous.runtimes, kiro: { ...previous.runtimes.kiro, configPath: root, sessionPath: path.join(root, "sessions") } } });
    const name = await kiroAgentProfile({ cwd: root, projectId: "fixture", sessionId: "v3" }, "Synthetic context", ["read"], root, "v3");
    const profile = JSON.parse(await readFile(path.join(root, "agents", name + ".json"), "utf8"));
    assert.equal(profile.allowedTools, undefined);
    assert.equal(profile.includePowers, false);
    assert.equal(profile.includeMcpJson, false);
    assert.deepEqual(profile.permissions, { rules: [{ capability: "all", match: ["*"], effect: "ask" }] });
    assert.deepEqual(profile.tools, ["read"]);
    const config = JSON.parse(await readFile(path.join(root, "settings/cli.json"), "utf8"));
    assert.equal(config["chat.disableInheritingDefaultResources"], true);
    assert.equal(config["chat.enableAutoAgentUpgrade"], false);
  } finally { updateSettings({ strictResourceIsolation: previous.strictResourceIsolation, runtimes: previous.runtimes }); await rm(root, { recursive: true, force: true }); }
});
