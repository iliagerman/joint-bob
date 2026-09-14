import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import runtime from "../src/harnesses/kiro/runtime.js";
import { getSettings, updateSettings } from "../src/settings.js";

const levels = ["low", "medium", "high", "xhigh", "max"];
const fallback = [{ provider: "kiro", id: "default", label: "Kiro default", thinkingLevels: levels }];
const fixtureSource = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["chat", "--list-models", "--format", "json"])) process.exit(2);
const catalogue = fs.readFileSync(path.join(process.env.KIRO_HOME, "catalogue.json"), "utf8");
if (catalogue === "__FAIL__") process.exit(2);
process.stdout.write(catalogue);
`;

test("Kiro discovers and refreshes the native model catalogue before a session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kiro-model-discovery-"));
  const previousSettings = getSettings();
  const originalWarn = console.warn;
  try {
    const executable = path.join(root, "kiro-fixture");
    const configPath = path.join(root, "config");
    const sessionPath = path.join(configPath, "sessions");
    const cataloguePath = path.join(configPath, "catalogue.json");
    await mkdir(sessionPath, { recursive: true });
    await writeFile(executable, fixtureSource);
    await chmod(executable, 0o700);
    updateSettings({
      runtimes: { ...previousSettings.runtimes, kiro: { executable, configPath, sessionPath } },
      syncthing: { endpoint: "" },
    });

    await writeFile(cataloguePath, JSON.stringify({
      models: [
        { model_id: "gpt-fixture", model_name: "GPT Fixture" },
        { model_id: "opus-fixture", model_name: "Opus Fixture" },
      ],
      default_model: "gpt-fixture",
    }));
    assert.deepEqual(await runtime.models(), [
      { provider: "kiro", id: "gpt-fixture", label: "GPT Fixture", thinkingLevels: levels },
      { provider: "kiro", id: "opus-fixture", label: "Opus Fixture", thinkingLevels: levels },
    ]);

    await writeFile(cataloguePath, JSON.stringify({
      models: [{ model_id: "third-fixture", model_name: "Third Fixture" }],
      default_model: "third-fixture",
    }));
    assert.deepEqual(await runtime.models(), [
      { provider: "kiro", id: "third-fixture", label: "Third Fixture", thinkingLevels: levels },
    ]);
    assert.deepEqual(await readdir(sessionPath), []);

    await writeFile(cataloguePath, JSON.stringify({ models: [{ model_id: 3, model_name: "Bad" }] }));
    await assert.rejects(runtime.models(), /Invalid Kiro ACP model ID/);
    await writeFile(cataloguePath, JSON.stringify({ models: {} }));
    await assert.rejects(runtime.models(), /Invalid Kiro ACP model catalogue/);
    await writeFile(cataloguePath, "not json");
    await assert.rejects(runtime.models(), SyntaxError);

    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    updateSettings({
      runtimes: { ...previousSettings.runtimes, kiro: { executable: path.join(root, "missing"), configPath, sessionPath } },
      syncthing: { endpoint: "" },
    });
    assert.deepEqual(await runtime.models(), fallback);
    assert.equal(warnings.length, 1);

    updateSettings({
      runtimes: { ...previousSettings.runtimes, kiro: { executable, configPath, sessionPath } },
      syncthing: { endpoint: "" },
    });
    await writeFile(cataloguePath, "__FAIL__");
    assert.deepEqual(await runtime.models(), fallback);
    assert.equal(warnings.length, 2);
  } finally {
    console.warn = originalWarn;
    updateSettings({ runtimes: previousSettings.runtimes, syncthing: { endpoint: previousSettings.syncthing.endpoint } });
    await rm(root, { recursive: true, force: true });
  }
});
