import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { app } from "../state.js";
import { getClusterNode } from "../../cluster.js";
import { applyBrowserConfiguration, browserConfigurationSchema } from "../../browser-configuration.js";
import { browserIdentitySchema, browserStartSchema, browserCommandSchema, type BrowserActor, type BrowserSessionView } from "../../browser-types.js";
import { type AuthSession } from "../../auth.js";
import { browserRuntime, browserStatus, configureBrowserExecutor, browserOperation, browserOperationSchema, localBrowserOperation, localBrowserStatus, BrowserRequestError, browserDownload } from "../browser.js";
import { clusterPeerMayAccessProject } from "../cluster-helpers.js";
import { sendError } from "../http-auth.js";

const id = z.string().uuid();
const actorSchema = z.discriminatedUnion("kind", [z.object({kind:z.literal("agent")}),z.object({kind:z.literal("human"),id:z.string().min(1).max(500)})]);
function route(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, _next: NextFunction) => {
    void handler(request, response).catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      const message = error instanceof Error ? error.message.split("\n")[0] : "Browser request failed";
      const status = error instanceof BrowserRequestError ? error.status : error instanceof z.ZodError ? 400 : /not found|unknown (browser|session|profile|download)/i.test(message) ? 404 : 409;
      sendError(response, status, error instanceof z.ZodError ? "Invalid browser request" : message);
    });
  };
}
async function human(response: Response): Promise<BrowserActor> {
  const auth = response.locals.authSession as AuthSession | undefined;
  if (!auth) throw new BrowserRequestError(401, "Sign in to control the browser");
  return { kind: "human", id: `${(await getClusterNode()).id}:${auth.userId}` };
}
function machine(response: Response): string {
  if (!response.locals.machineAuth) throw new BrowserRequestError(403, "Machine authentication required");
  return response.locals.machineNodeId as string;
}
function attachment(response: Response, name: string) {
  response.setHeader("Content-Type", "application/octet-stream");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
}

app.get("/api/browser/status", route(async (_request,response) => { response.json(await browserStatus()); }));
app.put("/api/browser/config", route(async (request,response) => {
  const body = z.object({executorNodeId:id.nullable()}).parse(request.body);
  response.json(await configureBrowserExecutor(body.executorNodeId));
}));
app.get("/api/browser/sessions", route(async (request,response) => {
  const args = browserIdentitySchema.partial().parse(request.query);
  try { response.json(await browserOperation({operation:"list",args},await human(response))); }
  catch (error) { if (error instanceof BrowserRequestError && error.status===409) { response.json({sessions:[]}); return; } throw error; }
}));
app.post("/api/browser/sessions", route(async (request,response) => {
  response.status(201).json(await browserOperation({operation:"start",args:browserStartSchema.parse(request.body)},await human(response)));
}));
app.get("/api/browser/sessions/:id", route(async (request,response) => {
  response.json(await browserOperation({operation:"get",args:{id:id.parse(request.params.id)}},await human(response)));
}));
app.post("/api/browser/sessions/:id/command", route(async (request,response) => {
  response.json(await browserOperation({operation:"command",args:{id:id.parse(request.params.id),command:browserCommandSchema.parse(request.body)}},await human(response)));
}));
app.get("/api/browser/profiles", route(async (request,response) => {
  response.json(await browserOperation({operation:"profiles",args:{projectId:z.string().min(1).parse(request.query.projectId)}},await human(response)));
}));
app.delete("/api/browser/profiles/:id", route(async (request,response) => {
  response.json(await browserOperation({operation:"deleteProfile",args:{id:id.parse(request.params.id),projectId:z.string().min(1).parse(request.query.projectId)}},await human(response)));
}));
app.get("/api/browser/sessions/:id/downloads/:downloadId", route(async (request,response) => {
  const result=await browserDownload(id.parse(request.params.id),id.parse(request.params.downloadId)); attachment(response,result.name);
  await pipeline(result.stream,response);
}));

app.get("/api/cluster/browser/status",route(async (_request,response)=>{machine(response);response.json(await localBrowserStatus());}));
app.post("/api/cluster/browser/select",route(async (request,response)=>{
  machine(response);const body=z.object({executorNodeId:id.nullable()}).parse(request.body);
  response.json(await configureBrowserExecutor(body.executorNodeId));
}));
app.post("/api/cluster/browser/config",route(async (request,response)=>{
  machine(response);const config=browserConfigurationSchema.parse(request.body);
  if ((await localBrowserStatus()).runningCount>0 && config.executorNodeId!==(await getClusterNode()).id) throw new BrowserRequestError(409,"End running browser sessions before changing the executor");
  applyBrowserConfiguration(config);response.json({saved:true});
}));
app.post("/api/cluster/browser/operation",route(async (request,response)=>{
  const caller=machine(response);
  const config=browserConfigurationSchema.parse(request.body.config);applyBrowserConfiguration(config);
  response.json(await localBrowserOperation(browserOperationSchema.parse(request.body),actorSchema.parse(request.body.actor),caller));
}));
app.post("/api/cluster/browser/download",route(async (request,response)=>{
  const caller=machine(response);
  const body=z.object({id,downloadId:id,config:browserConfigurationSchema}).parse(request.body);applyBrowserConfiguration(body.config);
  const session=await browserRuntime().get(body.id);
  if (!(await clusterPeerMayAccessProject(caller,session.projectId))) throw new BrowserRequestError(403,"Project is not shared with this node");
  const file=await browserRuntime().download(body.id,body.downloadId);attachment(response,file.name);response.setHeader("x-browser-filename",encodeURIComponent(file.name));
  await pipeline(createReadStream(file.path),response);
}));

// Capability tokens can reach this endpoint only; the server, not CLI input, supplies identity.
app.post("/api/browser/agent",route(async (request,response)=>{
  if (!response.locals.browserAgent) throw new BrowserRequestError(401,"Browser agent token required");
  const identity=browserIdentitySchema.parse(response.locals.browserAgent);
  const body=z.discriminatedUnion("operation",[
    z.object({operation:z.literal("start"),url:z.string().url().optional(),profileId:id.optional()}),
    z.object({operation:z.literal("status")}),
    z.object({operation:z.literal("profiles")}),
    z.object({operation:z.literal("command"),command:browserCommandSchema}),
    z.object({operation:z.literal("download"),downloadId:id}),
  ]).parse(request.body);
  const actor:BrowserActor={kind:"agent"};
  if(body.operation==="start") { response.json(await browserOperation({operation:"start",args:{...identity,appNodeId:(await getClusterNode()).id,url:body.url,profileId:body.profileId}},actor));return; }
  if(body.operation==="profiles") { response.json(await browserOperation({operation:"profiles",args:{projectId:identity.projectId}},actor));return; }
  const listed=await browserOperation({operation:"list",args:identity},actor) as {sessions:BrowserSessionView[]};
  if(body.operation==="status") { response.json(listed);return; }
  const session=listed.sessions.find(session=>session.state==="running");
  if(!session) throw new BrowserRequestError(409,"No running browser for this conversation. Run browser start first.");
  if(body.operation==="command") { response.json(await browserOperation({operation:"command",args:{id:session.id,command:body.command}},actor));return; }
  const download=await browserDownload(session.id,body.downloadId);attachment(response,download.name);await pipeline(download.stream,response);
}));
