import type { NextFunction, Response } from "express";
import { z } from "zod";
import { GitReviewError } from "../../git-review.js";
import { createProjectWorktree, deleteProjectWorktree, listProjectWorktrees, mergeProjectWorktree, ProjectWorktreeError, updateProjectWorktree } from "../../project-worktrees.js";
import type { WorktreeAgentIdentity } from "../../worktree-agent.js";
import { cleanupDoneWorktrees } from "../worktree-cleanup.js";
import { getProject } from "../../store.js";
import { PROJECT_COLORS } from "../../types.js";
import { sendError } from "../http-auth.js";
import { assertProjectEditable, ProjectLockedError } from "../projects.js";
import { broadcastToProject } from "../realtime.js";
import { app } from "../state.js";
import { worktreeAgentRequest, worktreeAgentRequestSchema } from "../worktree-agent.js";

const createSchema = z.object({ name: z.string().max(200), color: z.enum(PROJECT_COLORS).optional() }).strict();
const updateSchema = z.object({ name: z.string().max(200).optional(), color: z.enum(PROJECT_COLORS).optional() }).strict();
const worktreeId = z.string().regex(/^[0-9a-f-]{36}$/i);

function fail(response: Response, next: NextFunction, error: unknown): void {
  if (error instanceof ProjectWorktreeError) sendError(response, error.status, error.message);
  else if (error instanceof z.ZodError) sendError(response, 400, "Invalid worktree request");
  else next(error);
}

app.get("/api/projects/:projectId/worktrees", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    response.json({ worktrees: await listProjectWorktrees(project.id) });
  } catch (error) { fail(response, next, error); }
});

// Opening the list also reconciles done marks saved before this feature existed.
// Keep deletion on a CSRF-protected mutation, not the read-only GET endpoint.
app.post("/api/projects/:projectId/worktrees/cleanup", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    const cleanup = await cleanupDoneWorktrees(project);
    response.json({ ...cleanup, worktrees: await listProjectWorktrees(project.id) });
  } catch (error) { fail(response, next, error); }
});

app.post("/api/projects/:projectId/worktrees", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    await assertProjectEditable(project);
    const worktree = await createProjectWorktree(project, createSchema.parse(request.body));
    broadcastToProject(project.id, { type: "worktreesChanged" });
    response.status(201).json({ worktree });
  } catch (error) { fail(response, next, error); }
});

app.patch("/api/projects/:projectId/worktrees/:worktreeId", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    await assertProjectEditable(project);
    const worktree = await updateProjectWorktree(project.id, worktreeId.parse(request.params.worktreeId), updateSchema.parse(request.body));
    broadcastToProject(project.id, { type: "worktreesChanged" });
    broadcastToProject(project.id, { type: "sessionsChanged" });
    response.json({ worktree });
  } catch (error) { fail(response, next, error); }
});

app.delete("/api/projects/:projectId/worktrees/:worktreeId", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    await assertProjectEditable(project);
    await deleteProjectWorktree(project.id, worktreeId.parse(request.params.worktreeId));
    broadcastToProject(project.id, { type: "worktreesChanged" });
    broadcastToProject(project.id, { type: "sessionsChanged" });
    response.status(204).end();
  } catch (error) { fail(response, next, error); }
});

app.post("/api/projects/:projectId/worktrees/:worktreeId/merge", async (request, response, next) => {
  try {
    const project = await getProject(request.params.projectId);
    if (!project) { sendError(response, 404, "Project not found"); return; }
    await assertProjectEditable(project);
    const result = await mergeProjectWorktree(project, worktreeId.parse(request.params.worktreeId));
    if (result.merged) broadcastToProject(project.id, { type: "worktreesChanged" });
    response.json(result);
  } catch (error) { fail(response, next, error); }
});

app.post("/api/worktrees/agent", async (request, response, next) => {
  const identity = response.locals.worktreeAgent as WorktreeAgentIdentity | undefined;
  if (!identity) { sendError(response, 401, "Unauthorized"); return; }
  try {
    response.json(await worktreeAgentRequest(identity, worktreeAgentRequestSchema.parse(request.body)));
  } catch (error) {
    if (error instanceof z.ZodError) sendError(response, 400, `Invalid worktree request: ${error.issues.map((issue) => `${issue.path.join(".") || "request"} ${issue.message}`).join("; ")}`);
    else if (error instanceof ProjectWorktreeError || error instanceof GitReviewError) sendError(response, error.status, error.message);
    else if (error instanceof ProjectLockedError) sendError(response, 423, error.message);
    else next(error);
  }
});
