import { existsSync, realpathSync } from "node:fs";
import { listGitSourceRecords } from "../../git-resources.js";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { agentResourcePaths, scanLocalSkills } from "../../agent-resources.js";
import { getClusterNode } from "../../cluster.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { authorizedSkillClusters, listReceivedSkills } from "../../skill-sharing.js";
import { listDiscoveredHarnesses } from "../../harnesses/registry.js";
import { configuredRuntime } from "../../harnesses/runtime-configuration.js";
import { resourceInventory, shareMcpServers, type ResourceInventory } from "../../resource-inventory.js";
import { activationDecision, setActivationPreference, autoActivateSharedSkills, receivedResource, receivedSkill } from "../../resource-activation.js";
import { save, settingsDatabase } from "../../settings-store.js";
import { reloadSharedSkills } from "../realtime.js";
import { getProject } from "../../store.js";
import { clusterPeerMayAccessProject } from "../cluster-helpers.js";
import { sendError, requireFeature, Feature } from "../http-auth.js";
import { listRuntimePeers, runtimeFetch } from "../runtime-peers.js";
import { app } from "../state.js";
import { peerSnapshot, staleSnapshotReason } from "../peer-snapshots.js";
import { registerGitResourceRoutes } from "../git-resources.js";
import { registerSkillSharingRoutes } from "../skill-sharing.js";

registerSkillSharingRoutes();
registerGitResourceRoutes();

const activationSchema = z.object({ kind: z.enum(["skill", "plugin", "mcp"]), name: z.string().min(1).max(200), harness: z.enum(["pi", "claude", "kiro"]), enabled: z.boolean().nullable(), projectId: z.string().min(1).max(200).optional(), conversationId: z.string().min(1).max(300).optional() }).strict();
const bulkActivationSchema = activationSchema.omit({ name: true, harness: true }).extend({ enabled: z.boolean(), items: z.array(activationSchema.pick({ name: true, harness: true })).min(1).max(1000) }).strict();
function activationError(inventory: ResourceInventory, kind: "skill" | "plugin" | "mcp", name: string, harness: "pi" | "claude" | "kiro", projectId?: string): { status: number; message: string } | null {
  const available = kind === "skill" ? inventory.skills : kind === "mcp" ? inventory.mcpServers : inventory.plugins;
  const matching = available.filter((item) => item.name === name && item.harnesses.includes(harness));
  const restricted = matching.find((item) => item.activationRestrictions?.[harness]);
  if (restricted) return { status: 409, message: restricted.activationRestrictions![harness]! };
  if (matching.some((item) => kind === "skill" ? Boolean(item.activation?.[harness])
    : kind === "plugin" ? ["managed", "global", "project"].includes((item as { source?: string }).source ?? "") && ((item as { source?: string }).source !== "project" || Boolean(projectId))
      : ["shared", "project", "plugin"].includes((item as { source?: string }).source ?? ""))) return null;
  return { status: 404, message: "Resource is not installed for that agent" };
}
app.get("/api/resources/activation", requireFeature(Feature.SETTINGS), (_request, response) => response.json({ autoActivateSharedSkills: autoActivateSharedSkills() }));
app.put("/api/resources/activation", requireFeature(Feature.SETTINGS), async (request, response, next) => {
  try {
    const body = z.object({ autoActivateSharedSkills: z.boolean() }).strict().parse(request.body);
    save(settingsDatabase(), "autoActivateSharedSkills", String(body.autoActivateSharedSkills));
    await reloadSharedSkills();
    response.json(body);
  } catch (error) { if (error instanceof z.ZodError) sendError(response, 400, "Invalid activation setting"); else next(error); }
});
app.put("/api/resources/activation/item", requireFeature(Feature.SETTINGS), async (request, response, next) => {
  try {
    const body = activationSchema.parse(request.body);
    if (body.projectId && !await getProject(body.projectId)) { sendError(response, 404, "Project not found"); return; }
    if (body.conversationId && !body.projectId) { sendError(response, 400, "Conversation needs a project"); return; }
    const inventory = await localInventory(body.projectId, body.conversationId);
    const error = activationError(inventory, body.kind, body.name, body.harness, body.projectId);
    if (error) { sendError(response, error.status, error.message); return; }
    const plugin = body.kind === "plugin" ? inventory.plugins.find((item) => item.name === body.name && item.harnesses.includes(body.harness)
      && ["managed", "global", "project"].includes(item.source) && (item.source !== "project" || Boolean(body.projectId))) : undefined;
    setActivationPreference(body.kind, body.name, body.harness, body.enabled);
    await reloadSharedSkills();
    const refreshed = await localInventory(body.projectId, body.conversationId);
    const decision = (plugin ? refreshed.plugins.find((item) => item.name === body.name && item.source === plugin.source)?.activation[body.harness]
      : body.kind === "skill" ? refreshed.skills.find((item) => item.name === body.name && item.harnesses.includes(body.harness))?.activation?.[body.harness]
        : refreshed.mcpServers.find((item) => item.name === body.name && item.harnesses.includes(body.harness) && ["shared", "project", "plugin"].includes(item.source))?.activation?.[body.harness])
      ?? activationDecision(body.kind, body.name, body.harness, body.kind === "skill" ? receivedSkill(body.name) : receivedResource(body.kind, body.name));
    response.json({ ...body, decision });
  } catch (error) { if (error instanceof z.ZodError) sendError(response, 400, "Invalid activation choice"); else next(error); }
});

