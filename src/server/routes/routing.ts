import { z } from "zod";
import { listDifficultyClassifiers } from "../../classifiers/registry.js";
import { getClusterNode, listClusterPeers } from "../../cluster.js";
import { getHarness, getHarnessRuntime, listHarnesses } from "../../harnesses.js";
import { getSharingCluster, listSharingMemberships } from "../../cluster-sharing-policy.js";
import { automaticRoutingModelAllowed, LEGACY_CLUSTER_ID, defaultRoutingPolicy, listRoutingPolicies, readRoutingPolicy, RoutingPolicyError, routingPolicyDatabase, updateClusterRoutingPolicy, validateRoutingPolicy } from "../../routing-policy.js";
import { selectiveSharingActive } from "../../cluster-v2-mode.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";

const uuid = z.string().uuid();
const policyPutSchema = z.object({ clusterId: z.string(), policy: z.object({}).passthrough() }).strict();

function localAuth(response: { locals: { authSession?: unknown } }): void {
  if (!response.locals.authSession) throw new RoutingPolicyError(401, "Unauthorized");
}

/** A node may edit the policy when it leads: the v2 cluster manager, or the legacy
    policy's first author. With no legacy policy yet, any paired node may claim it. */
function editableByLocal(db: Awaited<ReturnType<typeof routingPolicyDatabase>>, clusterId: string, localNodeId: string): boolean {
  if (clusterId !== LEGACY_CLUSTER_ID) {
    const row = db.prepare("SELECT manager_node_id FROM sharing_clusters WHERE id = ?").get(clusterId) as { manager_node_id: string | null } | undefined;
    return row?.manager_node_id === localNodeId;
  }
  const stored = readRoutingPolicy(db, clusterId);
  return stored ? stored.leaderNodeId === localNodeId : true;
}

async function routingModels(): Promise<Array<{ id: string; label: string; thinkingLevels: string[]; fixedProvider?: string; models: Array<{ provider: string; id: string; label: string; providerLabel?: string }> }>> {
  const groups = [];
  for (const adapter of listHarnesses()) {
    if (!adapter.runtime || !adapter.configuration) continue;
    let models: Array<{ provider: string; id: string; label: string; providerLabel?: string }> = [];
    try { models = (await (await getHarnessRuntime(adapter.id)).models()).filter((model) => automaticRoutingModelAllowed(model.provider, model.id)).map((model) => ({ provider: model.provider, id: model.id, label: model.label, ...(model.providerLabel ? { providerLabel: model.providerLabel } : {}) })); }
    catch { /* A node without that runtime ready still shows the policy, just without its model list. */ }
    groups.push({ id: adapter.id, label: adapter.label, thinkingLevels: adapter.configuration.thinkingLevels as string[], ...(adapter.configuration.fixedProvider ? { fixedProvider: adapter.configuration.fixedProvider } : {}), models });
  }
  return groups;
}

async function peerNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const local = await getClusterNode();
    names.set(local.id, local.name);
    for (const peer of await listClusterPeers()) names.set(peer.id, peer.name);
  } catch { /* Names are display-only. */ }
  return names;
}

app.get("/api/cluster/routing", async (_request, response, next) => {
  try {
    localAuth(response);
    const local = await getClusterNode();
    const db = routingPolicyDatabase();
    const v2 = await selectiveSharingActive();
    const names = await peerNames();
    const clusterChoices: Array<{ clusterId: string; name: string }> = v2
      ? listSharingMemberships(db, local.id).map((membership) => { try { return { clusterId: membership.clusterId, name: getSharingCluster(db, membership.clusterId).name }; } catch { return null; } }).filter((choice): choice is { clusterId: string; name: string } => choice !== null)
      : [{ clusterId: LEGACY_CLUSTER_ID, name: "Cluster" }];
    const policies = listRoutingPolicies(db).map((stored) => ({
      ...stored,
      leaderName: names.get(stored.leaderNodeId) ?? stored.leaderNodeId,
      editable: editableByLocal(db, stored.clusterId, local.id),
    }));
    const legacyEditable = editableByLocal(db, LEGACY_CLUSTER_ID, local.id);
    const harnesses = await routingModels();
    response.json({
      routingLevels: 10,
      v2,
      clusters: clusterChoices,
      policies,
      defaultPolicy: defaultRoutingPolicy(Object.fromEntries(harnesses.map((harness) => [harness.id, harness.models.map(({ provider, id, label }) => ({ provider, id, label }))]))),
      classifiers: listDifficultyClassifiers().map(({ id, label, variableName }) => ({ id, label, variableName })),
      harnesses,
      canCreate: clusterChoices.filter((choice) => !readRoutingPolicy(db, choice.clusterId) && editableByLocal(db, choice.clusterId, local.id)).map((choice) => choice.clusterId),
      legacyLeaderName: policies.find((policy) => policy.clusterId === LEGACY_CLUSTER_ID)?.leaderName ?? null,
      legacyEditable,
    });
  } catch (error) {
    if (error instanceof RoutingPolicyError) { sendError(response, error.statusCode, error.message); return; }
    next(error);
  }
});

app.put("/api/cluster/routing", async (request, response, next) => {
  try {
    localAuth(response);
    const input = policyPutSchema.parse(request.body);
    const clusterId = input.clusterId === LEGACY_CLUSTER_ID ? LEGACY_CLUSTER_ID : uuid.parse(input.clusterId);
    const local = await getClusterNode();
    const db = routingPolicyDatabase();
    const stored = updateClusterRoutingPolicy(db, clusterId, validateRoutingPolicy(input.policy), local.id);
    response.json({ policy: stored });
  } catch (error) {
    if (error instanceof RoutingPolicyError) { sendError(response, error.statusCode, error.message); return; }
    if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")); return; }
    next(error);
  }
});

app.delete("/api/cluster/routing", async (request, response, next) => {
  try {
    localAuth(response);
    const raw = typeof request.query.clusterId === "string" ? request.query.clusterId : LEGACY_CLUSTER_ID;
    const clusterId = raw === LEGACY_CLUSTER_ID ? LEGACY_CLUSTER_ID : uuid.parse(raw);
    const local = await getClusterNode();
    updateClusterRoutingPolicy(routingPolicyDatabase(), clusterId, null, local.id);
    response.json({ policy: null });
  } catch (error) {
    if (error instanceof RoutingPolicyError) { sendError(response, error.statusCode, error.message); return; }
    if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")); return; }
    next(error);
  }
});
