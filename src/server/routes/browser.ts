import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { app } from "../state.js";
import { getClusterNode } from "../../cluster.js";
import { applyBrowserConfiguration, readBrowserConfiguration, browserConfigurationSchema, applyBrowserPreference, readBrowserPreference, browserPreferenceSchema } from "../../browser-configuration.js";
import { browserIdentitySchema, browserStartSchema, browserCommandSchema, type BrowserActor } from "../../browser-types.js";
import { type AuthSession } from "../../auth.js";
import { browserRuntime, browserStatus, localBrowserStatus, configureBrowserExecutor, browserPreferences, canonicalBrowserIdentity, authorizeBrowserAgent, requireCompleteDiscovery, discoverBrowserProfiles, type BrowserDiscovery, browserOperation, browserOperationSchema, profileAccessUpdateSchema, localBrowserOperation, BrowserRequestError, browserDownload, browserSessionOwner } from "../browser.js";
import { clusterPeerMayAccessProject } from "../cluster-helpers.js";
import { sendError } from "../http-auth.js";
import { browserAgentCredential, browserAgentCredentialOrigins } from "../../browser-agent.js";

const id = z.string().uuid();
const exactOrigin=z.string().url().refine(value=>{const url=new URL(value);return ["http:","https:"].includes(url.protocol)&&url.origin===value;});
const actorSchema = z.discriminatedUnion("kind", [z.object({kind:z.literal("human"),id:z.string().min(1).max(500)}),z.object({kind:z.literal("agent"),credentialOrigins:z.array(exactOrigin).max(1000).optional()})]);
const targetNode = (request: Request) => id.optional().parse(request.query.nodeId);
function route(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, _next: NextFunction) => {
    void handler(request, response).catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      const message = error instanceof Error ? error.message.split("\n")[0] : "Browser request failed";
      const status = error instanceof BrowserRequestError ? error.status : error instanceof z.ZodError ? 400 : /restricted to this node/i.test(message) ? 403 : /not found|unknown (browser|session|profile|download)/i.test(message) ? 404 : 409;
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
app.delete("/api/browser/sessions/:id", route(async (request,response) => {
  response.json(await browserOperation({operation:"forget",args:{id:id.parse(request.params.id)}},await human(response),targetNode(request)));
}));
app.get("/api/browser/profiles", route(async (request,response) => {
  const args = z.object({ projectId: z.string().min(1), conversationId: z.string().min(1).max(200).optional(), engine: z.string().min(1).max(40).optional() }).parse(request.query);
  response.json(await browserOperation({operation:"profiles",args:{projectId:args.projectId,...(args.conversationId?{conversationId:args.conversationId}:{})}},await human(response),targetNode(request)));
}));
app.delete("/api/browser/profiles/:id", route(async (request,response) => {
  response.json(await browserOperation({operation:"deleteProfile",args:{id:id.parse(request.params.id),projectId:z.string().min(1).parse(request.query.projectId)}},await human(response),targetNode(request)));
}));
app.put("/api/browser/profiles/:id/access", route(async (request,response) => {
  const query = z.object({ projectId: z.string().min(1), conversationId: z.string().min(1).max(200).optional(), engine: z.string().min(1).max(40).optional() }).parse(request.query);
  const args = { id: id.parse(request.params.id), projectId: query.projectId, ...(query.conversationId ? { conversationId: query.conversationId } : {}), update: profileAccessUpdateSchema.parse(request.body) };
  response.json(await browserOperation({operation:"profileAccess",args},await human(response),targetNode(request)));
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
  // Agents see profiles through their conversation's grants only, never a bare project listing.
  if(identity && operation.operation==="profiles") operation.args.conversationId=identity.conversationId;
  const result=await localBrowserOperation(operation,actor,caller);
  response.json(result);
}));
app.post("/api/cluster/browser/download",route(async (request,response)=>{
  const caller=machine(response);
  const body=z.object({id,downloadId:id}).parse(request.body);
  const session=await browserRuntime().get(body.id);
  if (!(await clusterPeerMayAccessProject(caller,session.projectId))) throw new BrowserRequestError(403,"Project is not shared with this node");
  if (browserRuntime().profileOrNull(session.profileId)?.crossNodeAccess===false) throw new BrowserRequestError(403,"Browser profile is restricted to this node");
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
    z.object({operation:z.literal("loginFill"),selector:z.string().min(1).max(4096),accountId:id,variable:z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),profileId:id.optional()}).strict(),
    z.object({operation:z.literal("download"),downloadId:id,profileId:id.optional()}),
  ]).parse(request.body);
  const actor:BrowserActor={kind:"agent",credentialOrigins:browserAgentCredentialOrigins(response.locals.browserAgentToken as string)};
  if(body.operation==="start") {
    response.json(await browserOperation({operation:"start",args:{...identity,appNodeId:(await getClusterNode()).id,url:body.url,profileId:body.profileId,profileName:body.profileName}},actor,body.nodeId,identity));return;
  }
  const listed=await browserOperation({operation:"list",args:identity},actor,undefined,identity) as BrowserDiscovery;
  if(body.operation==="profiles") {
    const discovered=await discoverBrowserProfiles(identity,actor);
    response.json({profiles:discovered.profiles,unavailableNodes:[...listed.unavailableNodes,...discovered.unavailableNodes.filter(node=>!listed.unavailableNodes.some(entry=>entry.nodeId===node.nodeId))]});return;
  }
  if(body.operation==="status") {
    const status=await browserStatus();
    response.json({...listed,nodes:status.nodes,config:status.config,preference:await browserPreferences(identity)});return;
  }
  if(!body.profileId || !listed.sessions.some(session=>session.profileId===body.profileId)) requireCompleteDiscovery(listed);
  const ending=body.operation==="command" && body.command.action==="close";
  const sessions=listed.sessions.filter(session=>(session.state==="running" || (ending && session.restoreOnRestart)) && (!body.profileId || session.profileId===body.profileId));
  if(sessions.length>1) throw new BrowserRequestError(409,"Multiple browser profiles are running. Specify --profile ID.");
  const session=sessions[0];
  if(!session) throw new BrowserRequestError(body.profileId ? 404 : 409,body.profileId ? "No running browser for this profile in this conversation. Run browser start --profile ID first." : "No running browser for this conversation. Run browser start first.");
  if(body.operation==="loginFill") {
    try {
      const credential=browserAgentCredential(response.locals.browserAgentToken as string,body.accountId,body.variable);
      await browserOperation({operation:"command",args:{id:session.id,command:{action:"fill",selector:body.selector,text:credential.value,expectedOrigin:credential.origin,expectedPageId:session.activePageId!}}},actor,session.nodeId,identity);
    } catch (error) {
      // Only fixed permission errors are safe to disclose. A relayed page error
      // also arrives as BrowserRequestError and can contain the filled secret.
      const text=error instanceof Error ? error.message : "";
      if (["Browser profile grant was revoked for this conversation", "Browser profile is not granted to this conversation", "Browser profile is restricted to this node"].includes(text))
        throw new BrowserRequestError(403,text);
      throw new BrowserRequestError(409,"Website credential fill failed; inspect the page and account access before continuing");
    }
    response.json({ok:true});return;
  }
  if(body.operation==="command") { response.json(await browserOperation({operation:"command",args:{id:session.id,command:body.command}},actor,session.nodeId,identity));return; }
  const download=await browserDownload(session.id,body.downloadId,session.nodeId,identity);attachment(response,download.name);await pipeline(download.stream,response);
}));