app.put("/api/resources/activation/bulk", requireFeature(Feature.SETTINGS), async (request, response, next) => {
  try {
    const body = bulkActivationSchema.parse(request.body);
    if (body.projectId && !await getProject(body.projectId)) { sendError(response, 404, "Project not found"); return; }
    if (body.conversationId && !body.projectId) { sendError(response, 400, "Conversation needs a project"); return; }
    const identities = body.items.map(({ name, harness }) => `${name}\0${harness}`);
    if (new Set(identities).size !== identities.length) { sendError(response, 400, "Duplicate activation choice"); return; }
    const inventory = await localInventory(body.projectId, body.conversationId);
    for (const item of body.items) {
      const error = activationError(inventory, body.kind, item.name, item.harness, body.projectId);
      if (error) { sendError(response, error.status, error.message); return; }
    }
    const db = settingsDatabase();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const item of body.items) setActivationPreference(body.kind, item.name, item.harness, body.enabled);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    await reloadSharedSkills();
    response.json({ changed: body.items.length });
  } catch (error) { if (error instanceof z.ZodError) sendError(response, 400, "Invalid activation choices"); else next(error); }
});

interface NodeInventory {
  node: { id: string; name: string; local: boolean; online: boolean };
  inventory?: ResourceInventory;
  error?: string;
}

const inventoryQuerySchema = z.object({ projectId: z.string().min(1).max(200).optional(), conversationId: z.string().min(1).max(300).optional(), cluster: z.enum(["0", "1"]).optional() }).strict();
const peerInventorySchema = z.object({ projectId: z.string().min(1).max(200).optional() }).strict();
const scanQuerySchema = z.object({ path: z.string().min(1).max(4096) }).strict();
const shareMcpSchema = z.object({ file: z.string().min(1).max(4096), names: z.array(z.string().min(1).max(200)).min(1).max(100), projectId: z.string().min(1).max(200).optional() }).strict();

function expandHome(candidate: string): string {
  if (candidate === "~") return os.homedir();
  return candidate.startsWith("~/") ? path.join(os.homedir(), candidate.slice(2)) : candidate;
}

async function localInventory(projectId?: string, conversationId?: string): Promise<ResourceInventory> {
  const project = projectId ? await getProject(projectId) : undefined;
  return resourceInventory(project ? { projectPath: project.path, projectId: project.id, conversationId } : {});
}

app.get("/api/resources/inventory", async (request, response, next) => {
  try {
    const query = inventoryQuerySchema.parse(request.query);
    if (query.projectId && !await getProject(query.projectId)) { sendError(response, 404, "Project not found"); return; }
    const local = await getClusterNode();
    const nodes: NodeInventory[] = [{ node: { id: local.id, name: local.name, local: true, online: true }, inventory: await localInventory(query.projectId, query.conversationId) }];
    if (query.cluster === "1") {
      const peers = await listRuntimePeers(query.projectId);
      nodes.push(...await Promise.all(peers.map(async (peer): Promise<NodeInventory> => {
        const node = { id: peer.id, name: peer.name, local: false, online: false };
        try {
          const remote = await peerSnapshot(`resources:${query.projectId ?? ""}`, peer.id, async () => {
            const reply = await runtimeFetch(`${peer.url}/api/cluster/resources/inventory`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(query.projectId ? { projectId: query.projectId } : {}), signal: AbortSignal.timeout(4_000) });
            if (!reply.ok) throw new Error(`Peer returned ${reply.status}`);
            return await reply.json() as ResourceInventory;
          });
          return remote.fresh ? { node: { ...node, online: true }, inventory: remote.value } : { node, inventory: remote.value, error: staleSnapshotReason(remote.fetchedAt) };
        } catch (error) {
          return { node, error: error instanceof Error ? error.message : "Peer unreachable" };
        }
      })));
    }
    response.json({ nodes });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid inventory query"); return; }
    next(error);
  }
});

