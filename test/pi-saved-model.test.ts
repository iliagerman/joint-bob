import assert from "node:assert/strict";
import test from "node:test";

// A provider that signs in from the environment makes its models runnable without a login.
process.env.OPENAI_API_KEY = "test-key";

test("settings saved with a model the picker no longer offers still validate, so its interrupted turns resume", async (t) => {
  const { getHarnessRuntime } = await import("../src/harnesses.js");
  const service = await import("../src/pi-service.js");
  const runtime = await getHarnessRuntime("pi");
  const offered = await service.listAvailableModels();
  let modelId: string | undefined;
  for (const candidate of ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]) if (await service.modelIsRunnable("openai", candidate)) { modelId = candidate; break; }
  if (!modelId) { t.skip("this Pi release no longer ships a retired model to test with"); return; }
  assert.equal(offered.some((model) => model.provider === "openai" && model.id === modelId), false, "the retired family stays out of the picker");

  await runtime.validateSettings({ provider: "openai", modelId, reasoning: "medium" });
  await assert.rejects(runtime.validateSettings({ provider: "openai", modelId: "no-such-model", reasoning: "medium" }), /Model not found: openai\/no-such-model/);
  await assert.rejects(runtime.validateSettings({ provider: "not-signed-in", modelId, reasoning: "medium" }), /Model not found/);
});
