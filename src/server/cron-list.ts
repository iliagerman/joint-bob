import { getClusterNode } from "../cluster.js";
import { cronStore, type CronTask } from "../cron.js";
import { peerSnapshot, staleSnapshotReason } from "./peer-snapshots.js";
import { listRuntimePeers, runtimeFetch } from "./runtime-peers.js";

/** Share the same owner snapshots between history, review lists, and the task editor. */
export async function listProjectCronTasks(projectId: string) {
  const local = await getClusterNode();
  const nodes = [local, ...await listRuntimePeers(projectId)];
  const results = await Promise.all(nodes.map(async (node) => {
    try {
      if (node.id === local.id) return { nodeId: node.id, tasks: cronStore().list(projectId) };
      const remote = await peerSnapshot(`cron:${projectId}`, node.id, async () => {
        const reply = await runtimeFetch(`${node.url}/api/cluster/cron`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "list", projectId }), signal: AbortSignal.timeout(3000),
        });
        if (!reply.ok) throw new Error(`Scheduled task owner returned ${reply.status}`);
        return await reply.json() as { tasks: CronTask[] };
      });
      return { nodeId: node.id, ...remote.value, ...(remote.fresh ? {} : { error: staleSnapshotReason(remote.fetchedAt) }) };
    } catch (error) {
      return { nodeId: node.id, tasks: [] as CronTask[], error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return { tasks: results.flatMap((result) => result.tasks), errors: results.filter((result) => "error" in result) };
}
