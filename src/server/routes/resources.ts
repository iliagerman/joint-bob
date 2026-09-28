import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { agentResourcePaths, scanLocalSkills } from "../../agent-resources.js";
import { getClusterNode } from "../../cluster.js";
import { listDiscoveredHarnesses } from "../../harnesses/registry.js";
import { configuredRuntime } from "../../harnesses/runtime-configuration.js";
import { resourceInventory, shareMcpServers, type ResourceInventory } from "../../resource-inventory.js";
import { getProject } from "../../store.js";
import { clusterPeerMayAccessProject } from "../cluster-helpers.js";
import { sendError } from "../http-auth.js";
import { listRuntimePeers, runtimeFetch } from "../runtime-peers.js";
import { app } from "../state.js";

interface NodeInventory {
  node: { id: string; name: string; local: boolean; online: boolean };
  inventory?: ResourceInventory;
  error?: string;
}

const inventoryQuerySchema = z.object({ projectId: z.string().min(1).max(200).optional(), cluster: z.enum(["0", "1"]).optional() }).strict();
const peerInventorySchema = z.object({ projectId: z.string().min(1).max(200).optional() }).strict();
const scanQuerySchema = z.object({ path: z.string().min(1).max(4096) }).strict();
const shareMcpSchema = z.object({ file: z.string().min(1).max(4096), names: z.array(z.string().min(1).max(200)).min(1).max(100), projectId: z.string().min(1).max(200).optional() }).strict();

function expandHome(candidate: string): string {
  if (candidate === "~") return os.homedir();
  return candidate.startsWith("~/") ? path.join(os.homedir(), candidate.slice(2)) : candidate;
}

async function localInventory(projectId?: string): Promise<ResourceInventory> {
  const project = projectId ? await getProject(projectId) : undefined;
  return resourceInventory(project ? { projectPath: project.path, projectId: project.id } : {});
}

app.get("/api/resources/inventory", async (request, response, next) => {
  try {
    const query = inventoryQuerySchema.parse(request.query);
    if (query.projectId && !await getProject(query.projectId)) { sendError(response, 404, "Project not found"); return; }
    const local = await getClusterNode();
    const nodes: NodeInventory[] = [{ node: { id: local.id, name: local.name, local: true, online: true }, inventory: await localInventory(query.projectId) }];
    if (query.cluster === "1") {
      const peers = await listRuntimePeers(query.projectId);
      nodes.push(...await Promise.all(peers.map(async (peer): Promise<NodeInventory> => {
        const node = { id: peer.id, name: peer.name, local: false, online: false };
        try {
          const remote = await runtimeFetch(`${peer.url}/api/cluster/resources/inventory`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(query.projectId ? { projectId: query.projectId } : {}), signal: AbortSignal.timeout(4_000) });
          if (!remote.ok) throw new Error(`Peer returned ${remote.status}`);
          return { node: { ...node, online: true }, inventory: await remote.json() as ResourceInventory };
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
    // Local file locations stay on this node; peers only need names and where each comes from.
    response.json({ ...inventory, skills: inventory.skills.map((skill) => ({ ...skill, path: "" })), mcpServers: inventory.mcpServers.map((server) => ({ ...server, file: "" })), sharedSkillsPath: "", mcpConfigPath: "" });
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
