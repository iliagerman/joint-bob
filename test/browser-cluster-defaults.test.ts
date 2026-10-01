import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyBrowserConfiguration, readBrowserConfiguration } from "../src/browser-configuration.js";
import { getClusterNode } from "../src/cluster.js";
import { addSharingMember, createSharingCluster, getSharingCluster, registerOwnedResource, setResourceShares, setTrustedTwin } from "../src/cluster-sharing-policy.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { acceptBrowserClusterDefault, acceptBrowserConfiguration, browserDefault, closeBrowserRuntime, localBrowserStatus } from "../src/server/browser.js";
import { addProject } from "../src/store.js";

const at = (minute: number) => new Date(Date.UTC(2026, 9, 1, 8, minute)).toISOString();

test("browser defaults follow each project's cluster and never take another member's machine choice", async () => {
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

    // Earlier releases copied whichever peer changed its default last.
    applyBrowserConfiguration({ executorNodeId: member, originNodeId: member, updatedAt: at(0) });
    assert.deepEqual(await browserDefault(shared.id), { nodeId: null, source: null }, "another member's choice is dropped on upgrade");
    assert.equal(readBrowserConfiguration().executorNodeId, null);

    await acceptBrowserConfiguration(member, { executorNodeId: member, originNodeId: member, updatedAt: at(1) });
    await acceptBrowserConfiguration(twin, { executorNodeId: member, originNodeId: member, updatedAt: at(2) });
    assert.equal(readBrowserConfiguration().executorNodeId, null, "neither a member nor a twin relaying it may set this machine's choice");

    assert.equal(await acceptBrowserClusterDefault(member, { clusterId: work, executorNodeId: member, originNodeId: member, updatedAt: at(3) }), true);
    assert.equal(await acceptBrowserClusterDefault(outsider, { clusterId: work, executorNodeId: outsider, originNodeId: outsider, updatedAt: at(4) }), false);
    assert.equal(await acceptBrowserClusterDefault(member, { clusterId: home, executorNodeId: member, originNodeId: member, updatedAt: at(4) }), false, "a member speaks only for its own clusters");
    assert.equal(await acceptBrowserClusterDefault(twin, { clusterId: home, executorNodeId: outsider, originNodeId: twin, updatedAt: at(4) }), false, "the suggestion must be one of the cluster's machines");
    assert.deepEqual(await browserDefault(shared.id), { nodeId: member, source: "cluster", clusterId: work });
    assert.deepEqual(await browserDefault(unshared.id), { nodeId: null, source: null }, "a project in no cluster takes nothing from one");

    applyBrowserConfiguration({ executorNodeId: twin, originNodeId: local, updatedAt: at(5) });
    await acceptBrowserClusterDefault(member, { clusterId: work, executorNodeId: local, originNodeId: member, updatedAt: at(6) });
    await acceptBrowserConfiguration(member, { executorNodeId: member, originNodeId: member, updatedAt: at(7) });
    assert.deepEqual(await browserDefault(shared.id), { nodeId: twin, source: "machine" }, "this machine's choice stays until its user switches back");
    assert.deepEqual(await browserDefault(unshared.id), { nodeId: twin, source: "machine" });

    applyBrowserConfiguration({ executorNodeId: null, originNodeId: local, updatedAt: at(8) });
    assert.deepEqual(await browserDefault(shared.id), { nodeId: local, source: "cluster", clusterId: work }, "switching back follows the cluster's latest suggestion");

    await acceptBrowserConfiguration(twin, { executorNodeId: local, originNodeId: twin, updatedAt: at(9) });
    assert.equal(readBrowserConfiguration().executorNodeId, local, "a twin shares its user's own choice");

    const toMember = await localBrowserStatus(member), toTwin = await localBrowserStatus(twin);
    assert.equal(toMember.config.executorNodeId, null, "a non-twin never receives this machine's choice");
    assert.deepEqual(toMember.clusterDefaults.map(entry => entry.clusterId), [work]);
    assert.equal(toTwin.config.executorNodeId, local);
    assert.deepEqual(toTwin.clusterDefaults, [], "suggestions go only to members of their cluster");
  } finally { await closeBrowserRuntime(); }
});
