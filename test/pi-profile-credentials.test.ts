import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { test } from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { createProviderProfile, providerProfile } from "../src/provider-profiles/store.js";
import { openAIAuthPath, profileModelRuntime, logoutProfile, profileLoginState } from "../src/provider-profiles/service.js";
import { profileLogins } from "../src/provider-profiles/login.js";

await getClusterNode();

async function signIn(profile: ReturnType<typeof createProviderProfile>, provider: string, answer: string) {
  const { startPiProfileLogin } = await import("../src/provider-profiles/pi-credentials.js");
  await startPiProfileLogin(profile.owner, profile.id, provider, "api_key");
  // SDK interaction and persistence complete asynchronously; yield until their observable states change.
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = profileLogins.status(profile.owner, profile.id)!;
    if (status.state === "failed") assert.fail(status.message);
    if (status.prompt) { profileLogins.answer(profile.owner, profile.id, answer); break; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = profileLogins.status(profile.owner, profile.id)!;
    if (status.state !== "waiting") { assert.equal(status.state, "complete"); return; }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Login did not settle");
}

test("Pi profiles keep multiple provider credentials and same-provider accounts independent", async () => {
  const first = createProviderProfile("pi-owner", { provider: "pi", label: "Multi" });
  const second = createProviderProfile("pi-owner", { provider: "pi", label: "Other z.ai account" });
  const { piProfileProviders, piProfileCredential, removePiProfileProvider } = await import("../src/provider-profiles/pi-credentials.js");
  const providers = await piProfileProviders(first);
  assert.ok(providers.find((item) => item.id === "zai")?.methods.some((item) => item.id === "api_key"));
  assert.ok(providers.find((item) => item.id === "openai-codex")?.methods.some((item) => item.id === "oauth"));
  await signIn(first, "zai", "fixture-zai-first");
  await signIn(first, "openai", "fixture-openai-first");
  await signIn(second, "zai", "fixture-zai-second");
  assert.deepEqual(await piProfileCredential(first, "zai"), { type: "api_key", key: "fixture-zai-first" });
  assert.deepEqual(await piProfileCredential(second, "zai"), { type: "api_key", key: "fixture-zai-second" });
  assert.equal((await stat(openAIAuthPath(first))).mode & 0o777, 0o600);
  assert.equal((await profileLoginState(first)).signedIn, true);
  const status = await piProfileProviders(first);
  assert.deepEqual(status.filter((item) => item.configured).map((item) => item.id).sort(), ["openai", "zai"]);
  assert.doesNotMatch(JSON.stringify(status), /fixture-|refresh|accessToken/);
  await removePiProfileProvider(first, "zai");
  assert.equal(await piProfileCredential(first, "zai"), undefined);
  assert.deepEqual(await piProfileCredential(first, "openai"), { type: "api_key", key: "fixture-openai-first" });
  assert.deepEqual(await piProfileCredential(second, "zai"), { type: "api_key", key: "fixture-zai-second" });
  assert.throws(() => providerProfile("other-owner", first.id), /not found/);
  await logoutProfile(first);
  assert.equal((await profileLoginState(first)).signedIn, false);
  assert.deepEqual(await piProfileCredential(second, "zai"), { type: "api_key", key: "fixture-zai-second" });
});

test("cancelling a Pi provider login never persists its late credential", async () => {
  const profile = createProviderProfile("pi-owner", { provider: "pi", label: "Cancelled" });
  const { startPiProfileLogin, piProfileCredential } = await import("../src/provider-profiles/pi-credentials.js");
  const runtime = await profileModelRuntime(profile);
  const provider = runtime.getProvider("zai")!;
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  runtime.registerNativeProvider({ ...provider, auth: { ...provider.auth, apiKey: { ...provider.auth.apiKey!, login: async () => {
    await new Promise<void>((resolve) => { release = resolve; entered(); });
    return { type: "api_key", key: "fixture-cancelled" };
  } } } });
  await startPiProfileLogin(profile.owner, profile.id, "zai", "api_key");
  await ready;
  profileLogins.cancel(profile.owner, profile.id);
  release();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await piProfileCredential(profile, "zai"), undefined);
  assert.equal(profileLogins.status(profile.owner, profile.id)?.state, "cancelled");
});

test("Pi profile login validates methods and stores OAuth without replacing other providers", async () => {
  const profile = createProviderProfile("pi-owner", { provider: "pi", label: "OAuth and API key" });
  const { startPiProfileLogin, piProfileCredential } = await import("../src/provider-profiles/pi-credentials.js");
  await assert.rejects(startPiProfileLogin("other-owner", profile.id, "zai", "api_key"), /not found/);
  await assert.rejects(startPiProfileLogin(profile.owner, profile.id, "zai", "oauth"), /unavailable/);
  const runtime = await profileModelRuntime(profile);
  const provider = runtime.getProvider("openai-codex")!;
  runtime.registerNativeProvider({ ...provider, auth: { ...provider.auth, oauth: { ...provider.auth.oauth!, login: async () => ({ type: "oauth", access: "fixture-oauth", refresh: "fixture-refresh", expires: Date.now() + 3_600_000 }) } } });
  await startPiProfileLogin(profile.owner, profile.id, "openai-codex", "oauth");
  for (let attempt = 0; attempt < 200 && profileLogins.status(profile.owner, profile.id)!.state === "waiting"; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(profileLogins.status(profile.owner, profile.id)!.state, "complete");
  await signIn(profile, "zai", "fixture-zai");
  assert.equal((await piProfileCredential(profile, "openai-codex"))?.type, "oauth");
  assert.equal((await piProfileCredential(profile, "zai"))?.type, "api_key");
});
