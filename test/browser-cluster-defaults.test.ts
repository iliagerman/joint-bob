import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyBrowserConfiguration, readBrowserConfiguration, setBrowserClusterOverride } from "../src/browser-configuration.js";
import { getClusterNode } from "../src/cluster.js";
import { addSharingMember, createSharingCluster, getSharingCluster, registerOwnedResource, setResourceShares, setTrustedTwin } from "../src/cluster-sharing-policy.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { acceptBrowserClusterDefault, browserDefault, closeBrowserRuntime, configureClusterBrowserOverride, localBrowserStatus } from "../src/server/browser.js";
import { addProject } from "../src/store.js";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 8, minute)).toISOString();

test("a cluster's default wins over this machine's default, and only this machine can replace it here", async () => {
  try {
    const db = await clusterV2Database(), local = (await getClusterNode()).id;
    const twin = randomUUID(), member = randomUUID(), outsider = randomUUID();
    const work = randomUUID(), home = randomUUID();
    createSharingCluster(db, { id: work, name: "Work" }, local);
    addSharingMember(db, work, local, member, getSharingCluster(db, work).managerEpoch);
    createSharingCluster(db, { id: home, name: "Home" }, local);
    addSharingMember(db, home, local, twin, getSharingCluster(db, home).managerEpoch);
    setTrustedTwin(db, local, twin, true);
    const project = async (name: string) => {
      const folder = path.join(os.homedir(), name);
      await mkdir(folder, { recursive: true });
      const created = await addProject(name, folder, { writeInstructions: false });
      registerOwnedResource(db, { kind: "project", id: created.id, ownerNodeId: local }, local);
      return created;
    };
    const shared = await project("Cluster project"), unshared = await project("Private project");
    setResourceShares(db, local, "project", shared.id, [{ clusterId: work, projectId: null }]);

    // Earlier releases copied defaults chosen on other machines, twins included.
    applyBrowserConfiguration({ executorNodeId: member, originNodeId: twin, updatedAt: at(0) });
    assert.deepEqual(await browserDefault(shared.id), { nodeId: null, source: null }, "a default chosen elsewhere is dropped on upgrade");
    assert.equal(readBrowserConfiguration().executorNodeId, null);

    assert.equal(await acceptBrowserClusterDefault(member, { clusterId: work, executorNodeId: member, originNodeId: member, updatedAt: at(3) }), true);
    assert.equal(await acceptBrowserClusterDefault(outsider, { clusterId: work, executorNodeId: outsider, originNodeId: outsider, updatedAt: at(4) }), false);
    assert.equal(await acceptBrowserClusterDefault(member, { clusterId: home, executorNodeId: member, originNodeId: member, updatedAt: at(4) }), false, "a member speaks only for its own clusters");
    assert.equal(await acceptBrowserClusterDefault(twin, { clusterId: home, executorNodeId: outsider, originNodeId: twin, updatedAt: at(4) }), false, "the suggestion must be one of the cluster's machines");
    assert.deepEqual(await browserDefault(shared.id), { nodeId: member, source: "cluster", clusterId: work });
    assert.deepEqual(await browserDefault(unshared.id), { nodeId: null, source: null }, "a project in no cluster takes nothing from one");

    applyBrowserConfiguration({ executorNodeId: twin, originNodeId: local, updatedAt: at(5) });
    assert.deepEqual(await browserDefault(shared.id), { nodeId: member, source: "cluster", clusterId: work }, "this machine's default does not replace the cluster's");
    assert.deepEqual(await browserDefault(unshared.id), { nodeId: twin, source: "machine" }, "projects in no cluster use this machine's default");
    await acceptBrowserClusterDefault(member, { clusterId: work, executorNodeId: null, originNodeId: member, updatedAt: at(6) });
    assert.deepEqual(await browserDefault(shared.id), { nodeId: twin, source: "machine" }, "a cluster without a browser machine falls back to this machine's default");

    await acceptBrowserClusterDefault(member, { clusterId: work, executorNodeId: member, originNodeId: member, updatedAt: at(7) });
    setBrowserClusterOverride(work, local);
    assert.deepEqual(await browserDefault(shared.id), { nodeId: local, source: "override", clusterId: work });
    await acceptBrowserClusterDefault(member, { clusterId: work, executorNodeId: null, originNodeId: member, updatedAt: at(8) });
    await acceptBrowserClusterDefault(member, { clusterId: work, executorNodeId: member, originNodeId: member, updatedAt: at(9) });
    assert.deepEqual(await browserDefault(shared.id), { nodeId: local, source: "override", clusterId: work }, "cluster changes never overwrite this machine's choice");
    assert.deepEqual(await browserDefault(unshared.id), { nodeId: twin, source: "machine" }, "a cluster choice applies only to that cluster's projects");
    setBrowserClusterOverride(work, null);
    assert.deepEqual(await browserDefault(shared.id), { nodeId: member, source: "cluster", clusterId: work }, "switching back follows the cluster's latest default");

    await assert.rejects(configureClusterBrowserOverride(work, outsider), /not a member of this cluster/);
    await assert.rejects(configureClusterBrowserOverride(randomUUID(), local), /not a member of that cluster/);

    setBrowserClusterOverride(work, local);
    const toMember = await localBrowserStatus(member), toTwin = await localBrowserStatus(twin);
    assert.equal(toTwin.config.executorNodeId, null, "this machine's default never leaves it, even to a twin");
    assert.equal(toMember.config.executorNodeId, null);
    assert.deepEqual(toMember.clusterDefaults.map(entry => [entry.clusterId, entry.executorNodeId]), [[work, member]], "members receive the cluster default, never this machine's choice");
    assert.deepEqual(toTwin.clusterDefaults, [], "defaults go only to members of their cluster");
  } finally { await closeBrowserRuntime(); }
});
