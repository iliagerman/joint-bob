import { z } from "zod";
import { listDifficultyClassifiers } from "../../classifiers/registry.js";
import { getClusterNode, listClusterPeers } from "../../cluster.js";
import { listSharingClusterMembers, listSharingMemberships } from "../../cluster-sharing-policy.js";
import { getHarnessRuntime, listHarnesses } from "../../harnesses.js";
import { applyRoutingConfigEvents, createRoutingConfig, deleteRoutingConfig, enqueueRoutingConfigDeliveries, getRoutingConfig, listRoutingConfigs, pendingRoutingConfigDeliveryCount, routingConfigDatabase, routingConfigEventFor, routingConfigEventSchema, routingConfigShareTargets, routingConfigWarning, RoutingConfigError, setRoutingConfigSelection, updateRoutingConfig, type RoutingConfigEvent, type StoredRoutingConfig } from "../../routing-configs.js";
import { automaticRoutingModelAllowed, defaultRoutingPolicy, listRoutingPolicies, RoutingPolicyError, routingPolicyDatabase, validateRoutingPolicy } from "../../routing-policy.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { sendError } from "../http-auth.js";
import { flushRoutingConfigDeliveries } from "../maintenance.js";
import { broadcastRoutingMode } from "../harness-chat.js";
import { app } from "../state.js";

const uuid = z.string().uuid();
const configBodySchema = z.object({ name: z.string().trim().min(1).max(80), policy: z.object({}).passthrough() }).strict();
const configUpdateSchema = z.object({ name: z.string().trim().min(1).max(80).optional(), policy: z.object({}).passthrough().optional() }).strict();
const selectionSchema = z.object({ configId: z.string().min(0) }).strict();
const eventBatchSchema = z.object({ events: z.array(routingConfigEventSchema).min(1).max(100) }).strict();

function localAuth(response: { locals: { authSession?: unknown; machineAuth?: unknown } }): void {
  if (!response.locals.authSession && !response.locals.machineAuth) throw new RoutingConfigError(401, "Unauthorized");
}

async function routingModels(): Promise<Array<{ id: string; label: string; thinkingLevels: string[]; fixedProvider?: string; models: Array<{ provider: string; id: string; label: string; providerLabel?: string }> }>> {
  const groups = [];
  for (const adapter of listHarnesses()) {
    if (!adapter.runtime || !adapter.configuration) continue;
    let models: Array<{ provider: string; id: string; label: string; providerLabel?: string }> = [];
    try { models = (await (await getHarnessRuntime(adapter.id)).models()).filter((model) => automaticRoutingModelAllowed(model.provider, model.id)).map((model) => ({ provider: model.provider, id: model.id, label: model.label, ...(model.providerLabel ? { providerLabel: model.providerLabel } : {}) })); }
    catch { /* A node without that runtime ready still shows the configuration, just without its model list. */ }
    groups.push({ id: adapter.id, label: adapter.label, thinkingLevels: adapter.configuration.thinkingLevels as string[], ...(adapter.configuration.fixedProvider ? { fixedProvider: adapter.configuration.fixedProvider } : {}), models });
  }
  return groups;
}

type ConfigView = StoredRoutingConfig & { mine: boolean; ownerLabel?: string; warning: string | null };

function configView(localNodeId: string, config: StoredRoutingConfig, ownerNames: Map<string, string>): ConfigView {
  return {
    ...config,
    mine: config.ownerNodeId === localNodeId,
    ...(ownerNames.has(config.ownerNodeId) ? { ownerLabel: ownerNames.get(config.ownerNodeId) } : {}),
    warning: routingConfigWarning(config),
  };
}

/** Display names for configuration owners: this node, legacy peers, and known cluster members. */
async function ownerNames(local: { id: string; name: string }): Promise<Map<string, string>> {
  const names = new Map<string, string>([[local.id, local.name]]);
  try {
    for (const peer of await listClusterPeers()) names.set(peer.id, peer.name);
  } catch { /* Names are display-only. */ }
  const db = routingPolicyDatabase();
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cluster_v2_membership_nodes'").get()) {
    for (const row of db.prepare("SELECT node_id, name FROM cluster_v2_membership_nodes").all() as unknown as Array<{ node_id: string; name: string }>) names.set(row.node_id, row.name);
  }
  return names;
}

/** Enrols one event for every currently eligible target and tries to deliver at once.
    A concurrent maintenance flush owning the push is reported as pending, not failure. */
