import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { app } from "../state.js";
import { getClusterNode } from "../../cluster.js";
import { applyBrowserConfiguration, readBrowserConfiguration, browserConfigurationSchema, applyBrowserPreference, readBrowserPreference, browserPreferenceSchema } from "../../browser-configuration.js";
import { browserIdentitySchema, browserStartSchema, browserCommandSchema, type BrowserActor, type BrowserProfile } from "../../browser-types.js";
import { type AuthSession } from "../../auth.js";
import { browserRuntime, browserStatus, localBrowserStatus, configureBrowserExecutor, browserPreferences, canonicalBrowserIdentity, authorizeBrowserAgent, requireCompleteDiscovery, type BrowserDiscovery, browserOperation, browserOperationSchema, localBrowserOperation, BrowserRequestError, browserDownload, browserSessionOwner } from "../browser.js";
import { clusterPeerMayAccessProject } from "../cluster-helpers.js";
import { sendError } from "../http-auth.js";

const id = z.string().uuid();
const actorSchema = z.discriminatedUnion("kind", [z.object({kind:z.literal("human"),id:z.string().min(1).max(500)}),z.object({kind:z.literal("agent")})]);
const targetNode = (request: Request) => id.optional().parse(request.query.nodeId);
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

app.get("/api/browser/config", route(async (_request,response) => { response.json(await browserStatus()); }));
app.put("/api/browser/config", route(async (request,response) => {
  await human(response);
  const { executorNodeId } = z.object({executorNodeId:id.nullable()}).parse(request.body);
  response.json(await configureBrowserExecutor(executorNodeId));
}));
app.get("/api/browser/preferences", route(async (request,response) => {
  await human(response); response.json(await browserPreferences(browserIdentitySchema.parse(request.query)));
}));
app.put("/api/browser/preferences", route(async (request,response) => {
  await human(response); response.json(await browserPreferences(browserIdentitySchema.parse(request.query),z.object({nodeId:id.nullable()}).parse(request.body)));
}));
app.get("/api/browser/status", route(async (request,response) => { response.json(await browserStatus(targetNode(request))); }));
app.get("/api/browser/sessions", route(async (request,response) => {
  const args = browserIdentitySchema.partial().parse(request.query);
  response.json(await browserOperation({operation:"list",args},await human(response),targetNode(request)));
}));
app.post("/api/browser/sessions", route(async (request,response) => {
  const args = browserStartSchema.parse(request.body);
  response.status(201).json(await browserOperation({operation:"start",args},await human(response),targetNode(request)));
}));
app.get("/api/browser/sessions/:id", route(async (request,response) => {
  response.json(await browserOperation({operation:"get",args:{id:id.parse(request.params.id)}},await human(response),targetNode(request)));
}));
app.post("/api/browser/sessions/:id/command", route(async (request,response) => {
  response.json(await browserOperation({operation:"command",args:{id:id.parse(request.params.id),command:browserCommandSchema.parse(request.body)}},await human(response),targetNode(request)));
}));
app.get("/api/browser/profiles", route(async (request,response) => {
  response.json(await browserOperation({operation:"profiles",args:{projectId:z.string().min(1).parse(request.query.projectId)}},await human(response),targetNode(request)));
}));
app.delete("/api/browser/profiles/:id", route(async (request,response) => {
  response.json(await browserOperation({operation:"deleteProfile",args:{id:id.parse(request.params.id),projectId:z.string().min(1).parse(request.query.projectId)}},await human(response),targetNode(request)));
}));
app.get("/api/browser/sessions/:id/downloads/:downloadId", route(async (request,response) => {
  const sessionId=id.parse(request.params.id);
  const nodeId=targetNode(request) ?? await browserSessionOwner(sessionId,await human(response));
  const result=await browserDownload(sessionId,id.parse(request.params.downloadId),nodeId); attachment(response,result.name);
  await pipeline(result.stream,response);
}));