app.post(["/api/cluster/resources/inventory", "/api/cluster/v2/runtime/resources/inventory"], async (request, response, next) => {
  try {
    if (!response.locals.machineAuth) { sendError(response, 401, "Unauthorized"); return; }
    const { projectId } = peerInventorySchema.parse(request.body ?? {});
    if (projectId && !await clusterPeerMayAccessProject(response.locals.machineNodeId as string, projectId)) { sendError(response, 403, "Project is not shared with this node"); return; }
    const inventory = await localInventory(projectId);
    const db = await clusterV2Database();
    const local = await getClusterNode();
    const sender = response.locals.machineNodeId as string;
    const received = new Set(listReceivedSkills(db).map((skill) => skill.name));
    // A node-wide inventory must not disclose user/native names. Managed received
    // skills are not relayable, and owner skills appear only under an explicit grant.
    // Scoped copies were granted to this node's conversations, not to its peers.
    const skills = inventory.skills.filter((skill) => skill.origin === "scoped" ? false : skill.origin === "project"
      ? Boolean(projectId)
      : skill.origin === "shared" && !received.has(skill.name) && authorizedSkillClusters(db, local.id, sender, skill.name).length > 0);
    const granted = (await listGitSourceRecords()).filter((source) => !source.ownerNodeId && source.recipients.includes(sender)).flatMap((source) => source.installed);
    const pluginNames = new Set(granted.filter((item) => item.kind === "plugin").map((item) => item.name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^\.+/, "_")));
    const mcpNames = new Set(granted.filter((item) => item.kind === "mcp").map((item) => item.name));
    const project = projectId ? await getProject(projectId) : undefined;
    const inProject = (file: string): boolean => {
      if (!project) return false;
      try {
        const relative = path.relative(realpathSync(project.path), realpathSync(file));
        return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      } catch { return false; }
    };
    const plugins = inventory.plugins.filter((plugin) => plugin.source === "managed" ? pluginNames.has(plugin.name)
      : ["project", "configured"].includes(plugin.source) && inProject(plugin.file) && (plugin.source !== "project" || plugin.name === path.basename(plugin.file)));
    const grantedPluginRoots = plugins.filter((plugin) => plugin.source === "managed").map((plugin) => path.dirname(path.dirname(plugin.file)));
    const inGrantedPlugin = (file: string): boolean => grantedPluginRoots.some((root) => {
      try {
        const relative = path.relative(realpathSync(root), realpathSync(file));
        return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      } catch { return false; }
    });
    const mcpServers = inventory.mcpServers.filter((server) => server.source === "shared" ? mcpNames.has(server.name)
      : server.source === "project" ? inProject(server.file)
        : server.source === "plugin" && (inProject(server.file) || inGrantedPlugin(server.file)));
    // Reasons can name private aliases, skills or relays even when the row itself is shared.
    const peerActivation = (activation: ResourceInventory["plugins"][number]["activation"]) => Object.fromEntries(
      Object.entries(activation).map(([harness, decision]) => [harness, { ...decision, reason: decision?.enabled ? "Enabled on peer" : "Disabled on peer" }]));
    response.json({ ...inventory, skills: skills.map((skill) => ({ ...skill, path: "", activation: peerActivation(skill.activation ?? {}) })),
      mcpServers: mcpServers.map((server) => ({ ...server, file: "", activation: peerActivation(server.activation ?? {}) })),
      plugins: plugins.map((plugin) => ({ ...plugin, file: "", activation: peerActivation(plugin.activation) })), sharedSkillsPath: "", mcpConfigPath: "" });
  } catch (error) { next(error); }
});

app.get("/api/resources/skills/sources", (_request, response) => {
  const shared = agentResourcePaths().sharedSkills;
  const candidates = [path.join(os.homedir(), ".agents/skills"), ...listDiscoveredHarnesses().flatMap((adapter) => adapter.configuration ? [path.join(configuredRuntime(adapter.id, adapter.configuration.defaults(os.homedir())).configPath, "skills")] : [])];
  response.json({ sources: [...new Set(candidates)].filter((candidate) => path.resolve(candidate) !== path.resolve(shared) && existsSync(candidate)), sharedSkillsPath: shared });
});

app.get("/api/resources/skills/scan", async (request, response, next) => {
  try {
    const root = expandHome(scanQuerySchema.parse(request.query).path.trim());
    if (!path.isAbsolute(root)) { sendError(response, 400, "Enter an absolute folder, or one starting with ~/"); return; }
    response.json({ root, candidates: await scanLocalSkills(root) });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (error instanceof z.ZodError || code === "ENOENT" || code === "ENOTDIR") { sendError(response, 400, code ? "Folder not found" : "Invalid folder"); return; }
    next(error);
  }
});

app.post("/api/resources/mcp/share", async (request, response, next) => {
  try {
    const payload = shareMcpSchema.parse(request.body);
    const project = payload.projectId ? await getProject(payload.projectId) : undefined;
    if (payload.projectId && !project) { sendError(response, 404, "Project not found"); return; }
    response.json(await shareMcpServers(payload.file, payload.names, { projectPath: project?.path }));
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid MCP share request"); return; }
    if (error instanceof Error && /^(Servers are already shared|Unknown MCP config source|MCP config source is unreadable)/.test(error.message)) { sendError(response, 400, error.message); return; }
    next(error);
  }
});
