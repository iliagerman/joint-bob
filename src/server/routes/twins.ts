import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { getClusterNode } from "../../cluster.js";
import { applyTwinCertificate, listTwinRelationships, twinCertificateSchema, twinRevocationSchema } from "../../cluster-twins.js";
import { clusterV2Database } from "../../cluster-v2-store.js";
import { ClusterV2HttpError, selectiveSharingActive } from "../../cluster-v2-mode.js";
import {
  acceptTwinHttpLink, applyRemoteTwinRevocation, bootstrapOwnedTwinPolicies,
  createTwinHttpInvitation, ensureTwinHttpSchema, mapTwinError, pendingTwinDeliveries,
  revokeTwinHttp,
} from "../twins.js";
import { app } from "../state.js";
import { disconnectRevokedRuntimeSockets } from '../runtime-peers.js';
import { receiveScopedCredentials } from "../scoped-credentials.js";
import { sharedTranscriptFile, sharedTranscriptInventory, transcriptQuery } from "../shared-transcripts.js";
import { receiveFileEnrollment } from "../sharing-files.js";
import { isTrustedTwin } from "../../cluster-sharing-policy.js";
import { receiveSecretCredentialEvents, type SecretCredentialEvent } from "../../secret-replication.js";
import { secretCredentialBatchSchema } from "../schemas.js";
import { adoptionInventory, adoptionInventorySchema, adoptTwinProjects, completeTwinSharing, localTwinSharingStatus, resumeTwinProjectFolders, scheduleTwinSharing, sharingTwin, twinSharingStatus } from "../twin-sharing.js";

const uuid = z.string().uuid().regex(/^[0-9a-f-]+$/);
function localOnly(response:Response):void { if(!response.locals.authSession) throw new ClusterV2HttpError(401,"Unauthorized"); }
function machineOnly(response:Response):string { if(response.locals.machineProtocol!==2||typeof response.locals.machineNodeId!=="string") throw new ClusterV2HttpError(401,"Unauthorized"); return response.locals.machineNodeId as string; }
function handler(action:(request:Request,response:Response)=>Promise<void>):(request:Request,response:Response,next:NextFunction)=>void {
  return (request,response,next)=>{void action(request,response).catch(error=>mapTwinError(error,response,next));};
}
function transaction(db:Awaited<ReturnType<typeof clusterV2Database>>,action:()=>void):void {
  db.exec("SAVEPOINT twin_route_write");
  try{action();db.exec("RELEASE twin_route_write");}
  catch(error){db.exec("ROLLBACK TO twin_route_write; RELEASE twin_route_write");throw error;}
}

app.post("/api/cluster/v2/twins/sharing-inventory",handler(async(request,response)=>{
  const payload=z.object({relationshipId:uuid}).strict().parse(request.body),sender=machineOnly(response),local=await getClusterNode(),db=await clusterV2Database();
  if(sharingTwin(db,local.id,payload.relationshipId)!==sender)throw new ClusterV2HttpError(403,'Forbidden');
  response.json({projects:adoptionInventory(db)});
}));

app.post("/api/cluster/v2/twins/sharing-status",handler(async(request,response)=>{
  const payload=z.object({relationshipId:uuid}).strict().parse(request.body),sender=machineOnly(response),local=await getClusterNode(),db=await clusterV2Database();
  if(sharingTwin(db,local.id,payload.relationshipId)!==sender)throw new ClusterV2HttpError(403,'Forbidden');
  response.json(await localTwinSharingStatus(db,local.id,payload.relationshipId));
}));

app.post("/api/cluster/v2/credentials/scoped",handler(async(request,response)=>{
  await receiveScopedCredentials(machineOnly(response),request.body);response.json({ok:true});
}));

app.get("/api/cluster/v2/transcripts",handler(async(request,response)=>{
  const query=transcriptQuery.parse(request.query);
  response.json({entries:await sharedTranscriptInventory(machineOnly(response),query.projectId)});
}));
app.get("/api/cluster/v2/transcripts/file",handler(async(request,response)=>{
  const query=transcriptQuery.required().parse(request.query);
  response.sendFile(await sharedTranscriptFile(machineOnly(response),query.projectId,query.engine,query.sessionId));
}));

app.post("/api/cluster/v2/twins/credentials",handler(async(request,response)=>{
  const sender=machineOnly(response),local=await getClusterNode(),db=await clusterV2Database();
  if(!isTrustedTwin(db,local.id,sender)) throw new ClusterV2HttpError(403,"Forbidden");
  const payload=secretCredentialBatchSchema.parse(request.body);
  if(payload.events.some(event=>event.originNodeId!==sender)) throw new ClusterV2HttpError(403,"Credential origin does not match authenticated peer");
  response.json({received:await receiveSecretCredentialEvents(payload.events as SecretCredentialEvent[])});
}));

