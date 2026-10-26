import { createHash } from "node:crypto";
import { mkdir, readdir, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { signClusterRequest } from "../cluster-protocol.js";
import { mayReceiveResource } from "../cluster-sharing-policy.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { clearHarnessSessionCache, listHarnessSyncFolders } from "../harnesses.js";
import { getProject, updateProjectPath, updateProjectSyncFolderId } from "../store.js";
import type { ProjectRecord } from "../types.js";
import { ensureSyncthingDevice, ensureSharedProjectFolder, listSyncthingFolders, removeSyncthingDevices, pauseSyncthingFolders, syncthingConnectionGeneration, syncthingDeviceId, syncthingPeerCaughtUp } from "../syncthing.js";
import { expectedTaskWorkspacePath, projectTicketSyncFolderId, TICKET_WORKSPACE_FOLDER_ID } from "../task-workspaces.js";
import { replicationPeers } from "./replication-v2.js";
import { peerAway } from "../peer-presence.js";
import { projectWorktreeRoot, projectWorktreeSyncFolderId } from "../project-worktrees.js";
import { WORKTREE_FOLDER_PREFIX } from "../worktree-filters.js";
import { peerFetch } from "../relay/transport.js";
import { notifyRelayPeersChanged } from "../relay/events.js";
import { listPhases, projectFilesOnSyncthing, projectInsideBuiltin, whileFilesOnSyncthing, withProjectFilesLock } from "../file-sync/control.js";

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
 // Whatever this enrollment changes, relay-reached peers get their Syncthing tunnels re-planned.
 try{return await enrollFiles(db,local,peer,device,ids);}finally{notifyRelayPeersChanged();}
}
const reportedSkips=new Map<string,string>();
/* fix: a project received from its owner can get a new, empty folder here while Syncthing already syncs it into another
   one (accepted before the project came). Every enrollment then refused it ("different local path"), the project
   showed no files, and built-in sync compared the empty folder. While its own folder holds nothing, the project takes
   Syncthing's, unless another project lies inside or around that one. */
