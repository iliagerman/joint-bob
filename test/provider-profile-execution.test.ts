import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, realpath, stat, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createProviderProfile, setProviderProfileSelection } from "../src/provider-profiles/store.js";
import { claudeProfileEnvironment, prepareClaudeProfile, prepareClaudeExecution, profileDirectory } from "../src/provider-profiles/claude.js";
import { createSessionModelRuntime } from "../src/provider-profiles/pi.js";
import { openAIAuthPath, persistOpenAIProfileCredential, profileModelRuntime, refreshedProfileCredential } from "../src/provider-profiles/service.js";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { getClusterNode } from "../src/cluster.js";

// Profile writes are stamped with this node's identity for twin sync.
await getClusterNode();

test("selected Claude profiles scrub competing authentication without changing the caller's environment", () => {
  const inherited = { CLAUDE_CODE_OAUTH_TOKEN: "fixture-old", CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "9", ANTHROPIC_API_KEY: "fixture-api", ANTHROPIC_AUTH_TOKEN: "fixture-auth", ANTHROPIC_OAUTH_TOKEN: "fixture-oauth", CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_BASE_URL: "https://example.invalid", PATH: "/bin" };
  const env = claudeProfileEnvironment(inherited, "/local/profile");
  assert.deepEqual(env, { CLAUDE_CONFIG_DIR: "/local/profile", PATH: "/bin" });
  assert.equal(inherited.CLAUDE_CODE_OAUTH_TOKEN, "fixture-old");
});

test("Claude OAuth identity is verified before installing the native account config", async () => {
  const { claudeOAuthIdentity } = await import("../src/provider-profiles/claude-identity.js");
  const identity = await claudeOAuthIdentity("fixture-access", new AbortController().signal, async (_url, options) => {
    assert.equal((options!.headers as Record<string, string>).Authorization, "Bearer fixture-access");
    return Response.json({ account: { uuid: "fixture-account", email: "fixture@example.invalid" }, organization: { uuid: "fixture-org" } });
  });
  assert.deepEqual(identity, { accountUuid: "fixture-account", emailAddress: "fixture@example.invalid", organizationUuid: "fixture-org" });
  await assert.rejects(claudeOAuthIdentity("fixture-access", new AbortController().signal, async () => Response.json({}, { status: 401 })), /Could not verify/);
});

test("Claude execution configs are private and share transcripts without refresh credentials", async () => {
  const profile = createProviderProfile("native-owner", { label: "Native", provider: "claude" });
  const { getSettings } = await import("../src/settings.js");
  const settings = getSettings().claude;
  const projects = settings.sessionPath || path.join(settings.configPath, "projects");
  try {
    await prepareClaudeProfile(profile, { accountUuid: "fixture-id", emailAddress: "fixture@example.invalid", organizationUuid: "fixture-org" });
    const execution = await prepareClaudeExecution(profile);
    try {
      const directory = execution.directory;
      assert.equal(await realpath(path.join(directory, "projects")), await realpath(projects));
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      await assert.rejects(stat(path.join(directory, ".credentials.json")), { code: "ENOENT" });
      const config = JSON.parse(await readFile(path.join(directory, ".claude.json"), "utf8"));
      assert.equal(config.oauthAccount.emailAddress, "fixture@example.invalid");
      assert.equal(config.hasCompletedOnboarding, true);
    } finally { await execution.dispose(); }
  } finally { await rm(profileDirectory(profile), { recursive: true, force: true }); }
});

test("OpenAI login persists credentials through the SDK auth store", async () => {
  const profile = createProviderProfile("login-owner", { label: "Login", provider: "openai-codex" });
  const credential = { type: "oauth" as const, access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000 };
  await persistOpenAIProfileCredential(profile, credential);
  assert.deepEqual(readStoredCredential("openai-codex", openAIAuthPath(profile)), credential);
});

test("OpenAI refresh uses the canonical SDK lock and writes rotated tokens once across concurrent requests", async () => {
  const profile = createProviderProfile("refresh-owner", { label: "Refreshing", provider: "openai-codex" });
  await mkdir(path.dirname(openAIAuthPath(profile)), { recursive: true, mode: 0o700 });
  await writeFile(openAIAuthPath(profile), JSON.stringify({ "openai-codex": { type: "oauth", access: "fixture-expired", refresh: "fixture-refresh-one", expires: 1 } }), { mode: 0o600 });
  const models = await profileModelRuntime(profile);
  const provider = models.getProvider("openai-codex")!;
  let refreshes = 0;
  models.registerNativeProvider({ ...provider, auth: { ...provider.auth, oauth: { ...provider.auth!.oauth!,
    refresh: async (credential) => {
      refreshes += 1;
      assert.equal(credential.refresh, "fixture-refresh-one");
      return { ...credential, access: "fixture-fresh", refresh: "fixture-refresh-two", expires: Date.now() + 3_600_000 };
    },
  } } });
  const credentials = await Promise.all(Array.from({ length: 4 }, () => refreshedProfileCredential(profile)));
  assert.equal(refreshes, 1);
  for (const credential of credentials) assert.equal(credential.type === "oauth" && credential.access, "fixture-fresh");
  assert.equal(readStoredCredential("openai-codex", openAIAuthPath(profile))?.type, "oauth");
  assert.equal(JSON.parse(await readFile(openAIAuthPath(profile), "utf8"))["openai-codex"].refresh, "fixture-refresh-two");
});

