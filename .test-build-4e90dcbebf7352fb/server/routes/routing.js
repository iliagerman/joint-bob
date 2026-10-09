import { z } from "zod";
import { listDifficultyClassifiers } from "../../classifiers/registry.js";
import { getClusterNode } from "../../cluster.js";
import { isTrustedTwin, listSharingClusterMembers, listSharingMemberships } from "../../cluster-sharing-policy.js";
import { listHarnesses, listHarnessModels } from "../../harnesses.js";
import { applyRoutingConfigEvents, createRoutingConfig, DEFAULT_ROUTING_CONFIG_ID, defaultRoutingConfig, deleteRoutingConfig, enqueueRoutingConfigDeliveries, getRoutingConfig, listRoutingConfigs, pendingRoutingConfigDeliveryCount, routingConfigDatabase, routingConfigEventFor, routingConfigEventSchema, routingConfigShareTargets, routingConfigWarning, RoutingConfigError, setRoutingConfigSelection, updateRoutingConfig } from "../../routing-configs.js";
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
function localAuth(response) {
  if (!response.locals.authSession && !response.locals.machineAuth) throw new RoutingConfigError(401, "Unauthorized");
}
async function routingModels() {
  const groups = [];
  for (const adapter of listHarnesses()) {
    if (!adapter.models || !adapter.configuration) continue;
    let models = [];
    try {
      models = (await listHarnessModels(adapter.id)).filter((model) => automaticRoutingModelAllowed(model.provider, model.id)).map((model) => ({ provider: model.provider, id: model.id, label: model.label, ...model.providerLabel ? { providerLabel: model.providerLabel } : {} }));
    } catch {
    }
    groups.push({ id: adapter.id, label: adapter.label, thinkingLevels: adapter.configuration.thinkingLevels, ...adapter.configuration.fixedProvider ? { fixedProvider: adapter.configuration.fixedProvider } : {}, models });
  }
  return groups;
}
function configView(localNodeId, config, ownerNames2, builtIn = false) {
  return {
    ...config,
    mine: config.ownerNodeId === localNodeId,
    ...builtIn ? { builtIn: true, ownerLabel: "Joint Bob" } : ownerNames2.has(config.ownerNodeId) ? { ownerLabel: ownerNames2.get(config.ownerNodeId) } : {},
    warning: routingConfigWarning(config)
  };
}
async function ownerNames(local) {
  const names = /* @__PURE__ */ new Map([[local.id, local.name]]);
  const db = routingPolicyDatabase();
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'cluster_v2_membership_nodes'").get()) {
    for (const row of db.prepare("SELECT node_id, name FROM cluster_v2_membership_nodes").all()) names.set(row.node_id, row.name);
  }
  return names;
}
async function distribute(event) {
  const local = await getClusterNode();
  const db = routingConfigDatabase();
  const targets = routingConfigShareTargets(routingPolicyDatabase(), local.id);
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
      configs: [configView(local.id, defaultRoutingConfig(), names, true), ...listRoutingConfigs(db).map((config) => configView(local.id, config, names))],
      selectedId: db.prepare("SELECT config_id FROM routing_config_selection WHERE singleton = 1").get()?.config_id ?? "",
      classifiers: listDifficultyClassifiers().map(({ id, label, variableName }) => ({ id, label, variableName })),
      harnesses,
      defaultPolicy: defaultRoutingPolicy(),
      shareTargets: routingConfigShareTargets(policies, local.id).map(({ nodeId, name, kind, clusterName }) => ({ nodeId, name, kind, ...clusterName ? { clusterName } : {} })),
      // Kept for older callers: the retired per-cluster policies are listed read-only until the migration empties them.
      policies: listRoutingPolicies(policies).map((stored) => ({ ...stored, editable: false, localLeader: false, leaderName: stored.leaderNodeId, warning: null }))
    });
  } catch (error) {
    if (error instanceof RoutingConfigError) {
      sendError(response, error.statusCode, error.message);
      return;
    }
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
    if (error instanceof RoutingConfigError || error instanceof RoutingPolicyError) {
      sendError(response, error.statusCode, error.message);
      return;
    }
    if (error instanceof z.ZodError) {
      sendError(response, 400, error.errors.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
      return;
    }
    next(error);
  }
});
app.put("/api/routing-configs/selection", async (request, response, next) => {
  try {
    localAuth(response);
    const input = selectionSchema.parse(request.body);
    if (input.configId !== "" && input.configId !== DEFAULT_ROUTING_CONFIG_ID && !getRoutingConfig(routingConfigDatabase(), input.configId)) throw new RoutingConfigError(404, "Routing configuration not found");
    setRoutingConfigSelection(routingConfigDatabase(), input.configId);
    broadcastRoutingMode();
    response.json({ selectedId: input.configId });
  } catch (error) {
    if (error instanceof RoutingConfigError) {
      sendError(response, error.statusCode, error.message);
      return;
    }
    if (error instanceof z.ZodError) {
      sendError(response, 400, error.errors.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
      return;
    }
    next(error);
  }
});
app.put("/api/routing-configs/:id", async (request, response, next) => {
  try {
    localAuth(response);
    const id = uuid.parse(request.params.id);
    if (id === DEFAULT_ROUTING_CONFIG_ID) throw new RoutingConfigError(403, "The Joint Bob default configuration is read-only; clone it to make changes");
    const input = configUpdateSchema.parse(request.body);
    const local = await getClusterNode();
    const db = routingConfigDatabase();
    const changes = {
      ...input.name === void 0 ? {} : { name: input.name },
      ...input.policy === void 0 ? {} : { policy: validateRoutingPolicy(input.policy) }
    };
    const config = updateRoutingConfig(db, local.id, id, changes);
    const results = config.shared ? await distribute(routingConfigEventFor(config)) : [];
    broadcastRoutingMode();
    response.json({ config: configView(local.id, config, await ownerNames(local)), results });
  } catch (error) {
    if (error instanceof RoutingConfigError || error instanceof RoutingPolicyError) {
      sendError(response, error.statusCode, error.message);
      return;
    }
    if (error instanceof z.ZodError) {
      sendError(response, 400, error.errors.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
      return;
    }
    next(error);
  }
});
app.delete("/api/routing-configs/:id", async (request, response, next) => {
  try {
    localAuth(response);
    const id = uuid.parse(request.params.id);
    if (id === DEFAULT_ROUTING_CONFIG_ID) throw new RoutingConfigError(403, "The Joint Bob default configuration cannot be deleted");
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
    if (error instanceof RoutingConfigError) {
      sendError(response, error.statusCode, error.message);
      return;
    }
    if (error instanceof z.ZodError) {
      sendError(response, 400, error.errors.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
      return;
    }
    next(error);
  }
});
app.post("/api/routing-configs/:id/share", async (request, response, next) => {
  try {
    localAuth(response);
    const id = uuid.parse(request.params.id);
    if (id === DEFAULT_ROUTING_CONFIG_ID) throw new RoutingConfigError(403, "The Joint Bob default configuration cannot be shared");
    const local = await getClusterNode();
    const db = routingConfigDatabase();
    const config = getRoutingConfig(db, id);
    if (!config) throw new RoutingConfigError(404, "Routing configuration not found");
    if (config.ownerNodeId !== local.id) throw new RoutingConfigError(403, "Only the node that created this configuration can share it");
    db.prepare("UPDATE routing_configs SET shared = 1 WHERE id = ?").run(id);
    const shared = getRoutingConfig(db, id);
    const results = await distribute(routingConfigEventFor(shared));
    response.json({ config: configView(local.id, shared, await ownerNames(local)), results });
  } catch (error) {
    if (error instanceof RoutingConfigError) {
      sendError(response, error.statusCode, error.message);
      return;
    }
    if (error instanceof z.ZodError) {
      sendError(response, 400, error.errors.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
      return;
    }
    next(error);
  }
});
app.post("/api/cluster/v2/routing-configs", async (request, response, next) => {
  try {
    if (response.locals.machineProtocol !== 2 || typeof response.locals.machineNodeId !== "string") throw new RoutingConfigError(401, "Unauthorized");
    const sender = response.locals.machineNodeId;
    const local = await getClusterNode();
    const db = routingConfigDatabase();
    const v2db = await clusterV2Database();
    const eligible = isTrustedTwin(v2db, local.id, sender) || listSharingMemberships(v2db, local.id).some((membership) => listSharingClusterMembers(v2db, membership.clusterId).some((member) => member.nodeId === sender));
    if (!eligible) throw new RoutingConfigError(403, "Only a twin or a node sharing a cluster membership may distribute routing configurations");
    const batch = eventBatchSchema.parse(request.body);
    const received = applyRoutingConfigEvents(db, batch.events, sender);
    broadcastRoutingMode();
    response.json({ received });
  } catch (error) {
    if (error instanceof RoutingConfigError) {
      sendError(response, error.statusCode, error.message);
      return;
    }
    if (error instanceof z.ZodError) {
      sendError(response, 400, error.errors.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
      return;
    }
    next(error);
  }
});
