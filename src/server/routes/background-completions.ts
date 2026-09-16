import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { clusterPeerMayAccessProject } from "../cluster-helpers.js";
import { acceptCompletion } from "../background-completions.js";
import { TaskRequestError } from "../background-tasks.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";

const bodySchema = z.object({
  projectId: z.string().min(1).max(200), conversationId: z.string().min(1).max(200),
  sourceNodeId: z.string().uuid(), taskId: z.string().uuid(),
}).strict();

app.post("/api/cluster/background-completions", (request: Request, response: Response, _next: NextFunction) => {
  response.setHeader("Cache-Control", "no-store");
  void (async () => {
    if (!response.locals.machineAuth || response.locals.authSession) throw new TaskRequestError(403, "Machine authentication required");
    const body = bodySchema.parse(request.body);
    const caller = response.locals.machineNodeId as string;
    if (caller !== body.sourceNodeId) throw new TaskRequestError(403, "Completion source does not match caller");
    if (!await clusterPeerMayAccessProject(caller, body.projectId)) throw new TaskRequestError(403, "Project is not shared with this node");
    response.json(await acceptCompletion(body.sourceNodeId, body.projectId, body.conversationId, body.taskId));
  })().catch((error) => {
    const status = error instanceof TaskRequestError ? error.status : error instanceof z.ZodError ? 400 : 500;
    sendError(response, status, error instanceof TaskRequestError ? error.message : error instanceof z.ZodError ? "Invalid completion request" : "Completion delivery failed");
  });
});
