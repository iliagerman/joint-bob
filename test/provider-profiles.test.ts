import assert from "node:assert/strict";
import { test } from "node:test";
import { settingsDatabase } from "../src/settings-store.js";
import { createProviderProfile, listProviderProfiles, deleteProviderProfile, setProviderProfileSelection, resolveProviderProfile, providerProfile, profileSelectionSchema } from "../src/provider-profiles/store.js";
import { getClusterNode } from "../src/cluster.js";

// Profile writes are stamped with this node's identity for twin sync.
await getClusterNode();

test("profile selection inherits conversation > project > workspace > default without crossing users or providers", () => {
  const defaults = createProviderProfile("alice", { label: "Personal", provider: "claude" });
  const work = createProviderProfile("alice", { label: "Work", provider: "claude" });
  const scope = { projectId: "p", workspaceId: "w", conversationId: "c" };
  assert.equal(resolveProviderProfile("alice", "claude", scope), undefined);
  setProviderProfileSelection("alice", { provider: "claude", scope: "default", scopeId: "", profileId: defaults.id });
  assert.equal(resolveProviderProfile("alice", "claude", scope)?.profile.id, defaults.id);
  setProviderProfileSelection("alice", { provider: "claude", scope: "workspace", scopeId: "w", profileId: work.id });
  assert.equal(resolveProviderProfile("alice", "claude", scope)?.source, "workspace");
  setProviderProfileSelection("alice", { provider: "claude", scope: "project", scopeId: "p", profileId: defaults.id });
  assert.equal(resolveProviderProfile("alice", "claude", scope)?.source, "project");
  setProviderProfileSelection("alice", { provider: "claude", scope: "conversation", scopeId: JSON.stringify(["p", "c"]), profileId: work.id });
  assert.equal(resolveProviderProfile("alice", "claude", scope)?.profile.id, work.id);
  assert.equal(resolveProviderProfile("bob", "claude", scope), undefined);
  assert.equal(resolveProviderProfile("alice", "openai-codex", scope), undefined);
  setProviderProfileSelection("alice", { provider: "claude", scope: "conversation", scopeId: JSON.stringify(["p", "c"]), profileId: null });
  assert.equal(resolveProviderProfile("alice", "claude", scope)?.source, "project");
});

test("profiles created in the same millisecond keep insertion order", () => {
  const owner = "ordered-profile-owner", timestamp = "2026-01-01T00:00:00.000Z";
  const rows = [
    ["ffffffff-ffff-4fff-8fff-ffffffffffff", "First"],
    ["00000000-0000-4000-8000-000000000000", "Second"],
    ["88888888-8888-4888-8888-888888888888", "Third"],
  ];
  const insert = settingsDatabase().prepare("INSERT INTO provider_profiles (id,owner,label,provider,created_at) VALUES(?,?,?,?,?)");
  for (const [id, label] of rows) insert.run(id, owner, label, "claude", timestamp);
  assert.deepEqual(listProviderProfiles(owner).map(({ label }) => label), ["First", "Second", "Third"]);
});

test("profiles cannot be read or selected by another user or for another provider", () => {
  const profile = createProviderProfile("owner", { label: "Private", provider: "claude" });
  assert.deepEqual(listProviderProfiles("other"), []);
  assert.throws(() => providerProfile("other", profile.id), /not found/);
  assert.throws(() => setProviderProfileSelection("other", { provider: "claude", scope: "default", scopeId: "", profileId: profile.id }), /not found/);
  assert.throws(() => setProviderProfileSelection("owner", { provider: "openai-codex", scope: "default", scopeId: "", profileId: profile.id }), /provider/);
  assert.throws(() => createProviderProfile("owner", { label: "", provider: "claude" }), /./);
});