async function adoptSyncthingFolder(db:DatabaseSync,project:ProjectRecord,folder:string):Promise<string>{
 const held=(await listSyncthingFolders()).find(candidate=>candidate.id===folder);
 if(!held||path.resolve(held.path)===path.resolve(project.path))return project.path;
 const target=path.resolve(held.path);
 const entries=await readdir(project.path).catch((error:NodeJS.ErrnoException)=>error.code==="ENOENT"?[]:undefined);
 if(!entries||entries.some(name=>name!==".DS_Store")||!await stat(target).then(found=>found.isDirectory(),()=>false))return project.path;
 const within=(outer:string,inner:string)=>{const relative=path.relative(outer,inner);return !relative.startsWith("..")&&!path.isAbsolute(relative);};
 const rows=db.prepare("SELECT path FROM projects WHERE id<>?").all(project.id) as Array<{path:string}>;
 if(rows.some(row=>within(path.resolve(row.path),target)||within(target,path.resolve(row.path))))return project.path;
 await updateProjectPath(project.id,target);
 await rmdir(project.path).catch(()=>undefined);
 console.warn(`Project ${project.name} now uses ${target} on this machine, where Syncthing syncs its files; its folder ${project.path} was empty`);
 return target;
}
async function enrollFiles(db:DatabaseSync,local:string,peer:string,device:string,ids:string[]):Promise<string[]> {
 await ensureSyncthingDevice(device,peer);
 await removeSyncthingDevices([device],[TICKET_WORKSPACE_FOLDER_ID,...listHarnessSyncFolders().map(folder=>folder.id)]);
 db.prepare("DELETE FROM cluster_v2_file_enrollments WHERE peer_id=? AND project_id IS NULL").run(peer);
 const save=db.prepare("INSERT OR REPLACE INTO cluster_v2_file_enrollments VALUES(?,?,?,?)");
 const accepted:string[]=[];
 const skipped:Array<{id:string;name:string;error:string}>=[];
 for(const id of ids){
  if(!mayShareProject(db,local,peer,id))continue;
  const project=await getProject(id);if(!project)continue;
  // A project on built-in sync here keeps Syncthing out of its folders (cutover-engine, P5); the lock keeps a switch from
  // releasing them between this check and the folder calls below. A folder over another project that built-in sync moves
  // here is refused, and reported as skipped (fix P4+P5).
  try{
   const ticketPath=path.dirname(expectedTaskWorkspacePath(id,'sharing')),worktreePath=projectWorktreeRoot(id);
   await whileFilesOnSyncthing(id,async()=>{
   const folder=project.syncFolderId??`joint-bob-project-${createHash('sha256').update(id).digest('hex')}`;
   const projectPath=await adoptSyncthingFolder(db,project,folder);
   await mkdir(projectPath,{recursive:true});
   await ensureSharedProjectFolder(folder,project.name,projectPath,device);
   db.prepare("DELETE FROM cluster_v2_file_enrollments WHERE peer_id=? AND project_id=? AND folder_id<>?").run(peer,id,folder);
   if(!project.syncFolderId)await updateProjectSyncFolderId(id,folder);
   save.run(peer,device,folder,id);accepted.push(id);
   await mkdir(ticketPath,{recursive:true});
   const ticketFolder=projectTicketSyncFolderId(id);
   await ensureSharedProjectFolder(ticketFolder,`${project.name} tickets`,ticketPath,device);
   save.run(peer,device,ticketFolder,id);
   await mkdir(worktreePath,{recursive:true});
   const worktreeFolder=projectWorktreeSyncFolderId(id);
   await ensureSharedProjectFolder(worktreeFolder,`${project.name} worktrees`,worktreePath,device);
   save.run(peer,device,worktreeFolder,id);
  },db,[project.path,ticketPath,worktreePath]);}catch(error){
   skipped.push({id,name:project.name,error:error instanceof Error?error.message:String(error)});
  }
 }
 // Enrollment repeats on every administration flush: the same skipped projects are reported once, not each time.
 const report=skipped.map(s=>`${s.name}: ${s.error}`).join("; ");
 if(report&&report!==reportedSkips.get(peer))console.warn(`File enrollment skipped ${skipped.length} project(s) for peer ${peer.slice(0,8)}:`,report);
 reportedSkips.set(peer,report);
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
 // The peer answers again, so this node's own failed enrollment with it need not wait out its retry.
 retries.delete(peer);
 // Locations of every project asked about: one on built-in sync here is shared all the same, only not through Syncthing.
 return {deviceId:device,projects,locations:projectLocations(db,payload.projects)};
}
async function revokeFiles(db:DatabaseSync,local:string):Promise<void>{
 const rows=db.prepare("SELECT peer_id,device_id,folder_id,project_id FROM cluster_v2_file_enrollments").all() as unknown as Array<{peer_id:string;device_id:string;folder_id:string;project_id:string|null}>;
 for(const row of rows){
  if(row.project_id&&mayShareProject(db,local,row.peer_id,row.project_id))continue;
  const revoke=async()=>{
   // A project on built-in sync has no folder to edit: rewriting one Syncthing just let go of would add it back.
   if(!row.project_id||projectFilesOnSyncthing(db,row.project_id))await removeSyncthingDevices([row.device_id],[row.folder_id]);
   db.prepare("DELETE FROM cluster_v2_file_enrollments WHERE peer_id=? AND folder_id=?").run(row.peer_id,row.folder_id);
  };
  await (row.project_id?withProjectFilesLock(row.project_id,revoke):revoke());
  notifyRelayPeersChanged();
 }
}
export async function sharingFilesStatus(db:DatabaseSync,local:string,peer:string):Promise<{ready:boolean;error?:string}>{
 ensureSchema(db);
 const error=db.prepare("SELECT error FROM cluster_v2_file_errors WHERE peer_id=?").get(peer) as {error:string}|undefined;
 if(error)return {ready:false,error:error.error};
 // Projects on built-in sync here have no Syncthing folders to wait for (cutover-engine, P5); the engine's cursors say
 // whether this node holds what the peer sent (integrate: facade peerFilesReady, from memory, no request).
 const shared=sharedProjectIds(db,local,peer),elsewhere=shared.filter(id=>!projectFilesOnSyncthing(db,id));
 // fix (P4+P5): a project inside one that built-in sync moves here gets no Syncthing folder (the guard refuses it), so it has none to wait for.
 const onSyncthing:string[]=[];
 for(const id of shared)if(projectFilesOnSyncthing(db,id)&&!await projectInsideBuiltin(db,id))onSyncthing.push(id);
 if(elsewhere.length){
  try{if(!(await (await import("../file-sync/facade.js")).peerFilesReady(peer,elsewhere)).ready)return {ready:false};}
  catch(error){return {ready:false,error:error instanceof Error?error.message:"File sync status unavailable"};}
 }
 if(shared.length&&!onSyncthing.length)return {ready:true};
 // A node that predates worktrees never accepts their folder; it must not hold sharing back.
 const rows=(db.prepare("SELECT device_id,folder_id,project_id FROM cluster_v2_file_enrollments WHERE peer_id=?").all(peer) as unknown as Array<{device_id:string;folder_id:string;project_id:string|null}>)
  .filter(row=>!row.folder_id.startsWith(WORKTREE_FOLDER_PREFIX)&&(!row.project_id||onSyncthing.includes(row.project_id)));
 if(!rows.length||onSyncthing.some(id=>!rows.some(row=>row.project_id===id)))return {ready:false};
 try{return {ready:await syncthingPeerCaughtUp(rows[0].device_id,rows.map(row=>row.folder_id))};}
 catch(error){return {ready:false,error:error instanceof Error?error.message:"Syncthing status unavailable"};}
}

