import { z } from "zod";
import { listProjects, listWorkspaces } from "../../store.js";
import { getClusterNode } from "../../cluster.js";
import { automationWorkspaceIdentity, automationWorkspaceKey } from "../../automation-tags.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { queryAutomationExecutions } from "../../automation-execution-report.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";

const querySchema = z.object({
  tag: z.string().max(80).optional(), sourceKind: z.enum(["scheduled", "webhook"]).optional(), sourceId: z.string().max(240).optional(),
  status: z.enum(["queued", "running", "succeeded", "failed", "cancelled", "interrupted"]).optional(),
  from: z.string().datetime().optional(), to: z.string().datetime().optional(), timeZone: z.string().min(1).max(100).default("UTC"),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

app.get("/api/workspaces/:workspaceId/automation-executions", async (request, response, next) => {
  try {
    const workspaceId = z.string().min(1).max(300).parse(request.params.workspaceId);
    if (!(await listWorkspaces()).some(workspace => workspace.id === workspaceId)) { sendError(response, 404, "Workspace not found"); return; }
    const projects = (await listProjects()).filter(project => project.type === workspaceId);
    const query = querySchema.parse(request.query);
    const to = query.to ?? new Date().toISOString(), from = query.from ?? new Date(Date.parse(to) - 30 * 86400000).toISOString();
    if (Date.parse(from) >= Date.parse(to)) { sendError(response, 400, "The start date must be before the end date"); return; }
    const db = await clusterV2Database(), local = await getClusterNode();
    const workspace = automationWorkspaceIdentity(db, local.id, workspaceId);
    response.json(queryAutomationExecutions(db, {
      workspaceId: automationWorkspaceKey(workspace), tagKey: query.tag?.trim().replace(/\s+/g, " ").toLocaleLowerCase(), sourceKind: query.sourceKind, sourceId: query.sourceId, status: query.status,
      from, to, timeZone: query.timeZone, page: query.page, pageSize: query.pageSize,
    }, projects.map(project => project.id)));
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid automation execution filter"); return; }
    next(error);
  }
});
