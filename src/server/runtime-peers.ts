import type { NextFunction, Request, Response } from "express";
import type WebSocket from 'ws';
import { type ClusterPeer, getClusterNode, listClusterPeers } from "../cluster.js";
import { signClusterRequest, verifyClusterRequest } from "../cluster-protocol.js";
import { getOrCreateClusterIdentity, pinClusterPublicKey } from "../cluster-identity.js";
import { machineRoutes } from "./state.js";
import { isTrustedTwin } from "../cluster-sharing-policy.js";
import type { DatabaseSync } from "node:sqlite";
import { ensureConversationRecordSchema } from "../conversation-records.js";
import { getTaskHandoff } from "../tasks.js";
import { mayShareProject, sharedProjectIds } from "./sharing-files.js";
import { selectiveSharingActive } from "../cluster-v2-mode.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { replicationPeers } from "./replication-v2.js";

const runtimeSockets=new Map<WebSocket,{peer:string;projectId:string}>();
export function trackRuntimeSocket(socket:WebSocket,peer:string,projectId:string):void{
 runtimeSockets.set(socket,{peer,projectId});socket.once('close',()=>runtimeSockets.delete(socket));
}
export async function disconnectRevokedRuntimeSockets():Promise<void>{
 if(!await selectiveSharingActive())return;
 const db=await clusterV2Database(),local=await getClusterNode();
 for(const [socket,scope]of runtimeSockets)if(scope.peer!==local.id&&!mayShareProject(db,local.id,scope.peer,scope.projectId))socket.close(1008,'Project sharing was revoked');
}

export async function listRuntimePeers(projectId?:string): Promise<ClusterPeer[]> {
 if(!await selectiveSharingActive())return listClusterPeers();
 const db=await clusterV2Database(),local=await getClusterNode();
 return replicationPeers(db,local.id).filter(peer=>projectId?mayShareProject(db,local.id,peer.nodeId,projectId):isTrustedTwin(db,local.id,peer.nodeId)||sharedProjectIds(db,local.id,peer.nodeId).length>0).map(peer=>{
  const activity=db.prepare('SELECT created_at,updated_at,last_seen_at FROM cluster_v2_peer_activity WHERE node_id=?').get(peer.nodeId) as {created_at:string;updated_at:string;last_seen_at:string|null};
  return {id:peer.nodeId,name:peer.name,url:peer.url,token:'',signedAuthentication:true,
   createdAt:activity.created_at,updatedAt:activity.updated_at,pairedAt:activity.created_at,lastSeenAt:activity.last_seen_at,invitedByNodeId:null};
 });
}
export async function getRuntimePeer(id:string):Promise<ClusterPeer|undefined>{return (await listRuntimePeers()).find(peer=>peer.id===id);}

export async function runtimeFetch(input:string|URL,init:RequestInit={}):Promise<globalThis.Response>{
 if(!await selectiveSharingActive())return globalThis.fetch(input,init);
 const url=new URL(input),peer=(await listRuntimePeers()).find(peer=>new URL(peer.url).origin===url.origin);
 if(!peer||!url.pathname.startsWith("/api/cluster/"))throw new Error("No authorized runtime peer for request");
 url.pathname=url.pathname.replace("/api/cluster/","/api/cluster/v2/runtime/");
 const local=await getClusterNode(),db=await clusterV2Database(),method=init.method??"GET";
 if(init.body!==undefined&&typeof init.body!=="string")throw new Error("Runtime requests require a serialized JSON body");
 let serialized=init.body??"";
 if(url.pathname.endsWith('/sessions/runtime-snapshot')){
  const snapshot=JSON.parse(serialized) as {leases:Array<{engine:string;sessionId:string}>};
  snapshot.leases=snapshot.leases.filter(lease=>sessionShared(db,local.id,peer.id,lease.engine,lease.sessionId));
  serialized=JSON.stringify(snapshot);init={...init,body:serialized};
 }
 const body=Buffer.from(serialized),headers=new Headers(init.headers);
 headers.set("Authorization",signClusterRequest(db,local.id,peer.id,method,url.pathname+url.search,body));
 return globalThis.fetch(url,{...init,headers,redirect:"error"});
}

