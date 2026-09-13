import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { getClusterNode } from "../../cluster.js";
import { BrowserMonitorCheckError } from "../../browser-monitor-scheduler.js";
import { authorizeMonitorRead, browserMonitorCommandSchema, browserMonitorReferenceSchema, listBrowserMonitors, localMonitorRead, manageBrowserMonitor, routeBrowserMonitor } from "../browser-monitors.js";
import { BrowserRequestError } from "../browser.js";
import { app } from "../state.js";

function route(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, _next: NextFunction) => {
    response.setHeader("Cache-Control", "no-store");
    void handler(request, response).catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      const raw = error instanceof Error ? error.message.split("\n")[0] : "Browser monitor request failed";
      const message = raw.slice(0, 2000);
      const status = error instanceof BrowserRequestError ? error.status : error instanceof z.ZodError ? 400 : /not found/i.test(message) ? 404 : 409;
      const body = error instanceof BrowserMonitorCheckError ? { error: message, health: error.health } : { error: error instanceof z.ZodError ? "Invalid browser monitor request" : message };
      response.status(status).json(body);
    });
  };
}
function human(response: Response): AuthSession {
  const auth = response.locals.authSession as AuthSession | undefined;
  if (!auth) throw new BrowserRequestError(401, "Sign in to manage browser monitors");
  return auth;
}
function machine(response: Response): string {
  if (!response.locals.machineAuth) throw new BrowserRequestError(403, "Machine authentication required");
  return response.locals.machineNodeId as string;
}
const manageBodySchema = z.object({ nodeId: z.string().uuid(), command: browserMonitorCommandSchema }).strict();

app.get("/api/projects/:projectId/browser-monitors", route(async (request, response) => {
  human(response); response.json(await listBrowserMonitors(z.string().min(1).max(200).parse(request.params.projectId)));
}));
app.post("/api/browser/monitors", route(async (request, response) => {
  const auth = human(response), body = manageBodySchema.parse(request.body), local = await getClusterNode();
  response.json(await routeBrowserMonitor(body.nodeId, body.command, `${local.id}:${auth.userId}`));
}));
app.post("/api/cluster/browser/monitor-manage", route(async (request, response) => {
  const caller = machine(response);
  const body = z.object({ command: browserMonitorCommandSchema, createdBy: z.string().min(1).max(200) }).strict().parse(request.body);
  if (!body.createdBy.startsWith(`${caller}:`)) throw new BrowserRequestError(403, "Monitor creator provenance does not match caller");
  response.json(await manageBrowserMonitor(body.command, body.createdBy, caller));
}));
app.post("/api/cluster/browser/monitor-read", route(async (request, response) => {
  const caller = machine(response);
  const body = z.object({ ownerNodeId: z.string().uuid(), reference: browserMonitorReferenceSchema }).strict().parse(request.body);
  if (body.ownerNodeId !== caller) throw new BrowserRequestError(403, "Monitor owner does not match caller");
  response.json({ result: await localMonitorRead(body.ownerNodeId, body.reference) });
}));
app.post("/api/cluster/browser/monitor-authorize", route(async (request, response) => {
  const caller = machine(response);
  const body = z.object({ reference: browserMonitorReferenceSchema }).strict().parse(request.body);
  response.json({ authorization: await authorizeMonitorRead(body.reference, caller) });
}));
