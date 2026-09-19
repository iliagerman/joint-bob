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
  response.json({relationshipId,status:"revoked",pending:result.pending});
}));
app.post("/api/cluster/v2/twins/certificate",handler(async(request,response)=>{
  if(!await selectiveSharingActive()) throw new ClusterV2HttpError(409,"Selective sharing is not active");
  const sender=machineOnly(response),certificate=twinCertificateSchema.parse(z.object({certificate:twinCertificateSchema}).strict().parse(request.body).certificate);
  const local=await getClusterNode();
  const other=certificate.body.inviter.nodeId===local.id?certificate.body.acceptor.nodeId:certificate.body.inviter.nodeId;
  if(sender!==other) throw new ClusterV2HttpError(403,"Forbidden");
  const db=await clusterV2Database();ensureTwinHttpSchema(db);transaction(db,()=>{applyTwinCertificate(db,local.id,certificate);bootstrapOwnedTwinPolicies(db,local.id);});
  response.json({ok:true});
}));
app.post("/api/cluster/v2/twins/revocation",handler(async(request,response)=>{
  if(!await selectiveSharingActive()) throw new ClusterV2HttpError(409,"Selective sharing is not active");
  const sender=machineOnly(response),revocation=twinRevocationSchema.parse(z.object({revocation:twinRevocationSchema}).strict().parse(request.body).revocation);
  if(sender!==revocation.signerNodeId) throw new ClusterV2HttpError(403,"Forbidden");
  const local=await getClusterNode(),db=await clusterV2Database();ensureTwinHttpSchema(db);
  applyRemoteTwinRevocation(db,local.id,revocation);response.json({ok:true});
}));
