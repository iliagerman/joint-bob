import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { signClusterRequest } from "../cluster-protocol.js";
import type { PeerEndpoint } from "../cluster-peer-endpoints.js";
import { ClusterV2HttpError, selectiveSharingActive } from "../cluster-v2-mode.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { clearHarnessSessionCache, getHarness, harnessForSessionPath, listHarnessSessions } from "../harnesses.js";
import { getProject } from "../store.js";
import { listTasks } from '../tasks.js';
import { getConversationOwnership } from "../conversation-ownership.js";
import { ensureConversationRecord } from "../conversation-records.js";
import { replicationPeers } from "./replication-v2.js";
import { mayShareProject, sharedProjectIds } from "./sharing-files.js";

export const transcriptQuery=z.object({projectId:z.string().min(1).max(300),engine:z.string().min(1).max(80).optional(),sessionId:z.string().min(1).max(300).optional()}).strict();
const entrySchema=z.object({engine:z.string().min(1).max(80),sessionId:z.string().min(1).max(300),relativePath:z.string().min(1).max(4096),size:z.number().int().min(0).max(1024*1024*1024),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
type Entry=z.infer<typeof entrySchema>;
function ensureSchema(db:DatabaseSync):void{
 db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_transcript_receipts(peer_id TEXT NOT NULL,project_id TEXT NOT NULL,engine TEXT NOT NULL,session_id TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(peer_id,project_id,engine,session_id));
 CREATE TABLE IF NOT EXISTS cluster_v2_transcript_progress(peer_id TEXT NOT NULL,project_id TEXT NOT NULL,PRIMARY KEY(peer_id,project_id));
 CREATE TABLE IF NOT EXISTS cluster_v2_transcript_errors(peer_id TEXT NOT NULL,project_id TEXT NOT NULL,error TEXT NOT NULL,PRIMARY KEY(peer_id,project_id));`);
}
function within(root:string,file:string):boolean{
 const relative=path.relative(path.resolve(root),path.resolve(file));return relative!==''&&relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);
}
async function fileHash(file:string):Promise<string>{
 const hash=createHash('sha256');for await(const chunk of createReadStream(file))hash.update(chunk);return hash.digest('hex');
}
export async function sharedTranscriptProject(peer:string,id:string){
 const db=await clusterV2Database(),local=await getClusterNode();
 if(!mayShareProject(db,local.id,peer,id))throw new ClusterV2HttpError(403,"Project is not shared with this node");
 const project=await getProject(id);if(!project)throw new ClusterV2HttpError(404,"Project not found");return project;
}
async function sourceTranscripts(peer:string,projectId:string){
 const project=await sharedTranscriptProject(peer,projectId),sessions=await listHarnessSessions(project);
 const local=await getClusterNode();
 const entries=sessions.flatMap(session=>session.segments?.length?session.segments.map(segment=>({engine:segment.engine,id:segment.sessionId,path:segment.path})): [{engine:session.harnessId,id:session.id,path:session.path}]);
 // Ticket conversations live under ticket working directories, not the project's cwd.
 for(const task of await listTasks(projectId)){
  if(!task.sessionPath||task.sessionPath==='watch'||task.currentNodeId!==local.id)continue;
  const adapter=harnessForSessionPath(task.sessionPath),id=adapter.paths.sessionId(task.sessionPath);
  if(!id)throw new Error('Task conversation has no transcript identity');
  entries.push({engine:adapter.id,id,path:task.sessionPath});
 }
 const unique=[...new Map(entries.filter(entry=>!entry.path.startsWith('draft:')).map(entry=>[`${entry.engine}:${entry.id}`,entry])).values()];
 for(const entry of unique)await ensureConversationRecord(projectId,entry.engine,entry.id,local.id);
 return unique;
}
export async function sharedTranscriptFile(peer:string,projectId:string,engine:string,sessionId:string):Promise<string>{
 const session=(await sourceTranscripts(peer,projectId)).find(row=>row.engine===engine&&row.id===sessionId);
 if(!session)throw new ClusterV2HttpError(404,"Conversation not found in shared project");
 const adapter=getHarness(engine),file=adapter.paths.transcriptFile?.(session.path);
 if(!file||!within(adapter.sync.transcriptRoot(),file))throw new ClusterV2HttpError(409,"Conversation transcript is not available");
 if(!(await lstat(file)).isFile()||!within(await realpath(adapter.sync.transcriptRoot()),await realpath(file)))throw new ClusterV2HttpError(409,"Conversation transcript is not a regular local file");
 return file;
}
export async function sharedTranscriptInventory(peer:string,projectId:string):Promise<Entry[]>{
 const entries:Entry[]=[];
 for(const session of await sourceTranscripts(peer,projectId)){
  if(session.path.startsWith('draft:'))continue;
  const adapter=getHarness(session.engine),file=await sharedTranscriptFile(peer,projectId,session.engine,session.id),info=await stat(file);
  entries.push(entrySchema.parse({engine:session.engine,sessionId:session.id,relativePath:path.relative(adapter.sync.transcriptRoot(),file),size:info.size,hash:await fileHash(file)}));
 }
 return entries;
}
async function peerGet(peer:PeerEndpoint,target:string):Promise<Response>{
 const db=await clusterV2Database(),local=await getClusterNode();
 const response=await fetch(new URL(target,peer.url),{redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:signClusterRequest(db,local.id,peer.nodeId,'GET',target,Buffer.alloc(0))}});
 if(!response.ok)throw new Error(`Transcript request rejected (${response.status})`);return response;
}
async function safeParent(root:string,destination:string):Promise<void>{
 await mkdir(root,{recursive:true});
 let current=root;
 for(const segment of path.relative(root,path.dirname(destination)).split(path.sep).filter(Boolean)){
  current=path.join(current,segment);
  try{await mkdir(current);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const info=await lstat(current);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Transcript parent is not a local directory');
 }
}
async function extendsTranscript(existing:string,incoming:string,size:number):Promise<void>{
 const left=await open(existing,'r'),right=await open(incoming,'r');
 try{
  const a=Buffer.alloc(65536),b=Buffer.alloc(65536);
  for(let offset=0;offset<size;offset+=65536){
   const length=Math.min(65536,size-offset);
   const old=await left.read(a,0,length,offset),next=await right.read(b,0,length,offset);
   if(old.bytesRead!==length||next.bytesRead!==length||!a.subarray(0,length).equals(b.subarray(0,length)))throw new Error('Divergent transcript requires review');
  }
 }finally{await left.close();await right.close();}
}
async function receiveTranscript(db:DatabaseSync,peer:PeerEndpoint,projectId:string,entry:Entry):Promise<void>{
 const adapter=getHarness(entry.engine),root=path.resolve(adapter.sync.transcriptRoot()),destination=path.resolve(root,entry.relativePath);
 if(!within(root,destination)||!adapter.paths.ownsTranscript(destination)||(adapter.paths.sessionId(destination)??adapter.paths.sessionId(`${entry.engine}:${destination}`))!==entry.sessionId)throw new Error('Invalid shared transcript identity');
 const receipt=db.prepare('SELECT path,hash FROM cluster_v2_transcript_receipts WHERE peer_id=? AND project_id=? AND engine=? AND session_id=?').get(peer.nodeId,projectId,entry.engine,entry.sessionId) as {path:string;hash:string}|undefined;
 const ownership=await getConversationOwnership(entry.engine,entry.sessionId);
 if(ownership&&ownership.ownerNodeId!==peer.nodeId)return;
 const existing=await lstat(destination).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;});
 if(existing&&(!existing.isFile()||existing.isSymbolicLink()))throw new Error('Shared transcript destination is not a regular file');
 if(existing&&receipt?.hash===entry.hash)return;
 if(existing&&!receipt){
  const project=await sharedTranscriptProject(peer.nodeId,projectId);
  if(!(await listHarnessSessions(project)).some(session=>session.harnessId===entry.engine&&session.id===entry.sessionId))throw new Error('Transcript identity collides with a local conversation');
 }
 await safeParent(root,destination);
 const target='/api/cluster/v2/transcripts/file?'+new URLSearchParams({projectId,engine:entry.engine,sessionId:entry.sessionId});
 const response=await peerGet(peer,target);if(!response.body)throw new Error('Empty transcript response');
 const temporary=`${destination}.${randomUUID()}.tmp`,hash=createHash('sha256');let bytes=0;
 try{
  await pipeline(Readable.fromWeb(response.body as never),new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;if(bytes>entry.size){callback(new Error('Transcript exceeds advertised size'));return;}hash.update(chunk);callback(null,chunk);}}),createWriteStream(temporary,{flags:'wx',mode:0o600}));
  if(bytes!==entry.size||hash.digest('hex')!==entry.hash)throw new Error('Transcript changed during transfer');
  // Unowned legacy copies may only extend a matching transcript, never truncate it.
  if(existing&&!ownership){
   if(existing.size>entry.size)return;
   await extendsTranscript(destination,temporary,existing.size);
  }
  if(existing){const current=await stat(destination);if(current.size!==existing.size||current.mtimeMs!==existing.mtimeMs)throw new Error('Local transcript changed during transfer');}
  await sharedTranscriptProject(peer.nodeId,projectId);
  await rename(temporary,destination);
  db.prepare('INSERT OR REPLACE INTO cluster_v2_transcript_receipts VALUES(?,?,?,?,?,?)').run(peer.nodeId,projectId,entry.engine,entry.sessionId,destination,entry.hash);
  clearHarnessSessionCache(projectId);
 }finally{await rm(temporary,{force:true});}
}
export async function assertSharedTranscriptReady(projectId:string,sessionPath:string,ownerNodeId?:string):Promise<void>{
 const db=await clusterV2Database(),local=await getClusterNode();ensureSchema(db);
 const adapter=harnessForSessionPath(sessionPath),sessionId=adapter.paths.sessionId(sessionPath);
 if(!sessionId)throw new Error('Conversation has no transcript identity');
 const ownership=await getConversationOwnership(adapter.id,sessionId);
 const sourceId=ownerNodeId??ownership?.ownerNodeId;
 if(!sourceId||sourceId===local.id)return;
 const peer=replicationPeers(db,local.id).find(peer=>peer.nodeId===sourceId);
 if(!peer||!mayShareProject(db,local.id,peer.nodeId,projectId))throw new Error('Conversation owner is unavailable');
 const target='/api/cluster/v2/transcripts?'+new URLSearchParams({projectId});
 const payload=z.object({entries:z.array(entrySchema).max(10000)}).strict().parse(await(await peerGet(peer,target)).json());
 const entry=payload.entries.find(entry=>entry.engine===adapter.id&&entry.sessionId===sessionId);
 if(!entry)throw new Error('Conversation transcript is not available on its owner');
 await receiveTranscript(db,peer,projectId,entry);
 const receipt=db.prepare('SELECT path,hash FROM cluster_v2_transcript_receipts WHERE peer_id=? AND project_id=? AND engine=? AND session_id=?').get(peer.nodeId,projectId,entry.engine,entry.sessionId) as {path:string;hash:string}|undefined;
 if(!receipt||receipt.hash!==entry.hash||await fileHash(receipt.path)!==entry.hash)throw new Error('Conversation transcript is not synchronized on this node');
}

let activeFlush:Promise<void>|undefined;
export function flushSharedTranscripts():Promise<void>{
 if(!activeFlush)activeFlush=runSharedTranscripts().finally(()=>{activeFlush=undefined;});
 return activeFlush;
}
export function sharedTranscriptStatus(db:DatabaseSync,local:string,peer:string):{pending:number;error?:string}{
 ensureSchema(db);
 const projects=sharedProjectIds(db,local,peer);
 const errors=db.prepare('SELECT project_id,error FROM cluster_v2_transcript_errors WHERE peer_id=?').all(peer) as unknown as Array<{project_id:string;error:string}>;
 const failure=errors.find(error=>projects.includes(error.project_id));
 const pending=projects.filter(id=>!db.prepare('SELECT 1 FROM cluster_v2_transcript_progress WHERE peer_id=? AND project_id=?').get(peer,id)).length;
 return {pending,...(failure?{error:failure.error}:{})};
}
async function runSharedTranscripts():Promise<void>{
 if(!await selectiveSharingActive())return;
 const db=await clusterV2Database(),local=await getClusterNode();ensureSchema(db);
 for(const peer of replicationPeers(db,local.id))for(const projectId of sharedProjectIds(db,local.id,peer.nodeId))try{
  if(!await getProject(projectId))continue;
  const target='/api/cluster/v2/transcripts?'+new URLSearchParams({projectId});
  const payload=z.object({entries:z.array(entrySchema).max(10000)}).strict().parse(await(await peerGet(peer,target)).json());
  for(const entry of payload.entries)await receiveTranscript(db,peer,projectId,entry);
  db.prepare('DELETE FROM cluster_v2_transcript_errors WHERE peer_id=? AND project_id=?').run(peer.nodeId,projectId);
  db.prepare('INSERT OR IGNORE INTO cluster_v2_transcript_progress VALUES(?,?)').run(peer.nodeId,projectId);
 }catch(error){db.prepare('INSERT OR REPLACE INTO cluster_v2_transcript_errors VALUES(?,?,?)').run(peer.nodeId,projectId,error instanceof Error?error.message:'Transcript transfer failed');}
}