// Enrolling asks the peer and then walks every shared folder through Syncthing's REST API on
// both machines. The administration flush runs every few seconds, so repeating it there cost
// hundreds of requests a cycle with nothing to change. Each peer is enrolled again only when
// what would be sent differs from what it last accepted, or a failed attempt is due a retry.
const RETRY_MS=15_000,MAX_RETRY_MS=5*60_000;
const enrolled=new Map<string,string>();
const retries=new Map<string,{count:number;state:string;at:number}>();
function enrollmentState(db:DatabaseSync,projects:string[]):string{
 const lookup=db.prepare("SELECT id,name,path,sync_folder_id FROM projects WHERE id=?");
 // The phase too: a project back on Syncthing after built-in sync gets its folders again at the next flush, and so does one
 // inside another project that just left built-in sync (fix P4+P5: the guard refused it meanwhile).
 const engineProjects=[...listPhases(db).values()].filter(record=>record.phase!=="syncthing").map(record=>record.projectId).sort();
 return JSON.stringify([syncthingConnectionGeneration(),projects.map(id=>[lookup.get(id),projectFilesOnSyncthing(db,id)]),engineProjects]);
}

export async function flushSharingFiles():Promise<void>{
 const db=await clusterV2Database(),local=await getClusterNode();ensureSchema(db);
 await revokeFiles(db,local.id);
 const peers=replicationPeers(db,local.id),now=Date.now();
 for(const known of [enrolled,retries])for(const peerId of known.keys())if(!peers.some(peer=>peer.nodeId===peerId))known.delete(peerId);
 const due=peers.filter(peer=>!peerAway(peer.nodeId)).flatMap(peer=>{
  const projects=sharedProjectIds(db,local.id,peer.nodeId),state=enrollmentState(db,projects),retry=retries.get(peer.nodeId);
  return enrolled.get(peer.nodeId)===state||(retry?.state===state&&retry.at>now)?[]:[{peer,projects,state}];
 });
 if(!due.length)return;
 const device=await syncthingDeviceId();
 if(device)await pauseSyncthingFolders([TICKET_WORKSPACE_FOLDER_ID,...listHarnessSyncFolders().map(folder=>folder.id)]);
 for(const {peer,projects,state} of due)try{
  if(!device)throw new Error("Syncthing is not configured on this node");
  const target="/api/cluster/v2/files/enroll",body=Buffer.from(JSON.stringify({deviceId:device,projects,locations:projectLocations(db,projects)}));
  const response=await peerFetch(new URL(target,peer.url),{method:"POST",redirect:"error",signal:AbortSignal.timeout(10000),body,
   headers:{"Content-Type":"application/json",Authorization:signClusterRequest(db,local.id,peer.nodeId,"POST",target,body)}}, peer.nodeId);
  if(!response.ok)throw new Error(`File enrollment rejected (${response.status})`);
  const payload=fileEnrollmentSchema.parse(await response.json());
  receiveLocations(db,local.id,peer.nodeId,payload.locations);
  await enroll(db,local.id,peer.nodeId,payload.deviceId,payload.projects);
  enrolled.set(peer.nodeId,state);retries.delete(peer.nodeId);
 }catch(error){
  enrolled.delete(peer.nodeId);
  const count=(retries.get(peer.nodeId)?.count??0)+1;
  retries.set(peer.nodeId,{count,state,at:Date.now()+Math.min(MAX_RETRY_MS,RETRY_MS*2**(count-1))});
  db.prepare("INSERT OR REPLACE INTO cluster_v2_file_errors VALUES(?,?)").run(peer.nodeId,error instanceof Error?error.message:"File enrollment failed");
 }
}
