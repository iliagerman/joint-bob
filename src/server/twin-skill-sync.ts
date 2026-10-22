import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { agentResourcePaths } from "../agent-resources.js";
import { getClusterNode } from "../cluster.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { listTwinRelationships } from "../cluster-twins.js";
import { isTrustedTwin } from "../cluster-sharing-policy.js";
import { resolveDataDirectory } from "../data-directory.js";
import { getSettings } from "../settings.js";
import { setSkillShares, type SkillBundle } from "../skill-sharing.js";
import { markReceived, receivedOwner, withSkillMutation } from "../skill-sharing-files.js";
import { mergeTwinSkillVersions, nextSkillVersion, beginTwinSkillInitialization, saveTwinSkillSession, saveTwinSkillVersion, twinSkillSession, twinSkillVersions, validateTwinSkillVersion, type TwinSkillVersion, type TwinSkillSession } from "../twin-skill-sync.js";
import { signClusterRequest } from "../cluster-protocol.js";
import { app } from "./state.js";
import { requireFeature, Feature } from "./http-auth.js";
import { replicationPeers } from "./replication-v2.js";
import { fetchPeer } from "./peer-availability.js";
import { applyTwinSkillVersion, assertTwinInitializationSnapshot, cacheTwinBundle, cachedTwinBundle, previewTwinInitialization, recoverTwinSkillApplies, scanTwinSkills, type TwinSkillContext, type TwinSkillScan, type TwinSkillInitializationPlan } from "./twin-skill-files.js";

