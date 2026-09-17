import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { type AuthSession } from "../../auth.js";
import {
  backgroundTaskCommandSchema,
  discoverBackgroundTasks,
  localBackgroundTaskOperation,
  routeBackgroundTaskOperation,
  TaskRequestError,
} from "../background-tasks.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";

function route(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, _next: NextFunction) => {
    response.setHeader("Cache-Control", "no-store");
    void handler(request, response).catch((error) => {
      const status = error instanceof TaskRequestError ? error.status : error instanceof z.ZodError ? 400 : 500;
      sendError(response, status, error instanceof TaskRequestError
        ? error.message
        : error instanceof z.ZodError ? "Invalid background task request" : "Background task request failed");
    });
  };
}

function human(response: Response): void {
  if (!(response.locals.authSession as AuthSession | undefined) || response.locals.machineAuth) {
    throw new TaskRequestError(401, "Human authentication required");
  }
}

function machine(response: Response): string {
  if (!response.locals.machineAuth || response.locals.authSession) throw new TaskRequestError(403, "Machine authentication required");
  return response.locals.machineNodeId as string;
}

const query = z.object({
  projectId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
  nodeId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  beforeStartedAt: z.string().min(1).max(100).optional(),
  beforeId: z.string().uuid().optional(),
}).strict().refine((value) => Boolean(value.beforeStartedAt) === Boolean(value.beforeId), "Incomplete cursor");

const agentBody = z.discriminatedUnion("action", [
  z.object({ nodeId: z.string().uuid().optional(), action: z.literal("list") }).strict(),
  z.object({ nodeId: z.string().uuid(), action: z.literal("get"), id: z.string().uuid() }).strict(),
  z.object({ nodeId: z.string().uuid(), action: z.literal("output"), id: z.string().uuid(), offset: z.number().int().nonnegative().safe().optional(), limit: z.number().int().min(1).max(65536).optional() }).strict(),
  z.object({ nodeId: z.string().uuid(), action: z.literal("stop"), id: z.string().uuid() }).strict(),
]);

app.get("/api/background-tasks", route(async (request, response) => {
  human(response);
  const value = query.parse(request.query);
  if (!value.nodeId) {
    response.json(await discoverBackgroundTasks(value.projectId, value.conversationId));
    return;
  }
  const command = backgroundTaskCommandSchema.parse({
    action: "list",
    projectId: value.projectId,
    conversationId: value.conversationId,
    limit: value.limit,
    before: value.beforeId ? { startedAt: value.beforeStartedAt, id: value.beforeId } : undefined,
  });
  response.json(await routeBackgroundTaskOperation(value.nodeId, command));
}));

app.post("/api/background-tasks/operation", route(async (request, response) => {
  human(response);
  const body = z.object({ nodeId: z.string().uuid(), command: backgroundTaskCommandSchema }).strict().parse(request.body);
  response.json(await routeBackgroundTaskOperation(body.nodeId, body.command));
}));

app.post("/api/background-tasks/agent", route(async (request, response) => {
  const identity = response.locals.taskAgent as { projectId: string; conversationId: string } | undefined;
  if (!identity || response.locals.authSession || response.locals.machineAuth) throw new TaskRequestError(401, "Task agent authentication required");
  const body = agentBody.parse(request.body);
  const { nodeId, ...operation } = body;
  const command = backgroundTaskCommandSchema.parse({ ...operation, projectId: identity.projectId, conversationId: identity.conversationId });
  response.json(nodeId ? await routeBackgroundTaskOperation(nodeId, command) : await localBackgroundTaskOperation(command));
}));

app.post("/api/cluster/background-tasks", route(async (request, response) => {
  const caller = machine(response);
  const command = backgroundTaskCommandSchema.parse(request.body);
  response.json(await localBackgroundTaskOperation(command, caller));
}));