async function distribute(event: RoutingConfigEvent): Promise<Array<{ nodeId: string; name: string; delivered: boolean; error?: string }>> {
  const local = await getClusterNode();
  const db = routingConfigDatabase();
  const targets = routingConfigShareTargets(routingPolicyDatabase(), local.id, await listClusterPeers());
  enqueueRoutingConfigDeliveries(db, event, targets);
  const results = await flushRoutingConfigDeliveries(event.configId);
  if (!results.length && targets.length && pendingRoutingConfigDeliveryCount(db, event.configId) > 0) {
    return targets.map((target) => ({ nodeId: target.nodeId, name: target.name, delivered: false, error: "delivery in progress" }));
  }
  return results;
}

app.get("/api/routing-configs", async (_request, response, next) => {
  try {
    localAuth(response);
    const local = await getClusterNode();
    const db = routingConfigDatabase();
    const policies = routingPolicyDatabase();
    const harnesses = await routingModels();
    const names = await ownerNames(local);
    response.json({
      routingLevels: 10,
      configs: listRoutingConfigs(db).map((config) => configView(local.id, config, names)),
      selectedId: (db.prepare("SELECT config_id FROM routing_config_selection WHERE singleton = 1").get() as { config_id: string } | undefined)?.config_id ?? "",
      classifiers: listDifficultyClassifiers().map(({ id, label, variableName }) => ({ id, label, variableName })),
      harnesses,
      defaultPolicy: defaultRoutingPolicy(Object.fromEntries(harnesses.map((harness) => [harness.id, harness.models.map(({ provider, id, label }) => ({ provider, id, label }))]))),
      shareTargets: routingConfigShareTargets(policies, local.id, await listClusterPeers()).map(({ nodeId, name, kind, clusterName }) => ({ nodeId, name, kind, ...(clusterName ? { clusterName } : {}) })),
      // Kept for older callers: the retired per-cluster policies are listed read-only until the migration empties them.
      policies: listRoutingPolicies(policies).map((stored) => ({ ...stored, editable: false, localLeader: false, leaderName: stored.leaderNodeId, warning: null })),
    });
  } catch (error) {
    if (error instanceof RoutingConfigError) { sendError(response, error.statusCode, error.message); return; }
    next(error);
  }
});

app.post("/api/routing-configs", async (request, response, next) => {
  try {
    localAuth(response);
    const input = configBodySchema.parse(request.body);
    const local = await getClusterNode();
    const config = createRoutingConfig(routingConfigDatabase(), local.id, input.name, validateRoutingPolicy(input.policy));
    response.status(201).json({ config: configView(local.id, config, await ownerNames(local)) });
  } catch (error) {
    if (error instanceof RoutingConfigError || error instanceof RoutingPolicyError) { sendError(response, error.statusCode, error.message); return; }
    if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")); return; }
    next(error);
  }
});

// Registered before the :id routes: "selection" is not a UUID, so the order decides which handler runs.
app.put("/api/routing-configs/selection", async (request, response, next) => {
  try {
    localAuth(response);
    const input = selectionSchema.parse(request.body);
    if (input.configId !== "" && !getRoutingConfig(routingConfigDatabase(), input.configId)) throw new RoutingConfigError(404, "Routing configuration not found");
    setRoutingConfigSelection(routingConfigDatabase(), input.configId);
    broadcastRoutingMode();
    response.json({ selectedId: input.configId });
  } catch (error) {
    if (error instanceof RoutingConfigError) { sendError(response, error.statusCode, error.message); return; }
    if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")); return; }
    next(error);
  }
});

app.put("/api/routing-configs/:id", async (request, response, next) => {
  try {
    localAuth(response);
    const id = uuid.parse(request.params.id);
    const input = configUpdateSchema.parse(request.body);
    const local = await getClusterNode();
    const db = routingConfigDatabase();
    const changes = {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.policy === undefined ? {} : { policy: validateRoutingPolicy(input.policy) }),
    };
    const config = updateRoutingConfig(db, local.id, id, changes);
    // A shared configuration re-reaches every eligible node on each owner edit; nodes
    // that are offline keep a pending delivery the maintenance flush retries.
    const results = config.shared ? await distribute(routingConfigEventFor(config)) : [];
    broadcastRoutingMode();
    response.json({ config: configView(local.id, config, await ownerNames(local)), results });
  } catch (error) {
    if (error instanceof RoutingConfigError || error instanceof RoutingPolicyError) { sendError(response, error.statusCode, error.message); return; }
    if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")); return; }
    next(error);
  }
});