test("a signed-out or failed-refresh OpenAI profile never uses another node credential", async () => {
  const profile = createProviderProfile("failed-refresh-owner", { label: "Expired work", provider: "openai-codex" });
  await assert.rejects(refreshedProfileCredential(profile), /Sign in to Expired work again/);
  await mkdir(path.dirname(openAIAuthPath(profile)), { recursive: true });
  await writeFile(openAIAuthPath(profile), JSON.stringify({ "openai-codex": { type: "oauth", access: "fixture-expired", refresh: "fixture-revoked", expires: 1 } }), { mode: 0o600 });
  const models = await profileModelRuntime(profile), provider = models.getProvider("openai-codex")!;
  models.registerNativeProvider({ ...provider, auth: { ...provider.auth, oauth: { ...provider.auth!.oauth!, refresh: async () => { throw new Error("secret provider response fixture-token"); } } } });
  await assert.rejects(refreshedProfileCredential(profile), (error: Error) => {
    assert.match(error.message, /No other account was used/); assert.doesNotMatch(error.message, /fixture-token/); return true;
  });
});

test("simultaneous Pi runtimes use their own profile callbacks during model authentication", async () => {
  const credential = (name: string) => ({ type: "oauth" as const, access: `fixture-${name}`, refresh: `fixture-refresh-${name}`, expires: Date.now() + 3_600_000, accountId: `fixture-account-${name}` });
  const list = async () => [{ providerId: "openai-codex", type: "oauth" as const }];
  const first = await createSessionModelRuntime(async (provider) => provider === "openai-codex" ? credential("one") : undefined, list);
  const second = await createSessionModelRuntime(async (provider) => provider === "openai-codex" ? credential("two") : undefined, list);
  const [a, b] = await Promise.all([first.getAuth("openai-codex"), second.getAuth("openai-codex")]);
  assert.equal(a?.auth.apiKey, "fixture-one"); assert.equal(b?.auth.apiKey, "fixture-two");
});

test("a profile session runtime offers models from the node's refreshed catalog, not only built-in ones", async () => {
  const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
  const builtIn = await createSessionModelRuntime(async () => undefined, async () => []);
  const template = builtIn.getModels("openai-codex")[0];
  const store = path.join(getAgentDir(), "models-store.json");
  await mkdir(path.dirname(store), { recursive: true });
  await writeFile(store, JSON.stringify({ "openai-codex": { models: [{ ...template, id: "fixture-catalog-only", name: "Catalog only" }], checkedAt: Date.now(), lastModified: Date.now(), etag: 'W/"fixture"' } }));
  try {
    const session = await createSessionModelRuntime(async () => undefined, async () => []);
    assert.equal(session.getModel("openai-codex", "fixture-catalog-only")?.name, "Catalog only");
  } finally { await rm(store, { force: true }); }
});

test("Claude profile contexts remain independent during overlapping turns", async () => {
  const { addProject } = await import("../src/store.js");
  const { setResourceOwner } = await import("../src/ownership.js");
  const { withClaudeProfile, selectedClaudeConfigPath, profileBusy } = await import("../src/provider-profiles/execution.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "profile-context-"));
  try {
    const project = await addProject("Profile context", root);
    setResourceOwner("project", project.id, "context-owner");
    const one = createProviderProfile("context-owner", { label: "One", provider: "claude" });
    const two = createProviderProfile("context-owner", { label: "Two", provider: "claude" });
    for (const [conversation, profile] of [["c1", one], ["c2", two]] as const) setProviderProfileSelection("context-owner", { provider: "claude", scope: "conversation", scopeId: JSON.stringify([project.id, conversation]), profileId: profile.id });
    for (const profile of [one, two]) {
      await mkdir(path.dirname(openAIAuthPath(profile)), { recursive: true, mode: 0o700 });
      await writeFile(openAIAuthPath(profile), JSON.stringify({ anthropic: { type: "oauth", access: `fixture-${profile.id}`, refresh: "fixture-refresh", expires: Date.now() + 3_600_000 } }), { mode: 0o600 });
    }
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    let firstDirectory: string;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { runAsAccount } = await import("../src/account-context.js");
    const actor = { accountId: "context-owner", username: "fixture", role: "member" as const, isRemoteLogin: false, homeNodeId: null };
    const a = runAsAccount(actor, () => withClaudeProfile(project.id, "c1", async () => {
      firstDirectory = selectedClaudeConfigPath()!;
      assert.equal(profileBusy(one.id), true); assert.notEqual(firstDirectory, profileDirectory(one));
      entered();
      await gate; assert.equal(selectedClaudeConfigPath(), firstDirectory);
    }));
    await ready;
    await runAsAccount(actor, () => withClaudeProfile(project.id, "c2", async () => { assert.notEqual(selectedClaudeConfigPath(), firstDirectory); release(); }));
    await a;
    assert.equal(selectedClaudeConfigPath(), undefined); assert.equal(profileBusy(one.id), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