app.post("/api/cluster/browser/status",route(async (_request,response)=>{machine(response);response.json(await localBrowserStatus());}));
app.post("/api/cluster/browser/config",route(async (request,response)=>{
  machine(response); applyBrowserConfiguration(browserConfigurationSchema.parse(request.body)); response.json({config:readBrowserConfiguration()});
}));
app.post("/api/cluster/browser/preferences",route(async (request,response)=>{
  const caller=machine(response);
  const body=z.object({identity:browserIdentitySchema,preference:browserPreferenceSchema.nullable()}).parse(request.body);
  const identity=await canonicalBrowserIdentity(body.identity);
  if (!(await clusterPeerMayAccessProject(caller,identity.projectId))) throw new BrowserRequestError(403,"Project is not shared with this node");
  if(body.preference) {
    const preferenceIdentity=await canonicalBrowserIdentity(body.preference);
    if(preferenceIdentity.projectId!==identity.projectId || preferenceIdentity.conversationId!==identity.conversationId) throw new BrowserRequestError(400,"Preference identity mismatch");
    applyBrowserPreference({...body.preference,...identity});
  }
  response.json({preference:readBrowserPreference(identity)});
}));
app.post("/api/cluster/browser/operation",route(async (request,response)=>{
  const caller=machine(response);
  const operation=browserOperationSchema.parse(request.body), actor=actorSchema.parse(request.body.actor);
  const identity=actor.kind==="agent" ? await authorizeBrowserAgent(operation,browserIdentitySchema.parse(request.body.identity)) : undefined;
  const result=await localBrowserOperation(operation,actor,caller);
  if(identity && operation.operation==="profiles") {
    const attached=new Set((await browserRuntime().list(identity)).map(session=>session.profileId));
    response.json({profiles:(result as {profiles:BrowserProfile[]}).profiles.filter(profile=>attached.has(profile.id))});return;
  }
  response.json(result);
}));
app.post("/api/cluster/browser/download",route(async (request,response)=>{
  const caller=machine(response);
  const body=z.object({id,downloadId:id}).parse(request.body);
  const session=await browserRuntime().get(body.id);
  if (!(await clusterPeerMayAccessProject(caller,session.projectId))) throw new BrowserRequestError(403,"Project is not shared with this node");
  if(request.body.identity) await authorizeBrowserAgent({operation:"get",args:{id:body.id}},browserIdentitySchema.parse(request.body.identity));
  const file=await browserRuntime().download(body.id,body.downloadId);attachment(response,file.name);response.setHeader("x-browser-filename",encodeURIComponent(file.name));
  await pipeline(createReadStream(file.path),response);
}));

// Capability tokens can reach this endpoint only; the server, not CLI input, supplies identity.
app.post("/api/browser/agent",route(async (request,response)=>{
  if (!response.locals.browserAgent) throw new BrowserRequestError(401,"Browser agent token required");
  const identity=await canonicalBrowserIdentity(browserIdentitySchema.parse(response.locals.browserAgent));
  const body=z.discriminatedUnion("operation",[
    z.object({operation:z.literal("start"),nodeId:id.optional(),url:z.string().url().optional(),profileId:id.optional(),profileName:z.string().trim().min(1).max(80).optional()}),
    z.object({operation:z.literal("status")}),
    z.object({operation:z.literal("profiles")}),
    z.object({operation:z.literal("command"),command:browserCommandSchema,profileId:id.optional()}),
    z.object({operation:z.literal("download"),downloadId:id,profileId:id.optional()}),
  ]).parse(request.body);
  const actor:BrowserActor={kind:"agent"};
  if(body.operation==="start") {
    response.json(await browserOperation({operation:"start",args:{...identity,appNodeId:(await getClusterNode()).id,url:body.url,profileId:body.profileId,profileName:body.profileName}},actor,body.nodeId,identity));return;
  }
  const listed=await browserOperation({operation:"list",args:identity},actor,undefined,identity) as BrowserDiscovery;
  const attached=new Set(listed.sessions.map(session=>session.profileId));
  if(body.operation==="profiles") {
    const results=await Promise.all([...new Set(listed.sessions.map(session=>session.nodeId))].map(async nodeId=> {
      const result=await browserOperation({operation:"profiles",args:{projectId:identity.projectId}},actor,nodeId,identity) as {profiles:BrowserProfile[]};
      return result.profiles.filter(profile=>attached.has(profile.id)).map(profile=>({...profile,nodeId}));
    }));
    response.json({profiles:results.flat(),unavailableNodes:listed.unavailableNodes});return;
  }
  if(body.operation==="status") {
    const status=await browserStatus();
    response.json({...listed,nodes:status.nodes,config:status.config,preference:await browserPreferences(identity)});return;
  }
  if(!body.profileId || !attached.has(body.profileId)) requireCompleteDiscovery(listed);
  const ending=body.operation==="command" && body.command.action==="close";
  const sessions=listed.sessions.filter(session=>(session.state==="running" || (ending && session.restoreOnRestart)) && (!body.profileId || session.profileId===body.profileId));
  if(sessions.length>1) throw new BrowserRequestError(409,"Multiple browser profiles are running. Specify --profile ID.");
  const session=sessions[0];
  if(!session) throw new BrowserRequestError(body.profileId ? 404 : 409,body.profileId ? "No running browser for this profile in this conversation. Run browser start --profile ID first." : "No running browser for this conversation. Run browser start first.");
  if(body.operation==="command") { response.json(await browserOperation({operation:"command",args:{id:session.id,command:body.command}},actor,session.nodeId,identity));return; }
  const download=await browserDownload(session.id,body.downloadId,session.nodeId,identity);attachment(response,download.name);await pipeline(download.stream,response);
}));