function sessionShared(db:DatabaseSync,local:string,peer:string,engine:unknown,sessionId:unknown):boolean{
 if(typeof engine!=='string'||typeof sessionId!=='string')return false;
 ensureConversationRecordSchema(db);
 const rows=db.prepare('SELECT DISTINCT project_id FROM conversation_records WHERE engine=? AND session_id=?').all(engine,sessionId) as unknown as Array<{project_id:string}>;
 return rows.length===1&&mayShareProject(db,local,peer,rows[0].project_id);
}
async function runtimeAllowed(request:Request,db:DatabaseSync,local:string,peer:string):Promise<boolean>{
 const body=request.body as {projectId?:unknown;handoffId?:unknown;record?:{engine?:unknown;sessionId?:unknown};leases?:Array<{engine:unknown;sessionId:unknown}>}|undefined;
 if(request.path.startsWith('/browser/'))return request.path==='/browser/config'?isTrustedTwin(db,local,peer):true;
 if(request.path==='/background-tasks')return true;
 if(request.path==='/sessions/runtime-snapshot')return Array.isArray(body?.leases)&&body.leases.every((lease:{engine:unknown;sessionId:unknown})=>sessionShared(db,local,peer,lease.engine,lease.sessionId));
 if(request.path==='/sessions/ownership')return sessionShared(db,local,peer,request.query.engine,request.query.sessionId);
 if(request.path==='/sessions/ownership/apply')return sessionShared(db,local,peer,body?.record?.engine,body?.record?.sessionId);
 if(['/tasks/status','/tasks/commit','/tasks/settle','/tasks/abort'].includes(request.path)){
  if(typeof body?.handoffId!=='string')return false;
  const handoff=await getTaskHandoff(body.handoffId);return Boolean(handoff&&mayShareProject(db,local,peer,handoff.projectId));
 }
 const id=typeof request.query.projectId==='string'?request.query.projectId:body?.projectId;
 return typeof id==='string'&&mayShareProject(db,local,peer,id);
}
export function dispatchSignedRuntime(request:Request,response:Response,next:NextFunction):void{
 const prefix='/api/cluster/v2/runtime/';
 if(!request.path.startsWith(prefix)){next();return;}
 const suffix=request.path.slice(prefix.length),target='/cluster/'+suffix;
 if(!/^(tasks\/|sessions\/|browser\/|git\/|projects\/presence$|project-file|project-files$|cron$|quick-notes\/prepare$|background-tasks$)/.test(suffix)||!machineRoutes.has(`${request.method} ${target}`)){
  response.status(404).json({error:'Unsupported signed runtime route'});return;
 }
 request.url=request.url.replace(prefix,'/api/cluster/');next();
}

export async function runtimeSocketHeaders(peerId:string,url:URL,legacyToken:string):Promise<{Authorization:string}>{
 if(!await selectiveSharingActive())return {Authorization:`Bearer ${legacyToken}`};
 const db=await clusterV2Database(),local=await getClusterNode();
 if(peerId!==local.id&&!replicationPeers(db,local.id).some(peer=>peer.nodeId===peerId))throw new Error('Runtime peer is no longer authorized');
 return {Authorization:signClusterRequest(db,local.id,peerId,'GET',url.pathname+url.search,Buffer.alloc(0))};
}
export async function signedSocketPeer(target:string,authorization:string):Promise<string>{
 const db=await clusterV2Database(),local=await getClusterNode(),identity=getOrCreateClusterIdentity(db,local.id);
 pinClusterPublicKey(db,local.id,identity.publicKey);
 const peer=verifyClusterRequest(db,local.id,'GET',target,Buffer.alloc(0),authorization);
 if(peer!==local.id&&!replicationPeers(db,local.id).some(row=>row.nodeId===peer))throw new Error('Runtime peer is no longer authorized');
 return peer;
}

export async function twinRuntimeGuard(request:Request,response:Response,next:NextFunction):Promise<void>{
 try{
  const db=await clusterV2Database(),local=await getClusterNode(),peer=response.locals.machineNodeId;
  if(response.locals.machineProtocol!==2||!replicationPeers(db,local.id).some(row=>row.nodeId===peer)||!await runtimeAllowed(request,db,local.id,peer)){
   response.status(403).json({error:"Runtime resource is not shared with this node"});return;
  }
  next();
 }catch(error){next(error);}
}