app.post("/api/cluster/v2/files/enroll",handler(async(request,response)=>{
  response.json(await receiveFileEnrollment(machineOnly(response),request.body));
}));

app.get("/api/twins/:relationshipId/sharing",handler(async(request,response)=>{
  localOnly(response);
  response.json(await twinSharingStatus(await clusterV2Database(),(await getClusterNode()).id,uuid.parse(request.params.relationshipId)));
}));
app.post("/api/twins/:relationshipId/sharing",handler(async(request,response)=>{
  localOnly(response);
  const payload=z.object({ownerNodeId:uuid,confirmOwnedData:z.literal(true)}).strict().parse(request.body);
  response.json(await completeTwinSharing(uuid.parse(request.params.relationshipId),payload.ownerNodeId));
}));
app.post('/api/cluster/v2/twins/sharing-coordinate',handler(async(request,response)=>{
  const sender=machineOnly(response),local=await getClusterNode(),db=await clusterV2Database();
  const payload=z.object({relationshipId:uuid,ownerNodeId:uuid.optional()}).strict().parse(request.body);
  if(sharingTwin(db,local.id,payload.relationshipId)!==sender||local.id>sender)throw new ClusterV2HttpError(403,'Forbidden');
  response.json(await completeTwinSharing(payload.relationshipId,payload.ownerNodeId));
}));
app.post("/api/cluster/v2/twins/sharing",handler(async(request,response)=>{
  const sender=machineOnly(response),local=await getClusterNode(),db=await clusterV2Database();
  const payload=z.object({relationshipId:uuid,ownerNodeId:uuid,projects:adoptionInventorySchema}).strict().parse(request.body);
  if(sharingTwin(db,local.id,payload.relationshipId)!==sender||sender>local.id) throw new ClusterV2HttpError(403,"Forbidden");
  adoptTwinProjects(db,local.id,payload.relationshipId,payload.ownerNodeId,payload.projects);
  await resumeTwinProjectFolders(db,payload.relationshipId);
  response.json({projects:adoptionInventory(db)});
}));

app.post("/api/twins/invitations",handler(async(request,response)=>{
  localOnly(response); z.object({confirmOwnedData:z.literal(true)}).strict().parse(request.body);
  response.status(201).json(await createTwinHttpInvitation());
}));
app.post("/api/twins/accept",handler(async(request,response)=>{
  localOnly(response); const payload=z.object({link:z.string().max(32768),confirmOwnedData:z.literal(true)}).strict().parse(request.body);
  response.status(201).json(await acceptTwinHttpLink(payload.link));
}));
app.get("/api/twins",handler(async(_request,response)=>{
  localOnly(response); const local=await getClusterNode(),db=await clusterV2Database();ensureTwinHttpSchema(db);
  response.json({relationships:listTwinRelationships(db,local.id).map(item=>({...item,pendingDeliveries:pendingTwinDeliveries(db,item.relationshipId)}))});
}));
app.delete("/api/twins/:relationshipId",handler(async(request,response)=>{
  localOnly(response); const local=await getClusterNode(),db=await clusterV2Database(),relationshipId=uuid.parse(request.params.relationshipId);
  const result=revokeTwinHttp(db,local.id,relationshipId);
  await disconnectRevokedRuntimeSockets();
  response.json({relationshipId,status:"revoked",pending:result.pending});
}));
app.post("/api/cluster/v2/twins/certificate",handler(async(request,response)=>{
  if(!await selectiveSharingActive()) throw new ClusterV2HttpError(409,"Selective sharing is not active");
  const sender=machineOnly(response),certificate=twinCertificateSchema.parse(z.object({certificate:twinCertificateSchema}).strict().parse(request.body).certificate);
  const local=await getClusterNode();
  const other=certificate.body.inviter.nodeId===local.id?certificate.body.acceptor.nodeId:certificate.body.inviter.nodeId;
  if(sender!==other) throw new ClusterV2HttpError(403,"Forbidden");
  const db=await clusterV2Database();ensureTwinHttpSchema(db);transaction(db,()=>{applyTwinCertificate(db,local.id,certificate);bootstrapOwnedTwinPolicies(db,local.id);scheduleTwinSharing(db,certificate.body.relationshipId);});
  response.json({ok:true});
}));
app.post("/api/cluster/v2/twins/revocation",handler(async(request,response)=>{
  if(!await selectiveSharingActive()) throw new ClusterV2HttpError(409,"Selective sharing is not active");
  const sender=machineOnly(response),revocation=twinRevocationSchema.parse(z.object({revocation:twinRevocationSchema}).strict().parse(request.body).revocation);
  if(sender!==revocation.signerNodeId) throw new ClusterV2HttpError(403,"Forbidden");
  const local=await getClusterNode(),db=await clusterV2Database();ensureTwinHttpSchema(db);
  applyRemoteTwinRevocation(db,local.id,revocation);await disconnectRevokedRuntimeSockets();response.json({ok:true});
}));
