import assert from "node:assert/strict";
import { mkdir, writeFile, rm, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getAgentDir } from "../src/pi-sdk.js";
import { getClusterNode } from "../src/cluster.js";
import { createProviderProfile } from "../src/provider-profiles/store.js";
import { profileModelRuntime, logoutProfile } from "../src/provider-profiles/service.js";
import { piProfileProviders } from "../src/provider-profiles/pi-credentials.js";

test("existing Pi profiles pick up installed and removed provider packages without restarting", async () => {
  await getClusterNode();
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-profile-package-"));
  const settings = path.join(getAgentDir(), "settings.json");
  const profile = createProviderProfile("fixture", { provider: "pi", label: "Existing profile" });
  await mkdir(getAgentDir(), { recursive: true });
  await mkdir(path.join(root, "extensions"));
  await writeFile(path.join(root, "extensions", "provider.ts"), `export default pi => pi.registerProvider("fixture-profile-provider", {
    api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "fixture-package-key",
    models: [{ id: "fixture-model", name: "Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }]
  });`);
  try {
    assert.equal((await piProfileProviders(profile)).some((item) => item.id === "fixture-profile-provider"), false);
    await writeFile(settings, JSON.stringify({ packages: [root] }));
    assert.equal((await piProfileProviders(profile)).some((item) => item.id === "fixture-profile-provider"), true);
    assert.equal((await (await profileModelRuntime(profile)).getAvailable()).some((model) => model.provider === "fixture-profile-provider"), false, "package-configured key is not this profile's credential");
    await writeFile(settings, JSON.stringify({ packages: [] }));
    assert.equal((await piProfileProviders(profile)).some((item) => item.id === "fixture-profile-provider"), false);
  } finally {
    await logoutProfile(profile);
    await rm(settings, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
