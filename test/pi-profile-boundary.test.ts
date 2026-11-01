import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createAgentSession, getAgentDir, SessionManager, SettingsManager } from "../src/pi-sdk.js";
import { createSessionModelRuntime } from "../src/provider-profiles/pi.js";
import { PiSession } from "../src/harnesses/pi/runtime.js";

const credential = async (provider: string) => provider === "zai" || provider === "openai" ? { type: "api_key" as const, key: `fixture-profile-${provider}` } : undefined;
const list = async () => [{ providerId: "zai", type: "api_key" as const }, { providerId: "openai", type: "api_key" as const }];

test("selected Pi authentication ignores machine models.json keys and authentication headers", async () => {
  const file = path.join(getAgentDir(), "models.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ providers: {
    zai: { headers: { Authorization: "Bearer fixture-machine-account" } },
    google: { apiKey: "fixture-machine-google" },
  } }));
  try {
    const runtime = await createSessionModelRuntime(credential, list, () => true);
    const auth = await runtime.getAuth("zai");
    assert.equal(auth?.auth.apiKey, "fixture-profile-zai");
    assert.equal(auth?.auth.headers?.Authorization, undefined);
    assert.equal(await runtime.getAuth("google"), undefined);
    assert.equal(await runtime.checkAuth("google"), undefined);
    assert.equal((await runtime.getAvailable()).some((model) => model.provider === "google"), false);
  } finally { await rm(file, { force: true }); }
});

test("Pi configure authenticates model switching inside the selected profile", async () => {
  let pinned = false;
  const runtime = await createSessionModelRuntime(async (provider) => pinned ? credential(provider) : undefined, async () => pinned ? list() : [], () => pinned);
  const { session } = await createAgentSession({ modelRuntime: runtime, model: runtime.getModels("zai")[0],
    sessionManager: SessionManager.inMemory(), settingsManager: SettingsManager.inMemory(), noTools: "all" });
  const handle = { session, safeguardsEnabled: true, dispose: () => session.dispose(),
    withModelProfile: async <T>(_provider: string, work: () => Promise<T>) => { pinned = true; try { return await work(); } finally { pinned = false; } } };
  const harness = new PiSession({ projectId: "fixture", cwd: process.cwd(), sessionId: session.sessionId }, handle as never);
  try {
    const model = runtime.getModels("openai")[0];
    await harness.configure({ provider: model.provider, modelId: model.id, reasoning: "off" });
    assert.equal(session.model?.provider, "openai");
    assert.equal(pinned, false);
  } finally { harness.dispose(); }
});