const peerSchema=z.object({peerNodeId:z.string().uuid()}).strict();
const versionSchema=z.object({name:z.string().min(1).max(200),digest:z.string().regex(/^[a-f0-9]{64}$/).nullable(),clock:z.record(z.string().uuid(),z.number().int().positive().max(Number.MAX_SAFE_INTEGER)),authorNodeId:z.string().uuid()}).strict();
const conflictSchema=z.object({version:versionSchema,resolution:versionSchema.nullable()}).strict();
const scanSchema=z.object({skills:z.array(z.object({name:z.string().max(200),digest:z.string().regex(/^[a-f0-9]{64}$/),grants:z.array(z.string().max(600)).max(1000)}).strict()).max(512),protected:z.array(z.string().max(200)).max(512),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const initSchema=z.object({token:z.string().uuid(),relationshipId:z.string().uuid(),sourceNodeId:z.string().uuid(),source:scanSchema,destination:scanSchema,versions:z.array(versionSchema).max(1024)}).strict();
type Initialization=z.infer<typeof initSchema>;
const hash=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const error=(message:string,status=409)=>Object.assign(new Error(message),{status});
const PREFIX="/api/cluster/v2/skills/twin-sync/";
let legacyBarrier:()=>Promise<void>=async()=>{throw error("Twin skill sync is not registered");};
async function localContext():Promise<{context:TwinSkillContext;session:TwinSkillSession|undefined}>{
 const db=await clusterV2Database(),local=await getClusterNode(),session=twinSkillSession(db),settings=getSettings();
 const context:TwinSkillContext={db,root:agentResourcePaths().sharedSkills,dataDir:resolveDataDirectory(),localNodeId:local.id,
  relationshipId:session?.relationshipId??"",sourceNodeId:session?.sourceNodeId??local.id,
  authorize:()=>{if(session)assertPeer(db,local.id,session.peerNodeId,session.relationshipId);},
  aliasRoots:[path.join(os.homedir(),".agents/skills"),path.join(settings.pi.configPath,"skills"),path.join(settings.claude.configPath,"skills")],
  revokeGrants:(name)=>setSkillShares(db,local.id,name,[])};
 return {context,session};
}
function assertPeer(db:TwinSkillContext["db"],local:string,peer:string,relationshipId?:string):string{
 const relationship=listTwinRelationships(db,local).find(r=>r.status==="active"&&r.peer.nodeId===peer&&(!relationshipId||r.relationshipId===relationshipId));
 if(!relationship||!isTrustedTwin(db,local,peer)||!replicationPeers(db,local).some(p=>p.nodeId===peer))throw error("An active direct trusted twin is required",403);
 return relationship.relationshipId;
}
function checkPartner(session:TwinSkillSession|undefined,peer:string,relationshipId:string):void{
 if(session&&(session.peerNodeId!==peer||session.relationshipId!==relationshipId))throw error("Only one skill-sync partner is allowed");
}
async function post(peer:string,operation:string,payload:unknown,limit=1024*1024):Promise<unknown>{
 const db=await clusterV2Database(),local=await getClusterNode();assertPeer(db,local.id,peer);
 const target=PREFIX+operation,endpoint=replicationPeers(db,local.id).find(p=>p.nodeId===peer)!;
 const body=Buffer.from(JSON.stringify(payload));
 const response=await fetchPeer(db,peer,new URL(target,endpoint.url),{method:"POST",body,headers:{"Content-Type":"application/json",Authorization:signClusterRequest(db,local.id,peer,"POST",target,body)},signal:AbortSignal.timeout(20_000),redirect:"error"});
 if(!response.ok){await response.body?.cancel();throw error(`Twin ${operation} failed (${response.status})`,response.status);}
 const reader=response.body!.getReader(),parts:Uint8Array[]=[];let bytes=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>limit)throw error("Twin response exceeds limit",413);parts.push(value);}}finally{await reader.cancel();}
 assertPeer(db,local.id,peer);return JSON.parse(Buffer.concat(parts).toString());
}
function validateVersions(versions:TwinSkillVersion[],local:string,peer:string):void{
 const names=new Set<string>();
 for(const v of versions){validateTwinSkillVersion(v);if(names.has(v.name)||Object.keys(v.clock).some(id=>id!==local&&id!==peer)||![local,peer].includes(v.authorNodeId))throw error("Invalid twin version authors or duplicate names",400);names.add(v.name);}
}
async function localVersions(c:TwinSkillContext):Promise<TwinSkillScan>{
 return withSkillMutation(async()=>{
  const scan=await scanTwinSkills(c),prior=new Map(twinSkillVersions(c.db,c.relationshipId).map(v=>[v.name,v]));
  for(const skill of scan.skills){
   const old=prior.get(skill.name);
   if(!old||old.digest!==skill.digest)saveTwinSkillVersion(c.db,c.relationshipId,nextSkillVersion(old,c.localNodeId,skill.digest,skill.name));
   if(c.localNodeId!==c.sourceNodeId){c.revokeGrants?.(skill.name);await markReceived(c.root,skill.name,`twin:${c.relationshipId}`,c.dataDir);}
  }
  const present=new Set([...scan.skills.map(s=>s.name),...scan.protected]);
  for(const old of prior.values())if(!present.has(old.name)&&old.digest!==null){
   saveTwinSkillVersion(c.db,c.relationshipId,nextSkillVersion(old,c.localNodeId,null));c.revokeGrants?.(old.name);
  }
  return scan;
 });
}
async function fetchBundle(peer:string,name:string,digest:string):Promise<SkillBundle>{
 const body=z.object({bundle:z.unknown()}).strict().parse(await post(peer,"bundle",{name,digest},4*1024*1024));
 const {validateSkillBundle}=await import("../skill-sharing.js");return validateSkillBundle(body.bundle);
}
async function initializeDestination(c:TwinSkillContext,payload:Initialization,peer:string):Promise<void>{
 if(c.db.prepare("SELECT 1 FROM twin_skill_cancelled WHERE token=?").get(payload.token))throw error("Initialization was cancelled; generate a new preview");
 validateVersions(payload.versions,c.localNodeId,peer);
 if(payload.sourceNodeId!==peer||payload.versions.some(v=>v.authorNodeId!==peer||v.clock[peer]!==1||Object.keys(v.clock).length!==1))throw error("Invalid initialization source",403);
 const plan=previewTwinInitialization(payload.source,payload.destination);
 // A signed initializer still cannot smuggle a name outside its confirmed inventories.
 const expected=new Map([...payload.source.skills.filter(s=>!plan.protected.includes(s.name)).map(s=>[s.name,s.digest] as const),...plan.remove.map(n=>[n,null] as const)]);
 if(expected.size!==payload.versions.length||payload.versions.some(v=>!expected.has(v.name)||expected.get(v.name)!==v.digest))throw error("Invalid initialization versions",400);
 const existing=twinSkillSession(c.db);checkPartner(existing,peer,payload.relationshipId);
 if(existing?.initialization){const old=initSchema.parse(JSON.parse(existing.initialization));if(hash(old)!==hash(payload))throw error("A different initialization is already recorded");if(existing.state==="active")return;}
 else{
  const scan=await withSkillMutation(()=>scanTwinSkills(c));
  if(scan.digest!==payload.destination.digest)throw error("Destination changed. Generate a new preview.");
  saveTwinSkillSession(c.db,{relationshipId:payload.relationshipId,peerNodeId:peer,sourceNodeId:peer,state:"initializing",paused:false,lastSuccess:null,error:null,initialization:JSON.stringify(payload)});
 }
 for(const v of payload.versions)if(v.digest!==null)await cacheTwinBundle(c.db,await fetchBundle(peer,v.name,v.digest),v.digest);
 await recoverTwinSkillApplies(c);
 // Check all unfinished items against the confirmed destination snapshot before changing any.
 const completed=twinSkillVersions(c.db,c.relationshipId);
 for(const v of completed)if(!payload.versions.some(p=>hash(p)===hash(v)))throw error("Destination changed during interrupted initialization. Cancel and preview again.");
 const applied=new Set(completed.map(v=>v.name));
 assertTwinInitializationSnapshot(payload.destination,await withSkillMutation(()=>scanTwinSkills(c)),completed);
 for(const v of payload.versions)if(!applied.has(v.name))await applyTwinSkillVersion({...c,expectedDigest:payload.destination.skills.find(s=>s.name===v.name)?.digest??null,expectedGrants:payload.destination.skills.find(s=>s.name===v.name)?.grants??[]},v);
 assertTwinInitializationSnapshot(payload.destination,await withSkillMutation(()=>scanTwinSkills(c)),payload.versions);
 const session=twinSkillSession(c.db)!;saveTwinSkillSession(c.db,{...session,state:"active",lastSuccess:new Date().toISOString(),error:null});
}
async function finishSourceInitialization(c:TwinSkillContext,session:TwinSkillSession):Promise<void>{
 const payload=initSchema.parse(JSON.parse(session.initialization!));
 await post(session.peerNodeId,"initialize",payload);
 saveTwinSkillSession(c.db,{...session,state:"active",error:null,lastSuccess:new Date().toISOString()});
}
async function reconcileNow():Promise<void>{
 const {context:c,session}=await localContext();if(!session||session.paused)return;
 try{
  await legacyBarrier();
  await c.authorize();
  if(session.state==="initializing"){
   if(session.sourceNodeId===c.localNodeId)await finishSourceInitialization(c,session);
   return;
  }
  await recoverTwinSkillApplies(c);const scan=await localVersions(c);
  const remote:TwinSkillVersion[]=[],remoteConflicts:z.infer<typeof conflictSchema>[]=[];let generation:string|undefined,protectedNames:string[]=[];
  for(let offset=0;;offset+=64){
   const page=z.object({versions:z.array(versionSchema).max(64),generation:z.string(),total:z.number().int().min(0).max(4096),conflicts:z.array(conflictSchema).max(64),conflictTotal:z.number().int().min(0).max(4096),protected:z.array(z.string().max(200)).max(512)}).strict().parse(await post(session.peerNodeId,"manifest",{offset,generation}));
   if(generation&&generation!==page.generation)throw error("Twin inventory changed during exchange; retry later");
   generation=page.generation;protectedNames=page.protected;remote.push(...page.versions);remoteConflicts.push(...page.conflicts);
   if(remote.length>=page.total&&remoteConflicts.length>=page.conflictTotal)break;if(!page.versions.length&&!page.conflicts.length)throw error("Incomplete twin manifest");
  }
  validateVersions(remote,c.localNodeId,session.peerNodeId);
  c.db.prepare("INSERT OR REPLACE INTO twin_skill_peer_protection VALUES(?,?)").run(c.relationshipId,JSON.stringify(protectedNames));
  const protectedSet=new Set([...scan.protected,...protectedNames]);
  for(const offered of remote){
   if(protectedSet.has(offered.name))continue;
   const old=twinSkillVersions(c.db,c.relationshipId).find(v=>v.name===offered.name);
   const merged=old?mergeTwinSkillVersions(old,offered):{active:offered,conflicts:[]};
   if(old&&JSON.stringify(old)===JSON.stringify(merged.active))continue;
   const hashes=new Set([merged.active.digest,...merged.conflicts.map(v=>v.digest)].filter((x):x is string=>x!==null));
   for(const digest of hashes){try{cachedTwinBundle(c.db,digest);}catch{await cacheTwinBundle(c.db,await fetchBundle(session.peerNodeId,offered.name,digest),digest);}}
   // Re-scan after network I/O; newly detected edits must participate in the next merge.
   await localVersions(c);
   const current=twinSkillVersions(c.db,c.relationshipId).find(v=>v.name===offered.name);
   if(JSON.stringify(current)!==JSON.stringify(old))throw error("Local skill changed during exchange; retry later");
   for(const conflict of merged.conflicts)if(conflict.digest)c.db.prepare("INSERT OR IGNORE INTO twin_skill_conflicts(relationship_id,name,digest,version) VALUES(?,?,?,?)").run(c.relationshipId,conflict.name,conflict.digest,JSON.stringify(conflict));
   await applyTwinSkillVersion({...c,expectedVersion:old?JSON.stringify(old):null,expectedDigest:old?.digest??null},merged.active);
  }
  for(const conflict of remoteConflicts){
   const v=conflict.version;if(protectedSet.has(v.name)||v.digest===null)continue;
   validateVersions([v],c.localNodeId,session.peerNodeId);
   if(conflict.resolution){validateVersions([conflict.resolution],c.localNodeId,session.peerNodeId);const resolved=mergeTwinSkillVersions(v,conflict.resolution);if(resolved.conflicts.length||hash(resolved.active)!==hash(conflict.resolution))throw error("Invalid conflict resolution",400);}
   try{cachedTwinBundle(c.db,v.digest);}catch{await cacheTwinBundle(c.db,await fetchBundle(session.peerNodeId,v.name,v.digest),v.digest);}
   c.db.prepare("INSERT INTO twin_skill_conflicts(relationship_id,name,digest,version,resolved,resolution) VALUES(?,?,?,?,?,?) ON CONFLICT(relationship_id,name,digest) DO UPDATE SET resolved=MAX(resolved,excluded.resolved),resolution=COALESCE(excluded.resolution,resolution)").run(c.relationshipId,v.name,v.digest,JSON.stringify(v),Number(Boolean(conflict.resolution)),conflict.resolution?JSON.stringify(conflict.resolution):null);
  }
  await post(session.peerNodeId,"ack",{versions:twinSkillVersions(c.db,c.relationshipId)});
  const current=twinSkillSession(c.db)!;saveTwinSkillSession(c.db,{...current,lastSuccess:new Date().toISOString(),error:null});
 }catch(e){const current=twinSkillSession(c.db);if(current)saveTwinSkillSession(c.db,{...current,error:(e as Error).message});throw e;}
}
let destinationInitialization:{token:string;promise:Promise<void>}|undefined;
function clearInitialization(c:TwinSkillContext,session:TwinSkillSession,token:string):void{
 c.db.exec("SAVEPOINT twin_skill_cancel");
 try{
  c.db.prepare("INSERT OR IGNORE INTO twin_skill_cancelled VALUES(?,?,?)").run(token,session.relationshipId,session.peerNodeId);
  for(const table of ["twin_skill_versions","twin_skill_pending_apply","twin_skill_conflicts","twin_skill_receipts","twin_skill_peer_protection"])c.db.prepare(`DELETE FROM ${table} WHERE relationship_id=?`).run(session.relationshipId);
  c.db.prepare("DELETE FROM twin_skill_session WHERE relationship_id=?").run(session.relationshipId);
  c.db.exec("RELEASE twin_skill_cancel");
 }catch(e){c.db.exec("ROLLBACK TO twin_skill_cancel; RELEASE twin_skill_cancel");throw e;}
}
let reconciliation:Promise<void>|undefined;
export function reconcileTwinSkills():Promise<void>{if(!reconciliation)reconciliation=reconcileNow().finally(()=>{reconciliation=undefined;});return reconciliation;}
export function noteTwinSkillRemoval(db:TwinSkillContext["db"],local:string,name:string):void{
 const session=twinSkillSession(db);if(!session||session.state!=="active")return;
 const old=twinSkillVersions(db,session.relationshipId).find(v=>v.name===name);
 if(old?.digest!==null&&old)saveTwinSkillVersion(db,session.relationshipId,nextSkillVersion(old,local,null));
}
function route(machine:boolean,action:(req:Request,res:Response)=>Promise<unknown>){return(req:Request,res:Response,next:NextFunction)=>{
 void(async()=>{
  if(machine){
   if(res.locals.machineProtocol!==2)throw error("Signed machine authentication required",401);
   const db=await clusterV2Database(),local=await getClusterNode(),peer=res.locals.machineNodeId as string;
   const relationship=assertPeer(db,local.id,peer);checkPartner(twinSkillSession(db),peer,relationship);
  }
  if(req.method==="POST"&&!/\/(?:cancel-initialization|cancel|ack|bundle)$/.test(req.path))await legacyBarrier();
  res.json(await action(req,res));
 })().catch(e=>{if(e instanceof z.ZodError)res.status(400).json({error:"Invalid twin sync request"});else if(e.status)res.status(e.status).json({error:e.message});else next(e);});
};}
export function registerTwinSkillSyncRoutes(ensureLegacyPaused:()=>Promise<void>):void{
 legacyBarrier=ensureLegacyPaused;
 const admin=requireFeature(Feature.SETTINGS);
 app.get("/api/resources/skills/twin-sync",admin,route(false,async()=>{
  const {context:c,session}=await localContext();
  let protectedNames:string[]=[],inventoryError:string|null=null;
  if(session)try{protectedNames=(await withSkillMutation(()=>scanTwinSkills(c))).protected;}catch(e){inventoryError=(e as Error).message;}
  if(session){const row=c.db.prepare("SELECT names FROM twin_skill_peer_protection WHERE relationship_id=?").get(session.relationshipId) as {names:string}|undefined;const initial=session.initialization?initSchema.parse(JSON.parse(session.initialization)):null;protectedNames=[...new Set([...protectedNames,...(row?JSON.parse(row.names):[...(initial?.source.protected??[]),...(initial?.destination.protected??[])])])].sort();}
  return {localNode:{id:c.localNodeId,name:(await getClusterNode()).name},session,protected:protectedNames,inventoryError,pending:session?twinSkillVersions(c.db,session.relationshipId).filter(v=>{const r=c.db.prepare("SELECT version FROM twin_skill_receipts WHERE relationship_id=? AND name=?").get(session.relationshipId,v.name) as {version:string}|undefined;return !r||r.version!==JSON.stringify(v);}).length:0,conflicts:(c.db.prepare("SELECT name,digest,version FROM twin_skill_conflicts WHERE resolved=0").all() as Array<{name:string;digest:string;version:string}>).map(r=>({...r,activeDigest:session?twinSkillVersions(c.db,session.relationshipId).find(v=>v.name===r.name)?.digest??null:null})),twins:listTwinRelationships(c.db,c.localNodeId).filter(r=>r.status==="active").map(r=>({nodeId:r.peer.nodeId,name:replicationPeers(c.db,c.localNodeId).find(p=>p.nodeId===r.peer.nodeId)?.name??r.peer.nodeId,relationshipId:r.relationshipId}))};
 }));
 app.post("/api/resources/skills/twin-sync/preview",admin,route(false,async(req)=>{
  const {peerNodeId}=peerSchema.parse(req.body),{context:c,session}=await localContext(),relationshipId=assertPeer(c.db,c.localNodeId,peerNodeId);
  checkPartner(session,peerNodeId,relationshipId);if(session)throw error("Skill sync is already configured");
  c.relationshipId=relationshipId;
  const source=await withSkillMutation(()=>scanTwinSkills(c));
  const destination=scanSchema.parse(await post(peerNodeId,"snapshot",{relationshipId}));
  const plan=previewTwinInitialization(source,destination),token=randomUUID();
  c.db.prepare("DELETE FROM twin_skill_previews WHERE created_at<?").run(new Date(Date.now()-15*60_000).toISOString());
  c.db.prepare("INSERT INTO twin_skill_previews VALUES(?,?,?,?,?)").run(token,peerNodeId,relationshipId,JSON.stringify({plan,source,destination}),new Date().toISOString());
  return {token,plan,sourceNodeId:c.localNodeId,destinationNodeId:peerNodeId,relationshipId};
 }));
 app.post("/api/resources/skills/twin-sync/initialize",admin,route(false,async(req)=>{
  const {token}=z.object({token:z.string().uuid()}).strict().parse(req.body),{context:c,session}=await localContext();
  const row=c.db.prepare("SELECT peer_node_id peer,relationship_id relationship,plan,created_at created FROM twin_skill_previews WHERE token=?").get(token) as {peer:string;relationship:string;plan:string;created:string}|undefined;
  if(!row||Date.now()-Date.parse(row.created)>15*60_000)throw error("Preview expired. Generate a new preview.");
  if(c.db.prepare("SELECT 1 FROM twin_skill_cancelled WHERE token=?").get(token))throw error("Initialization was cancelled. Generate a new preview.");
  assertPeer(c.db,c.localNodeId,row.peer,row.relationship);checkPartner(session,row.peer,row.relationship);c.relationshipId=row.relationship;
  const stored=JSON.parse(row.plan) as {plan:TwinSkillInitializationPlan;source:TwinSkillScan;destination:TwinSkillScan};
  if(!session){
   const destination=scanSchema.parse(await post(row.peer,"snapshot",{relationshipId:row.relationship}));
   if(destination.digest!==stored.destination.digest)throw error("Destination changed. Generate a new preview.");
   await withSkillMutation(async()=>{
    const source=await scanTwinSkills(c);if(source.digest!==stored.source.digest)throw error("Source changed. Generate a new preview.");
    const versions=[...source.skills.filter(s=>!stored.plan.protected.includes(s.name)).map(s=>nextSkillVersion(undefined,c.localNodeId,s.digest,s.name)),...stored.plan.remove.map(n=>nextSkillVersion(undefined,c.localNodeId,null,n))];
    const payload:Initialization={token,relationshipId:row.relationship,sourceNodeId:c.localNodeId,source,destination:stored.destination,versions};
    beginTwinSkillInitialization(c.db,{relationshipId:row.relationship,peerNodeId:row.peer,sourceNodeId:c.localNodeId,state:"initializing",paused:false,lastSuccess:null,error:null,initialization:JSON.stringify(payload)},versions);
   });
  }else if(initSchema.parse(JSON.parse(session.initialization!)).token!==token)throw error("Another initialization is already recorded");
  await reconcileTwinSkills();return {session:twinSkillSession(c.db)};
 }));
 app.post("/api/resources/skills/twin-sync/refresh",admin,route(false,async(req)=>{z.object({}).strict().parse(req.body);await reconcileTwinSkills();return {session:twinSkillSession((await localContext()).context.db)};}));
 app.put("/api/resources/skills/twin-sync",admin,route(false,async(req)=>{const {paused}=z.object({paused:z.boolean()}).strict().parse(req.body),{context:c,session}=await localContext();if(!session)throw error("Sync is not initialized");await c.authorize();saveTwinSkillSession(c.db,{...session,paused});return {session:twinSkillSession(c.db)};}));
 app.post("/api/resources/skills/twin-sync/cancel-initialization",admin,route(false,async(req)=>{
  z.object({}).strict().parse(req.body);await reconciliation?.catch(()=>{});
  const {context:c,session}=await localContext();
  if(!session||session.state!=="initializing"||session.sourceNodeId!==c.localNodeId)throw error("Only the source can cancel a pending initialization");
  await c.authorize();const {token}=initSchema.parse(JSON.parse(session.initialization!));
  // An uncertain cancellation stays paused, so background refresh cannot replay the old plan.
  saveTwinSkillSession(c.db,{...session,paused:true,error:"Initialization cancellation pending"});
  const result=z.object({active:z.boolean()}).strict().parse(await post(session.peerNodeId,"cancel",{token}));
  if(result.active){await finishSourceInitialization(c,{...session,paused:false});return {session:twinSkillSession(c.db)};}
  clearInitialization(c,session,token);return {cancelled:true};
 }));
 app.post("/api/resources/skills/twin-sync/resolve",admin,route(false,async(req)=>{
  const {name,digest}=z.object({name:z.string().max(200),digest:z.string().regex(/^[a-f0-9]{64}$/).nullable()}).strict().parse(req.body),{context:c,session}=await localContext();
  if(!session||session.state!=="active")throw error("Sync is not active");await c.authorize();await recoverTwinSkillApplies(c);await localVersions(c);
  const prior=twinSkillVersions(c.db,c.relationshipId).find(v=>v.name===name);if(!prior)throw error("Unknown skill",404);
  const conflict=c.db.prepare("SELECT 1 FROM twin_skill_conflicts WHERE relationship_id=? AND name=? AND digest=?").get(c.relationshipId,name,digest??"");
  if(digest!==prior.digest&&!conflict)throw error("Unknown conflict copy",404);
  const version=nextSkillVersion(prior,c.localNodeId,digest);
  await applyTwinSkillVersion({...c,expectedVersion:JSON.stringify(prior),expectedDigest:prior.digest},version);
  c.db.prepare("UPDATE twin_skill_conflicts SET resolved=1,resolution=? WHERE relationship_id=? AND name=?").run(JSON.stringify(version),c.relationshipId,name);
  return {version};
 }));
 for(const operation of ["snapshot","initialize","manifest","bundle","ack","cancel"]){
  app.post(PREFIX+operation,route(true,async(req,res)=>{
   const peer=res.locals.machineNodeId as string,{context:c,session}=await localContext(),relationshipId=assertPeer(c.db,c.localNodeId,peer);
   checkPartner(session,peer,relationshipId);c.relationshipId=relationshipId;c.sourceNodeId=session?.sourceNodeId??peer;c.authorize=()=>{assertPeer(c.db,c.localNodeId,peer,relationshipId);};
   if(operation==="snapshot"){
    z.object({relationshipId:z.literal(relationshipId)}).strict().parse(req.body);if(session)throw error("Skill sync is already configured");return withSkillMutation(()=>scanTwinSkills(c));
   }
   if(operation==="initialize"){
    const payload=initSchema.parse(req.body);if(payload.relationshipId!==relationshipId)throw error("Wrong relationship",403);
    if(destinationInitialization&&destinationInitialization.token!==payload.token)throw error("Another initialization is in progress");
    if(!destinationInitialization){const promise=initializeDestination(c,payload,peer).finally(()=>{destinationInitialization=undefined;});destinationInitialization={token:payload.token,promise};}
    await destinationInitialization.promise;return {ok:true};
   }
   if(operation==="cancel"){
    const {token}=z.object({token:z.string().uuid()}).strict().parse(req.body);await destinationInitialization?.promise.catch(()=>{});
    const current=twinSkillSession(c.db);
    if(!current){c.db.prepare("INSERT OR IGNORE INTO twin_skill_cancelled VALUES(?,?,?)").run(token,relationshipId,peer);return {active:false};}
    if(current.sourceNodeId!==peer||initSchema.parse(JSON.parse(current.initialization!)).token!==token)throw error("Wrong initialization cancellation",403);
    if(current.state==="active")return {active:true};
    await withSkillMutation(async()=>{clearInitialization(c,current,token);});return {active:false};
   }
   if(!session)throw error("Skill sync is not initialized");
   if(operation==="ack"){
    const {versions}=z.object({versions:z.array(versionSchema).max(4096)}).strict().parse(req.body);validateVersions(versions,c.localNodeId,peer);
    for(const v of versions)c.db.prepare("INSERT OR REPLACE INTO twin_skill_receipts VALUES(?,?,?)").run(relationshipId,v.name,JSON.stringify(v));return {ok:true};
   }
   if(operation==="bundle"){
    const {name,digest}=z.object({name:z.string().max(200),digest:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.body);
    const eligible=await withSkillMutation(()=>scanTwinSkills(c));
    if(eligible.protected.includes(name))throw error("This skill is protected or outside the twin sync scope",403);
    const known=twinSkillVersions(c.db,relationshipId).some(v=>v.name===name&&v.digest===digest)||Boolean(c.db.prepare("SELECT 1 FROM twin_skill_conflicts WHERE relationship_id=? AND name=? AND digest=?").get(relationshipId,name,digest));
    if(!known)throw error("Unknown skill version",404);return {bundle:cachedTwinBundle(c.db,digest)};
   }
   if(session.state!=="active"||session.paused)throw error("Twin sync is paused or initializing");
   const {offset,generation}=z.object({offset:z.number().int().min(0).max(4096),generation:z.string().optional()}).strict().parse(req.body);
   await recoverTwinSkillApplies(c);const scan=await localVersions(c);
   const versions=twinSkillVersions(c.db,relationshipId).filter(v=>!scan.protected.includes(v.name));
   const conflicts=(c.db.prepare("SELECT version,resolution FROM twin_skill_conflicts WHERE relationship_id=? ORDER BY name,digest").all(relationshipId) as Array<{version:string;resolution:string|null}>).map(r=>({version:JSON.parse(r.version),resolution:r.resolution?JSON.parse(r.resolution):null}));
   if(versions.length>4096||conflicts.length>4096)throw error("Twin history exceeds protocol limit",413);
   const current=hash({versions,conflicts,protected:scan.protected});if(generation&&current!==generation)throw error("Inventory changed during pagination");
   return {versions:versions.slice(offset,offset+64),generation:current,total:versions.length,conflicts:conflicts.slice(offset,offset+64),conflictTotal:conflicts.length,protected:scan.protected};
  }));
 }
}
