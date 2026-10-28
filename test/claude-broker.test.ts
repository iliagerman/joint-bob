import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, stat, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createProviderProfile } from "../src/provider-profiles/store.js";
import { claudeProfileAccessToken, logoutProfile, openAIAuthPath, profileLoginState, profileModelRuntime } from "../src/provider-profiles/service.js";
import { prepareClaudeExecution, prepareClaudeProfile, profileDirectory } from "../src/provider-profiles/claude.js";

const credential = (access = "synthetic-access", refresh = "synthetic-refresh") => ({ type: "oauth", access, refresh, expires: Date.now() + 3_600_000 });
async function canonical(profile: ReturnType<typeof createProviderProfile>, value: object) {
  await mkdir(path.dirname(openAIAuthPath(profile)), { recursive: true, mode: 0o700 });
  await writeFile(openAIAuthPath(profile), JSON.stringify(value), { mode: 0o600 });
}
async function legacy(profile: ReturnType<typeof createProviderProfile>) {
  await mkdir(profileDirectory(profile), { recursive: true, mode: 0o700 });
  await writeFile(path.join(profileDirectory(profile), ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "legacy-access", refreshToken: "legacy-refresh", expiresAt: Date.now() + 3_600_000 } }), { mode: 0o600 });
}
test("Claude migration is serialized, canonical tokens win, and logout prevents reseeding", async () => {
  const profile = createProviderProfile("broker-owner", { label: "Migration", provider: "claude" });
  await legacy(profile);
  const states = await Promise.all(Array.from({ length: 4 }, () => profileLoginState(profile)));
  assert.ok(states.every(state => state.signedIn));
  assert.equal(JSON.parse(await readFile(openAIAuthPath(profile), "utf8")).anthropic.refresh, "legacy-refresh");
  assert.equal((await stat(openAIAuthPath(profile))).mode & 0o777, 0o600);
  await assert.rejects(stat(path.join(profileDirectory(profile), ".credentials.json")), { code: "ENOENT" });
  await canonical(profile, { anthropic: credential("rotated-access", "rotated-refresh") });
  await legacy(profile);
  assert.equal(await claudeProfileAccessToken(profile), "rotated-access");
  assert.equal(JSON.parse(await readFile(openAIAuthPath(profile), "utf8")).anthropic.refresh, "rotated-refresh");
  await logoutProfile(profile);
  await legacy(profile);
  await assert.rejects(claudeProfileAccessToken(profile), /No other account was used/);
  await assert.rejects(stat(path.join(profileDirectory(profile), ".credentials.json")), { code: "ENOENT" });
});

test("Claude concurrent refresh rotates exactly once, exposing only access", async () => {
  const profile = createProviderProfile("broker-refresh", { label: "Refresh", provider: "claude" });
  await canonical(profile, { anthropic: { ...credential(), expires: 1 } });
  const runtime = await profileModelRuntime(profile), provider = runtime.getProvider("anthropic")!;
  let refreshes = 0;
  runtime.registerNativeProvider({ ...provider, auth: { ...provider.auth, oauth: { ...provider.auth!.oauth!, refresh: async value => {
    refreshes++;
    assert.equal(value.refresh, "synthetic-refresh");
    return { ...value, ...credential("fresh-access", "fresh-refresh"), type: "oauth" as const };
  } } } });
  assert.deepEqual(await Promise.all(Array.from({ length: 6 }, () => claudeProfileAccessToken(profile))), Array(6).fill("fresh-access"));
  assert.equal(refreshes, 1);
});

test("revoked Claude refresh fails closed without leaking provider errors", async () => {
  const profile = createProviderProfile("broker-revoked", { label: "Revoked", provider: "claude" });
  await canonical(profile, { anthropic: { ...credential(), expires: 1 } });
  const runtime = await profileModelRuntime(profile), provider = runtime.getProvider("anthropic")!;
  runtime.registerNativeProvider({ ...provider, auth: { ...provider.auth, oauth: { ...provider.auth!.oauth!, refresh: async () => { throw new Error("private-refresh-response"); } } } });
  await assert.rejects(claudeProfileAccessToken(profile), (error: Error) => {
    assert.match(error.message, /No other account was used/);
    assert.doesNotMatch(error.message, /private-refresh-response/);
    return true;
  });
});

