import assert from "node:assert/strict";
import { test } from "node:test";
import { settingsDatabase } from "../src/settings-store.js";
import { createProviderProfile, listProviderProfiles, deleteProviderProfile, setProviderProfileSelection, resolveProviderProfile, providerProfile } from "../src/provider-profiles/store.js";
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
