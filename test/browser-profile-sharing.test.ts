import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { addSharingMember, createSharingCluster, getSharingCluster, setTrustedTwin } from "../src/cluster-sharing-policy.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { browserRuntime, closeBrowserRuntime, localBrowserOperation } from "../src/server/browser.js";
import { addProject } from "../src/store.js";

type Listed = { profiles: Array<{ id: string; state?: string; canManage?: boolean; grants?: Array<{ scope: string }>; holder?: unknown }> };

test("a conversation in a project only its own machine has opens profiles shared with its cluster, and nothing else", async () => {
  try {
    const db = await clusterV2Database(), local = (await getClusterNode()).id;
    const twin = randomUUID(), member = randomUUID(), outsider = randomUUID(), home = randomUUID();
    createSharingCluster(db, { id: home, name: "Home" }, local);
    addSharingMember(db, home, local, twin, getSharingCluster(db, home).managerEpoch);
    addSharingMember(db, home, local, member, getSharingCluster(db, home).managerEpoch);
    setTrustedTwin(db, local, twin, true);
    const folder = path.join(os.homedir(), randomUUID());
    await mkdir(folder, { recursive: true });
    const project = await addProject("Mail", folder, { writeInstructions: false });
    const runtime = browserRuntime();
    const store = (runtime as unknown as { store: { createProfile(projectId: string, label: string): { id: string }; grantProfileAccess(id: string, grant: object, origin?: string): void } }).store;
    const mail = store.createProfile(project.id, "Gmail");
    store.grantProfileAccess(mail.id, { scope: "conversation", projectId: project.id, conversationId: randomUUID() }, local);
    const bank = store.createProfile(project.id, "Bank");
    store.grantProfileAccess(bank.id, { scope: "conversation", projectId: project.id, conversationId: randomUUID() }, local);

    // The caller's project lives only on the caller: this machine has never heard of it.
    const callerProject = randomUUID(), conversationId = randomUUID();
    const profiles = async (nodeId: string) => (await localBrowserOperation({ operation: "profiles", args: { projectId: callerProject, conversationId } }, { kind: "agent" }, nodeId) as Listed).profiles.map(profile => profile.id);
    assert.deepEqual(await profiles(twin), [], "an unshared profile stays with the conversation that created it");

    store.grantProfileAccess(mail.id, { scope: "cluster", clusterId: home });
    assert.deepEqual(await profiles(twin), [mail.id], "a cluster share reaches a member's conversation in a project only that member has");
    assert.deepEqual(await profiles(member), [mail.id]);
    assert.deepEqual(await profiles(outsider), [], "machines outside the cluster get nothing");

    // Settings: other machines see only profiles that reach them; only twins manage them.
    const directory = async (nodeId: string) => await localBrowserOperation({ operation: "directory", args: { projectIds: [callerProject] } }, { kind: "human", id: "person" }, nodeId) as Listed;
    const seenByTwin = await directory(twin);
    assert.deepEqual(seenByTwin.profiles.map(profile => profile.id), [mail.id], "the unshared bank login is invisible to the twin");
    assert.equal(seenByTwin.profiles[0].canManage, true);
    const seenByMember = await directory(member);
    assert.deepEqual(seenByMember.profiles.map(profile => profile.id), [mail.id]);
    assert.equal(seenByMember.profiles[0].canManage, false, "another member's machine gets a read-only row");
    assert.deepEqual(seenByMember.profiles[0].grants?.map(grant => grant.scope), ["cluster"], "and only the shares that reach it");
    assert.deepEqual((await directory(outsider)).profiles, []);
    assert.deepEqual(((await localBrowserOperation({ operation: "directory", args: { projectIds: [] } }, { kind: "human", id: "person" })) as Listed).profiles.map(profile => profile.id).sort(), [mail.id, bank.id].sort(), "this machine lists all of its own profiles");

    const manage = (nodeId: string, id: string, change: object) => localBrowserOperation({ operation: "manageProfile", args: { id, change } } as never, { kind: "human", id: "person" }, nodeId);
    await assert.rejects(manage(member, mail.id, { label: "Taken" }), /machine and its twins/);
    await assert.rejects(manage(twin, bank.id, { label: "Taken" }), /machine and its twins/, "a twin cannot manage what was never shared with it");
    await manage(twin, mail.id, { label: "Family Gmail" });
    await assert.rejects(localBrowserOperation({ operation: "manageProfile", args: { id: mail.id, change: { label: "Agent" } } }, { kind: "agent" }), /Agents cannot manage/);

    await manage(twin, mail.id, { revoke: { scope: "cluster", clusterId: home } });
    assert.deepEqual(await profiles(member), [], "removing the share takes effect at once");
  } finally { await closeBrowserRuntime(); }
});