test("shared profiles are available node-wide only for automation, including for their owner", async () => {
  const { setProviderProfileShared, accessibleProviderProfile, listAccessibleProviderProfiles } = await import("../src/provider-profiles/store.js");
  const profile = createProviderProfile("sharing-owner", { label: "Automation", provider: "claude" });
  assert.throws(() => accessibleProviderProfile("sharing-other", profile.id, "automation"), /not found|access/);
  assert.throws(() => setProviderProfileShared("sharing-other", profile.id, true), /not found/);
  setProviderProfileShared("sharing-owner", profile.id, true);
  assert.equal(accessibleProviderProfile("sharing-other", profile.id, "automation").id, profile.id);
  assert.equal(listAccessibleProviderProfiles("sharing-other", "automation").some((entry) => entry.id === profile.id), true);
  for (const user of ["sharing-owner", "sharing-other"]) {
    assert.throws(() => accessibleProviderProfile(user, profile.id, "interactive"), /automation|access/);
    assert.equal(listAccessibleProviderProfiles(user, "interactive").some((entry) => entry.id === profile.id), false);
  }
  assert.throws(() => setProviderProfileSelection("sharing-owner", { provider: "claude", scope: "default", scopeId: "", profileId: profile.id }), /automation|access/);
  setProviderProfileShared("sharing-owner", profile.id, false);
  assert.throws(() => accessibleProviderProfile("sharing-other", profile.id, "automation"), /not found|access/);
  assert.equal(accessibleProviderProfile("sharing-owner", profile.id, "interactive").id, profile.id);
});

test("sharing an already selected profile rejects interactive resolution rather than falling back", async () => {
  const { setProviderProfileShared } = await import("../src/provider-profiles/store.js");
  const profile = createProviderProfile("revoked-interactive", { label: "Private", provider: "claude" });
  setProviderProfileSelection(profile.owner, { provider: "claude", scope: "default", scopeId: "", profileId: profile.id });
  setProviderProfileShared(profile.owner, profile.id, true);
  assert.throws(() => resolveProviderProfile(profile.owner, "claude", { projectId: "p", workspaceId: "w" }), /automation|access/);
});

test("deleting a selected profile is refused instead of silently falling back", () => {
  const profile = createProviderProfile("delete-owner", { label: "Selected", provider: "openai-codex" });
  setProviderProfileSelection("delete-owner", { provider: "openai-codex", scope: "default", scopeId: "", profileId: profile.id });
  assert.throws(() => deleteProviderProfile("delete-owner", profile.id), /selection/);
  setProviderProfileSelection("delete-owner", { provider: "openai-codex", scope: "default", scopeId: "", profileId: null });
  deleteProviderProfile("delete-owner", profile.id);
  assert.throws(() => providerProfile("delete-owner", profile.id), /not found/);
});

test("profile selection schema accepts a pool choice without a profile choice", () => {
  const poolId = "00000000-0000-4000-8000-000000000001";
  const parsed = profileSelectionSchema.safeParse({ provider: "claude", scope: "default", scopeId: "", profileId: null, poolId });
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.poolId, poolId);
});

test("with nothing chosen, a provider's only private profile is used, and two or more are never guessed", async () => {
  const { resolveSubscriptionChoice } = await import("../src/provider-profiles/pools.js");
  const { setProviderProfileShared } = await import("../src/provider-profiles/store.js");
  const owner = "only-profile-owner", scope = { projectId: "p", workspaceId: "w" };
  const only = createProviderProfile(owner, { label: "Only", provider: "openai-codex" });
  assert.equal(resolveProviderProfile(owner, "openai-codex", scope)?.profile.id, only.id);
  const choice = resolveSubscriptionChoice(owner, "openai-codex", scope);
  assert.equal(choice?.kind === "profile" && choice.profile.id, only.id);
  // Clearing a default leaves nothing chosen, so the only profile is still the one used.
  setProviderProfileSelection(owner, { provider: "openai-codex", scope: "default", scopeId: "", profileId: only.id });
  setProviderProfileSelection(owner, { provider: "openai-codex", scope: "default", scopeId: "", profileId: null });
  assert.equal(resolveProviderProfile(owner, "openai-codex", scope)?.profile.id, only.id);
  assert.equal(resolveProviderProfile("only-profile-other", "openai-codex", scope), undefined, "never another user's profile");
  assert.equal(resolveProviderProfile(owner, "claude", scope), undefined, "never another provider's profile");
  const second = createProviderProfile(owner, { label: "Second", provider: "openai-codex" });
  assert.equal(resolveProviderProfile(owner, "openai-codex", scope), undefined, "two profiles: the user chooses");
  setProviderProfileShared(owner, second.id, true);
  assert.equal(resolveProviderProfile(owner, "openai-codex", scope)?.profile.id, only.id, "a profile shared for automation does not count");
  createProviderProfile(owner, { label: "Pi", provider: "pi" });
  assert.equal(resolveProviderProfile(owner, "pi", scope), undefined, "a Pi profile is never picked without a choice here");
});
