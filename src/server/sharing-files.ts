import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { signClusterRequest } from "../cluster-protocol.js";
import { mayReceiveResource } from "../cluster-sharing-policy.js";
import { ClusterV2HttpError, selectiveSharingActive } from "../cluster-v2-mode.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { clearHarnessSessionCache, listHarnessSyncFolders } from "../harnesses.js";
import { getProject, updateProjectSyncFolderId } from "../store.js";
import { ensureSyncthingDevice, ensureSharedProjectFolder, removeSyncthingDevices, pauseSyncthingFolders, syncthingDeviceId, syncthingPeerCaughtUp } from "../syncthing.js";
import { expectedTaskWorkspacePath, projectTicketSyncFolderId, TICKET_WORKSPACE_FOLDER_ID } from "../task-workspaces.js";
import { replicationPeers } from "./replication-v2.js";

const deviceId=z.string().regex(/^[A-Z2-7]{7}(?:-[A-Z2-7]{7}){7}$/);
export const fileEnrollmentSchema=z.object({deviceId,projects:z.array(z.string().min(1).max(300)).max(10000),
 locations:z.array(z.object({projectId:z.string().min(1).max(300),path:z.string().min(1).max(4096)}).strict()).max(10000)}).strict();
function projectLocations(db:DatabaseSync,ids:string[]):Array<{projectId:string;path:string}>{
 const lookup=db.prepare("SELECT id projectId,path FROM projects WHERE id=?");
 return ids.flatMap(id=>{const row=lookup.get(id) as {projectId:string;path:string}|undefined;return row?[row]:[];});
}
function receiveLocations(db:DatabaseSync,local:string,peer:string,locations:Array<{projectId:string;path:string}>):void{
 const save=db.prepare("INSERT INTO project_locations VALUES(?,?,?) ON CONFLICT(project_id,node_id) DO UPDATE SET path=excluded.path");
 for(const location of locations){
  if(!mayShareProject(db,local,peer,location.projectId))throw new ClusterV2HttpError(403,"Project is not shared with this node");
  if(!db.prepare("SELECT 1 FROM projects WHERE id=?").get(location.projectId))continue;
  save.run(location.projectId,peer,location.path);clearHarnessSessionCache(location.projectId);
 }
}
function ensureSchema(db:DatabaseSync):void {
 db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_file_enrollments(peer_id TEXT NOT NULL,device_id TEXT NOT NULL,folder_id TEXT NOT NULL,project_id TEXT,PRIMARY KEY(peer_id,folder_id));
 CREATE TABLE IF NOT EXISTS cluster_v2_file_errors(peer_id TEXT PRIMARY KEY,error TEXT NOT NULL)`);
}
export function mayShareProject(db:DatabaseSync,local:string,peer:string,id:string):boolean {
 const policy=db.prepare("SELECT deleted FROM cluster_v2_resource_policy WHERE kind='project' AND resource_id=?").get(id) as {deleted:number}|undefined;
 return Boolean(policy&&!policy.deleted&&mayReceiveResource(db,local,"project",id)&&mayReceiveResource(db,peer,"project",id));
}
export function sharedProjectIds(db:DatabaseSync,local:string,peer:string):string[]{
 const rows=db.prepare("SELECT resource_id id FROM cluster_v2_resource_policy WHERE kind='project' AND deleted=0").all() as unknown as Array<{id:string}>;
 return rows.filter(p=>mayShareProject(db,local,peer,p.id)).map(p=>p.id);
}
async function enroll(db:DatabaseSync,local:string,peer:string,device:string,ids:string[]):Promise<string[]> {
 ensureSchema(db);
 await ensureSyncthingDevice(device,peer);
 await removeSyncthingDevices([device],[TICKET_WORKSPACE_FOLDER_ID,...listHarnessSyncFolders().map(folder=>folder.id)]);
 db.prepare("DELETE FROM cluster_v2_file_enrollments WHERE peer_id=? AND project_id IS NULL").run(peer);
 const save=db.prepare("INSERT OR REPLACE INTO cluster_v2_file_enrollments VALUES(?,?,?,?)");
 const accepted:string[]=[];
 for(const id of ids){
  if(!mayShareProject(db,local,peer,id))continue;
  const project=await getProject(id);if(!project)continue;
  const folder=project.syncFolderId??`joint-bob-project-${createHash('sha256').update(id).digest('hex')}`;
  await mkdir(project.path,{recursive:true});
  await ensureSharedProjectFolder(folder,project.name,project.path,device);
  db.prepare("DELETE FROM cluster_v2_file_enrollments WHERE peer_id=? AND project_id=? AND folder_id<>?").run(peer,id,folder);
  if(!project.syncFolderId)await updateProjectSyncFolderId(id,folder);
  save.run(peer,device,folder,id);accepted.push(id);
  const ticketPath=path.dirname(expectedTaskWorkspacePath(id,'sharing'));
  await mkdir(ticketPath,{recursive:true});
  const ticketFolder=projectTicketSyncFolderId(id);
  await ensureSharedProjectFolder(ticketFolder,`${project.name} tickets`,ticketPath,device);
  save.run(peer,device,ticketFolder,id);
 }
 db.prepare("DELETE FROM cluster_v2_file_errors WHERE peer_id=?").run(peer);
 return accepted;
}
export async function receiveFileEnrollment(peer:string,input:unknown){
 const payload=fileEnrollmentSchema.parse(input),db=await clusterV2Database(),local=await getClusterNode();
 if(!replicationPeers(db,local.id).some(p=>p.nodeId===peer))throw new ClusterV2HttpError(403,"Forbidden");
 if(payload.projects.some(id=>!mayShareProject(db,local.id,peer,id)))throw new ClusterV2HttpError(403,"Project is not shared with this node");
 const device=await syncthingDeviceId();if(!device)throw new ClusterV2HttpError(409,"Syncthing is not configured on this node");
 receiveLocations(db,local.id,peer,payload.locations);
 const projects=await enroll(db,local.id,peer,payload.deviceId,payload.projects);
 return {deviceId:device,projects,locations:projectLocations(db,projects)};
}
async function revokeFiles(db:DatabaseSync,local:string):Promise<void>{
 const rows=db.prepare("SELECT peer_id,device_id,folder_id,project_id FROM cluster_v2_file_enrollments").all() as unknown as Array<{peer_id:string;device_id:string;folder_id:string;project_id:string|null}>;
 for(const row of rows){
  if(row.project_id&&mayShareProject(db,local,row.peer_id,row.project_id))continue;
  await removeSyncthingDevices([row.device_id],[row.folder_id]);
  db.prepare("DELETE FROM cluster_v2_file_enrollments WHERE peer_id=? AND folder_id=?").run(row.peer_id,row.folder_id);
 }
}
export async function sharingFilesStatus(db:DatabaseSync,local:string,peer:string):Promise<{ready:boolean;error?:string}>{
 ensureSchema(db);
 const error=db.prepare("SELECT error FROM cluster_v2_file_errors WHERE peer_id=?").get(peer) as {error:string}|undefined;
 if(error)return {ready:false,error:error.error};
 const rows=db.prepare("SELECT device_id,folder_id,project_id FROM cluster_v2_file_enrollments WHERE peer_id=?").all(peer) as unknown as Array<{device_id:string;folder_id:string;project_id:string|null}>;
 if(!rows.length||sharedProjectIds(db,local,peer).some(id=>!rows.some(row=>row.project_id===id)))return {ready:false};
 try{return {ready:await syncthingPeerCaughtUp(rows[0].device_id,rows.map(row=>row.folder_id))};}
 catch(error){return {ready:false,error:error instanceof Error?error.message:"Syncthing status unavailable"};}
}

export async function flushSharingFiles():Promise<void>{
 if(!await selectiveSharingActive())return;
 const db=await clusterV2Database(),local=await getClusterNode();ensureSchema(db);
 await revokeFiles(db,local.id);
 const device=await syncthingDeviceId();
 if(device)await pauseSyncthingFolders([TICKET_WORKSPACE_FOLDER_ID,...listHarnessSyncFolders().map(folder=>folder.id)]);
 for(const peer of replicationPeers(db,local.id))try{
  if(!device)throw new Error("Syncthing is not configured on this node");
  const projects=sharedProjectIds(db,local.id,peer.nodeId);
  const target="/api/cluster/v2/files/enroll",body=Buffer.from(JSON.stringify({deviceId:device,projects,locations:projectLocations(db,projects)}));
  const response=await fetch(new URL(target,peer.url),{method:"POST",redirect:"error",signal:AbortSignal.timeout(10000),body,
   headers:{"Content-Type":"application/json",Authorization:signClusterRequest(db,local.id,peer.nodeId,"POST",target,body)}});
  if(!response.ok)throw new Error(`File enrollment rejected (${response.status})`);
  const payload=fileEnrollmentSchema.parse(await response.json());
  receiveLocations(db,local.id,peer.nodeId,payload.locations);
  await enroll(db,local.id,peer.nodeId,payload.deviceId,payload.projects);
 }catch(error){db.prepare("INSERT OR REPLACE INTO cluster_v2_file_errors VALUES(?,?)").run(peer.nodeId,error instanceof Error?error.message:"File enrollment failed");}
}