test("foreign runtime receives access only and keeps tools and config in its own runtime", async () => {
  const { runAsAccount } = await import("../src/account-context.js");
  const { runInRuntime, currentRuntime } = await import("../src/account-runtime.js");
  const { withClaudeProfile, selectedClaudeEnvironment, selectedClaudeConfigPath } = await import("../src/provider-profiles/execution.js");
  const { setProviderProfileSelection } = await import("../src/provider-profiles/store.js");
  const { addProject } = await import("../src/store.js");
  const root = await mkdtemp(path.join(os.tmpdir(), "broker-foreign-"));
  const overrides = { JOINT_BOB_USERCTL: path.resolve("test/fixtures/fake-userctl.sh"), JOINT_BOB_USERCTL_SUDO: "0", JOINT_BOB_ACCOUNT_HOME_ROOT: root };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    const profile = createProviderProfile("broker-foreign-owner", { label: "Foreign", provider: "claude" });
    await canonical(profile, { anthropic: credential("only-selected-access", "service-only-refresh") });
    await prepareClaudeProfile(profile);
    const project = await addProject("Foreign broker", root);
    setProviderProfileSelection(profile.owner, { provider: "claude", scope: "project", scopeId: project.id, profileId: profile.id });
    const runtime = { key: "foreign-project", name: "executor", home: path.join(root, "jb-executor") };
    await runAsAccount({ accountId: profile.owner, username: "fixture", role: "member", isRemoteLogin: false, homeNodeId: null }, () => runInRuntime(runtime, () => withClaudeProfile(project.id, undefined, async () => {
      assert.deepEqual(currentRuntime(), runtime);
      const directory = selectedClaudeConfigPath()!;
      assert.ok(directory.startsWith(runtime.home + path.sep));
      const env = selectedClaudeEnvironment({ ANTHROPIC_API_KEY: "ambient", CLAUDE_CODE_OAUTH_TOKEN: "ambient" });
      assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, "only-selected-access");
      assert.equal(env.ANTHROPIC_API_KEY, undefined);
      assert.doesNotMatch(JSON.stringify(env), /service-only-refresh/);
      assert.doesNotMatch(await readFile(path.join(directory, ".claude.json"), "utf8"), /service-only-refresh|only-selected-access/);
      await assert.rejects(stat(path.join(directory, ".credentials.json")), { code: "ENOENT" });
      assert.throws(() => runInRuntime({ ...runtime, name: "third" }, selectedClaudeConfigPath), /runtime changed/);
    })));
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(root, { recursive: true, force: true });
  }
});

test("execution skeleton contains identity and transcript link but no credentials", async () => {
  const profile = createProviderProfile("broker-config", { label: "Config", provider: "claude" });
  await prepareClaudeProfile(profile, { accountUuid: "id", emailAddress: "test@example.invalid", organizationUuid: "org" });
  const execution = await prepareClaudeExecution(profile);
  try {
    assert.notEqual(execution.directory, profileDirectory(profile));
    const text = await readFile(path.join(execution.directory, ".claude.json"), "utf8");
    assert.match(text, /test@example.invalid/);
    assert.doesNotMatch(text, /never-copy|refreshToken|accessToken/);
    assert.equal((await stat(execution.directory)).mode & 0o777, 0o700);
    await assert.rejects(stat(path.join(execution.directory, ".credentials.json")), { code: "ENOENT" });
    await assert.rejects(stat(path.join(profileDirectory(profile), ".credentials.json")), { code: "ENOENT" });
  } finally { await execution.dispose(); }
});
