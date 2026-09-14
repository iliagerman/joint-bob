import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Pi model catalogue supplies native provider presentation metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-model-presentation-"));
  const configPath = path.join(root, "pi");
  const previousEnvironment = { ...process.env };
  try {
    await mkdir(configPath);
    const model = { reasoning: true, input: ["text", "image"], contextWindow: 32000, maxTokens: 1024 };
    await writeFile(path.join(configPath, "models.json"), JSON.stringify({ providers: {
      "openai-codex": {
        baseUrl: "http://127.0.0.1:1", apiKey: "fixture-openai-key", api: "openai-completions",
        models: [{ ...model, id: "fixture-gpt", name: "Fixture GPT" }],
      },
      zai: {
        baseUrl: "http://127.0.0.1:2", apiKey: "fixture-zai-key", api: "openai-completions",
        models: [{ ...model, id: "fixture-glm", name: "Fixture GLM" }],
      },
    } }));
    const settings = await import("../src/settings.js");
    const previousSettings = settings.getSettings();
    settings.updateSettings({ ...previousSettings, pi: { ...previousSettings.runtimes.pi, configPath } });
    try {
      const runtime = (await import("../src/harnesses/pi/runtime.js")).default;
      const models = await runtime.models();
      const gpt = models.find(({ provider, id }) => provider === "openai-codex" && id === "fixture-gpt");
      const glm = models.find(({ provider, id }) => provider === "zai" && id === "fixture-glm");
      assert.equal(gpt?.providerLabel, "GPT");
      assert.equal(gpt?.providerIcon, "openai");
      assert.equal(glm?.providerLabel, "GLM");
      assert.equal(glm?.providerIcon, undefined);
    } finally {
      settings.updateSettings(previousSettings);
    }
  } finally {
    process.env = previousEnvironment;
    await rm(root, { recursive: true, force: true });
  }
});
