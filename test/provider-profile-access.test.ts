import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAsAccount } from "../src/account-context.js";
import { addProject } from "../src/store.js";
import { setResourceOwner } from "../src/ownership.js";
import { createProviderProfile, setProviderProfileSelection, setProviderProfileShared } from "../src/provider-profiles/store.js";
import { projectProviderProfile } from "../src/provider-profiles/service.js";
import { withAutomationProfile } from "../src/provider-profiles/context.js";

const actor = (accountId: string) => ({ accountId, username: accountId, role: "member" as const, isRemoteLogin: false, homeNodeId: null });
test("same project resolves the acting user's selection, never its owner's profile", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "user-profile-access-"));
  try {
    const project = await addProject("User profiles", root);
    setResourceOwner("project", project.id, "project-owner");
    const owner = createProviderProfile("project-owner", { label: "Owner", provider: "claude" });
    const visitor = createProviderProfile("visitor", { label: "Visitor", provider: "claude" });
    for (const profile of [owner, visitor]) setProviderProfileSelection(profile.owner, { provider: "claude", scope: "project", scopeId: project.id, profileId: profile.id });
    assert.equal((await runAsAccount(actor("project-owner"), () => projectProviderProfile(project.id, "c", "claude")))?.id, owner.id);
    assert.equal((await runAsAccount(actor("visitor"), () => projectProviderProfile(project.id, "c", "claude")))?.id, visitor.id);
    await assert.rejects(runAsAccount(actor("unassigned"), () => projectProviderProfile(project.id, "c", "claude")), /Select your own subscription profile/);
    assert.equal(await projectProviderProfile(project.id, "c", "claude"), undefined);
    const shared = createProviderProfile("team", { label: "Automation only", provider: "claude" });
    setProviderProfileShared(shared.owner, shared.id, true);
    assert.equal((await withAutomationProfile({ accountId: "visitor", profileId: shared.id }, () => projectProviderProfile(project.id, "c", "claude")))?.id, shared.id);
    assert.equal((await withAutomationProfile({ accountId: "visitor", profileId: null }, () => projectProviderProfile(project.id, "c", "claude")))?.id, visitor.id);
    await assert.rejects(withAutomationProfile({ accountId: "visitor", profileId: shared.id }, () => projectProviderProfile(project.id, "c", "openai-codex")), /does not match/);
    setProviderProfileShared(shared.owner, shared.id, false);
    await assert.rejects(withAutomationProfile({ accountId: "visitor", profileId: shared.id }, () => projectProviderProfile(project.id, "c", "claude")), /access revoked/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
