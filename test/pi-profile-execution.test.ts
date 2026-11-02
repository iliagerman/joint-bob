import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { createProviderProfile, setProviderProfileSelection, setProviderProfileShared } from "../src/provider-profiles/store.js";
import { openAIAuthPath, projectProviderProfile, profileModelRuntime, profileAvailability, localProfileCredential } from "../src/provider-profiles/service.js";
import { piProfileCredential } from "../src/provider-profiles/pi-credentials.js";
import { createSessionModelRuntime } from "../src/provider-profiles/pi.js";
import { runAsAccount } from "../src/account-context.js";
import { withAutomationProfile } from "../src/provider-profiles/context.js";
import { addProject } from "../src/store.js";
import { setResourceOwner } from "../src/ownership.js";

await getClusterNode();
const actor = { accountId: "pi-execution-owner", username: "fixture", role: "member" as const, isRemoteLogin: false, homeNodeId: null };
async function authenticatedProfile(label: string, key: string) {
  const profile = createProviderProfile(actor.accountId, { provider: "pi", label });
  await mkdir(path.dirname(openAIAuthPath(profile)), { recursive: true, mode: 0o700 });
  await writeFile(openAIAuthPath(profile), JSON.stringify({ zai: { type: "api_key", key }, openai: { type: "api_key", key: `${key}-openai` } }), { mode: 0o600 });
  return profile;
}

test("Pi-kind selections resolve scopes independently of legacy and Claude selections", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-profile-scope-"));
  try {
    const project = await addProject("Pi scope", root);
    setResourceOwner("project", project.id, actor.accountId);
    const defaults = await authenticatedProfile("Default", "fixture-default");
    const workspace = await authenticatedProfile("Workspace", "fixture-workspace");
    const specific = await authenticatedProfile("Project", "fixture-project");
    const conversation = await authenticatedProfile("Conversation", "fixture-conversation");
    const legacy = createProviderProfile(actor.accountId, { provider: "openai-codex", label: "Legacy" });
    setProviderProfileSelection(actor.accountId, { provider: "openai-codex", scope: "default", scopeId: "", profileId: legacy.id });
    const resolve = (modelProvider = "zai", conversationId = "c1") => runAsAccount(actor, () => projectProviderProfile(project.id, conversationId, modelProvider, "pi"));
    assert.equal((await resolve("openai-codex"))?.id, legacy.id);
    for (const [scope, scopeId, profile] of [["default", "", defaults], ["workspace", project.type!, workspace], ["project", project.id, specific], ["conversation", JSON.stringify([project.id, "c1"]), conversation]] as const) {
      setProviderProfileSelection(actor.accountId, { provider: "pi", scope, scopeId, profileId: profile.id });
      assert.equal((await resolve())?.id, profile.id);
      assert.equal((await resolve("openai"))?.id, profile.id);
    }
    assert.equal((await resolve("zai", "c2"))?.id, specific.id);
    await assert.rejects(runAsAccount(actor, () => projectProviderProfile(project.id, "c1", "claude")), /Select your own/);
    const assigned = await withAutomationProfile({ accountId: actor.accountId, profileId: defaults.id }, () => resolve());
    assert.equal(assigned?.id, defaults.id);
    setProviderProfileShared(actor.accountId, conversation.id, true);
    await assert.rejects(resolve(), /Shared profiles/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("selected Pi runtime switches providers without using ambient auth or another profile", async () => {
  const one = await authenticatedProfile("One", "fixture-one");
  const two = await authenticatedProfile("Two", "fixture-two");
  const runtime = async (profile: typeof one) => createSessionModelRuntime(
    (provider) => piProfileCredential(profile, provider),
    async () => (await (await profileModelRuntime(profile)).listCredentials()).map(({ providerId, type }) => ({ providerId, type })),
    () => true,
  );
  const old = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "fixture-ambient-not-selected";
  try {
    const [a, b] = await Promise.all([runtime(one), runtime(two)]);
    assert.equal((await a.getAuth("zai"))?.auth.apiKey, "fixture-one");
    assert.equal((await a.getAuth("openai"))?.auth.apiKey, "fixture-one-openai");
    assert.equal((await b.getAuth("zai"))?.auth.apiKey, "fixture-two");
    assert.equal(await a.getAuth("google"), undefined, "ambient authentication must not escape the profile boundary");
    assert.equal((await a.getAvailable()).some((model) => model.provider === "google"), false);
    const google = a.getProvider("google")!;
    const native = (await profileModelRuntime(one)).getProvider("google")!;
    // Extensions can register a provider after the session runtime was created.
    const { ModelRuntime } = await import("../src/pi-sdk.js");
    const builtins = await ModelRuntime.create({ refreshOnCreate: false, modelsPath: null });
    a.registerNativeProvider({ ...google, id: "fixture-late-provider", auth: builtins.getProvider("google")!.auth });
    assert.equal(await a.getAuth("fixture-late-provider"), undefined, "late provider registration must not restore ambient auth");
    assert.ok(native.auth.apiKey);
    const local = await profileAvailability(one);
    assert.equal(local.twin, null);
    await assert.rejects(localProfileCredential(one), /stay on this node/);
  } finally { if (old === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = old; }
});

test("with nothing chosen, a member's only Pi profile serves the providers it holds and no others", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-only-profile-"));
  try {
    const member = { ...actor, accountId: "pi-only-profile-owner" };
    const project = await addProject("Pi only profile", root);
    setResourceOwner("project", project.id, member.accountId);
    const only = createProviderProfile(member.accountId, { provider: "pi", label: "Only" });
    await mkdir(path.dirname(openAIAuthPath(only)), { recursive: true, mode: 0o700 });
    await writeFile(openAIAuthPath(only), JSON.stringify({ zai: { type: "api_key", key: "fixture-only" } }), { mode: 0o600 });
    const resolve = (provider: string) => runAsAccount(member, () => projectProviderProfile(project.id, "c1", provider, "pi"));
    assert.equal((await resolve("zai"))?.id, only.id);
    assert.equal(await resolve("openai"), undefined, "not for a provider the profile does not hold");
    await assert.rejects(resolve("openai-codex"), /Select your own/, "a subscription it lacks still needs the member's own profile");
    const chatgpt = createProviderProfile(member.accountId, { provider: "openai-codex", label: "ChatGPT" });
    assert.equal((await resolve("openai-codex"))?.id, chatgpt.id, "the only ChatGPT profile is used automatically");
    createProviderProfile(member.accountId, { provider: "pi", label: "Second" });
    assert.equal(await resolve("zai"), undefined, "two Pi profiles: none is guessed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
