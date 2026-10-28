import { z } from "zod";
import { listWorkspaces } from "../../store.js";
import { getClusterNode } from "../../cluster.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { automationWorkspaceIdentity, listAutomationTags, renameAutomationTag, retireAutomationTag, saveAutomationTag, type AutomationTag } from "../../automation-tags.js";
import { announceAutomationTagChanges, mutateSharedAutomationTag } from "../shared-automation-tags.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";

const idSchema = z.string().uuid();
async function authorizedWorkspace(workspaceId: string) {
  const workspace = (await listWorkspaces()).find(item => item.id === workspaceId);
  if (!workspace) return null;
  const db = await clusterV2Database(), local = await getClusterNode();
  return { workspace, localNodeId: local.id, identity: automationWorkspaceIdentity(db, local.id, workspace.id) };
}
async function mutateTag(access: NonNullable<Awaited<ReturnType<typeof authorizedWorkspace>>>, input: { action: "create" | "rename" | "retire"; id?: string; name?: string }): Promise<{ tag?: AutomationTag; ok?: boolean }> {
  const { identity, localNodeId } = access;
  if (identity.ownerNodeId !== localNodeId) return await mutateSharedAutomationTag(identity.ownerNodeId, { workspaceId: identity.workspaceId, ...input }) as { tag?: AutomationTag; ok?: boolean };
  const db = await clusterV2Database();
  if (input.action === "create") {
    const tag = saveAutomationTag(db, { ...identity, name: input.name! });
    void announceAutomationTagChanges();
    return { tag };
  }
  if (input.action === "rename") {
    const tag = renameAutomationTag(db, identity.workspaceId, input.id!, input.name!, identity.ownerNodeId);
    void announceAutomationTagChanges();
    return { tag };
  }
  retireAutomationTag(db, identity.workspaceId, input.id!, identity.ownerNodeId);
  void announceAutomationTagChanges();
  return { ok: true };
}
function route(work: (request: any, response: any) => Promise<void>) {
  return (request: any, response: any, next: (error?: unknown) => void) => {
    void work(request, response).catch((error: unknown) => {
      if (error instanceof z.ZodError) { sendError(response, 400, "Invalid automation tag request"); return; }
      if (error instanceof Error && typeof (error as Error & { status?: unknown }).status === "number") { sendError(response, (error as Error & { status: number }).status, error.message); return; }
      if (error instanceof Error && /not found/i.test(error.message)) { sendError(response, 404, error.message); return; }
      if (error instanceof Error && /already exists|duplicate/i.test(error.message)) { sendError(response, 409, error.message); return; }
      next(error);
    });
  };
}

app.get("/api/workspaces/:workspaceId/automation-tags", route(async (request, response) => {
  const workspaceId = z.string().min(1).max(300).parse(request.params.workspaceId);
  const access = await authorizedWorkspace(workspaceId);
  if (!access) { sendError(response, 404, "Workspace not found"); return; }
  response.json({ tags: listAutomationTags(await clusterV2Database(), access.identity.workspaceId, access.identity.ownerNodeId) });
}));
app.post("/api/workspaces/:workspaceId/automation-tags", route(async (request, response) => {
  const workspaceId = z.string().min(1).max(300).parse(request.params.workspaceId);
  const access = await authorizedWorkspace(workspaceId);
  if (!access) { sendError(response, 404, "Workspace not found"); return; }
  const { name } = z.object({ name: z.string().trim().min(1).max(80) }).strict().parse(request.body);
  response.status(201).json(await mutateTag(access, { action: "create", name }));
}));
app.patch("/api/workspaces/:workspaceId/automation-tags/:id", route(async (request, response) => {
  const workspaceId = z.string().min(1).max(300).parse(request.params.workspaceId), id = idSchema.parse(request.params.id);
  const access = await authorizedWorkspace(workspaceId);
  if (!access) { sendError(response, 404, "Workspace not found"); return; }
  const { name } = z.object({ name: z.string().trim().min(1).max(80) }).strict().parse(request.body);
  response.json(await mutateTag(access, { action: "rename", id, name }));
}));
app.delete("/api/workspaces/:workspaceId/automation-tags/:id", route(async (request, response) => {
  const workspaceId = z.string().min(1).max(300).parse(request.params.workspaceId), id = idSchema.parse(request.params.id);
  const access = await authorizedWorkspace(workspaceId);
  if (!access) { sendError(response, 404, "Workspace not found"); return; }
  await mutateTag(access, { action: "retire", id });
  response.status(204).end();
}));