app.delete("/api/routing-configs/:id", async (request, response, next) => {
  try {
    localAuth(response);
    const id = uuid.parse(request.params.id);
    const local = await getClusterNode();
    const db = routingConfigDatabase();
    const config = getRoutingConfig(db, id);
    if (!config) throw new RoutingConfigError(404, "Routing configuration not found");
    const event = routingConfigEventFor(config, "delete");
    deleteRoutingConfig(db, local.id, id);
    const results = config.shared ? await distribute(event) : [];
    broadcastRoutingMode();
    response.json({ ok: true, results });
  } catch (error) {
    if (error instanceof RoutingConfigError) { sendError(response, error.statusCode, error.message); return; }
    if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")); return; }
    next(error);
  }
});

app.post("/api/routing-configs/:id/share", async (request, response, next) => {
  try {
    localAuth(response);
    const id = uuid.parse(request.params.id);
    const local = await getClusterNode();
    const db = routingConfigDatabase();
    const config = getRoutingConfig(db, id);
    if (!config) throw new RoutingConfigError(404, "Routing configuration not found");
    if (config.ownerNodeId !== local.id) throw new RoutingConfigError(403, "Only the node that created this configuration can share it");
    // Sharing marks the configuration for automatic re-distribution on later edits; it
    // is not a content change, so the revision the receivers see stays the same.
    db.prepare("UPDATE routing_configs SET shared = 1 WHERE id = ?").run(id);
    const shared = getRoutingConfig(db, id)!;
    const results = await distribute(routingConfigEventFor(shared));
    response.json({ config: configView(local.id, shared, await ownerNames(local)), results });
  } catch (error) {
    if (error instanceof RoutingConfigError) { sendError(response, error.statusCode, error.message); return; }
    if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")); return; }
    next(error);
  }
});

/** Legacy paired peers distribute configurations over the same authenticated
    pairing-token transport secret credential events use. The token proves membership in
    the pairing mesh; each event's owner must be a paired peer, and the events apply as
    that owner — the same trust model secret credential replication uses. */
app.post("/api/cluster/routing-configs/events", async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) throw new RoutingConfigError(401, "Unauthorized");
    const batch = eventBatchSchema.parse(request.body);
    const peers = new Set((await listClusterPeers()).map((peer) => peer.id));
    for (const event of batch.events) {
      if (!peers.has(event.ownerNodeId)) throw new RoutingConfigError(403, "Only a paired node's routing configurations may arrive here");
    }
    const received: string[] = [];
    for (const [owner, events] of batch.events.reduce((groups, event) => { groups.set(event.ownerNodeId, [...(groups.get(event.ownerNodeId) ?? []), event]); return groups; }, new Map<string, typeof batch.events>())) {
      received.push(...applyRoutingConfigEvents(routingConfigDatabase(), events, owner));
    }
    broadcastRoutingMode();
    response.json({ received });
  } catch (error) {
    if (error instanceof RoutingConfigError) { sendError(response, error.statusCode, error.message); return; }
    if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")); return; }
    next(error);
  }
});

/** Selective cluster members distribute configurations over the signed v2 cluster
    protocol. The signature proves the sender's node identity; membership is checked
    against every cluster this node belongs to, so nothing propagates beyond it. */
app.post("/api/cluster/v2/routing-configs", async (request, response, next) => {
  try {
    if (response.locals.machineProtocol !== 2 || typeof response.locals.machineNodeId !== "string") throw new RoutingConfigError(401, "Unauthorized");
    const sender = response.locals.machineNodeId;
    const local = await getClusterNode();
    const db = routingConfigDatabase();
    const v2db = await clusterV2Database();
    const eligible = listSharingMemberships(v2db, local.id).some((membership) =>
      listSharingClusterMembers(v2db, membership.clusterId).some((member) => member.nodeId === sender));
    if (!eligible) throw new RoutingConfigError(403, "Only a node sharing a cluster membership may distribute routing configurations");
    const batch = eventBatchSchema.parse(request.body);
    const received = applyRoutingConfigEvents(db, batch.events, sender);
    broadcastRoutingMode();
    response.json({ received });
  } catch (error) {
    if (error instanceof RoutingConfigError) { sendError(response, error.statusCode, error.message); return; }
    if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")); return; }
    next(error);
  }
});
