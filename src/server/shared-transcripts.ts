import { projectAdditionalPaths } from "./session-scope.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { getClusterNode } from "../cluster.js";
import { projectMetadataVisible } from "../cluster-project-metadata.js";
import { signClusterRequest } from "../cluster-protocol.js";
import type { PeerEndpoint } from "../cluster-peer-endpoints.js";
import { ClusterV2HttpError } from "../cluster-v2-errors.js";
import { clusterV2Database } from "../cluster-v2-store.js";
import { clearHarnessSessionCache, getHarness, harnessForSessionPath, listHarnessSessions } from "../harnesses.js";
import { getProject } from "../store.js";
import { listTasks } from '../tasks.js';
import { getConversationOwnership } from "../conversation-ownership.js";
import { deletedConversationKeys, ensureConversationRecord, ensureConversationRecordSchema } from "../conversation-records.js";
import { replicationPeers } from "./replication-v2.js";
import { mayShareProject, sharedProjectIds } from "./sharing-files.js";
import { fetchPeer, isPeerUnreachable, whilePeerOptional } from "./peer-availability.js";

export const transcriptQuery=z.object({projectId:z.string().min(1).max(300),engine:z.string().min(1).max(80).optional(),sessionId:z.string().min(1).max(300).optional()}).strict();
const entrySchema=z.object({engine:z.string().min(1).max(80),sessionId:z.string().min(1).max(300),relativePath:z.string().min(1).max(4096),size:z.number().int().min(0).max(1024*1024*1024),hash:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
type Entry=z.infer<typeof entrySchema>;
const inventorySchema=z.object({entries:z.array(entrySchema).max(10000)}).strict();
function ensureSchema(db:DatabaseSync):void{
 db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_transcript_receipts(peer_id TEXT NOT NULL,project_id TEXT NOT NULL,engine TEXT NOT NULL,session_id TEXT NOT NULL,path TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(peer_id,project_id,engine,session_id));
 CREATE TABLE IF NOT EXISTS cluster_v2_transcript_progress(peer_id TEXT NOT NULL,project_id TEXT NOT NULL,PRIMARY KEY(peer_id,project_id));
 CREATE TABLE IF NOT EXISTS cluster_v2_transcript_errors(peer_id TEXT NOT NULL,project_id TEXT NOT NULL,error TEXT NOT NULL,PRIMARY KEY(peer_id,project_id));
 CREATE TABLE IF NOT EXISTS transcript_hashes(file TEXT PRIMARY KEY,mtime_ms REAL NOT NULL,size INTEGER NOT NULL,hash TEXT NOT NULL);`);
}
function within(root:string,file:string):boolean{
 const relative=path.relative(path.resolve(root),path.resolve(file));return relative!==''&&relative!=='..'&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative);
}
// A twin polls every shared project's inventory, so unchanged transcripts reuse their hash.
const hashCache=new Map<string,{mtimeMs:number;size:number;hash:string}>();
// The hashes are also kept in node.db (local-only), so a restart does not re-read every
// transcript on disk to answer the first inventory.
async function fileHash(file:string,info:{mtimeMs:number;size:number}):Promise<string>{
 const db=await clusterV2Database();ensureSchema(db);
 const row=hashCache.get(file)??(db.prepare('SELECT mtime_ms mtimeMs,size,hash FROM transcript_hashes WHERE file=?').get(file) as {mtimeMs:number;size:number;hash:string}|undefined);
 if(row&&row.mtimeMs===info.mtimeMs&&row.size===info.size){hashCache.set(file,row);return row.hash;}
 // Transcripts can grow between stat and the read. Hash exactly that snapshot's
 // prefix, so the advertised size and digest always describe the same bytes.
 const hash=createHash('sha256');let bytes=0;
 if(info.size>0)for await(const chunk of createReadStream(file,{start:0,end:info.size-1})){bytes+=chunk.length;hash.update(chunk);}
 if(bytes!==info.size)throw new Error('Transcript changed during hashing');
 const digest=hash.digest('hex');hashCache.set(file,{mtimeMs:info.mtimeMs,size:info.size,hash:digest});
 db.prepare('INSERT INTO transcript_hashes VALUES(?,?,?,?) ON CONFLICT(file) DO UPDATE SET mtime_ms=excluded.mtime_ms,size=excluded.size,hash=excluded.hash').run(file,info.mtimeMs,info.size,digest);
 return digest;
}
export async function sharedTranscriptProject(peer:string,id:string){
 const db=await clusterV2Database(),local=await getClusterNode();
 if(!mayShareProject(db,local.id,peer,id))throw new ClusterV2HttpError(403,"Project is not shared with this node");
 const project=await getProject(id);if(!project)throw new ClusterV2HttpError(404,"Project not found");return project;
}
async function sourceTranscripts(peer:string,projectId:string){
 const project=await sharedTranscriptProject(peer,projectId),sessions=await listHarnessSessions({...project,additionalPaths:await projectAdditionalPaths(projectId)});
 const local=await getClusterNode();
 const entries:Array<{engine:string;id:string;path:string;subagent?:boolean}>=sessions.flatMap(session=>session.segments?.length?session.segments.map(segment=>({engine:segment.engine,id:segment.sessionId,path:segment.path})): [{engine:session.harnessId,id:session.id,path:session.path,subagent:Boolean(session.parentSessionPath)}]);
 // Ticket conversations live under ticket working directories, not the project's cwd.
 for(const task of await listTasks(projectId)){
  if(!task.sessionPath||task.sessionPath==='watch'||task.currentNodeId!==local.id)continue;
  const adapter=harnessForSessionPath(task.sessionPath),id=adapter.paths.sessionId(task.sessionPath);
  if(!id)throw new Error('Task conversation has no transcript identity');
  entries.push({engine:adapter.id,id,path:task.sessionPath});
 }
 // A leftover copy of a conversation deleted on any node is never offered.
 const deleted=await deletedConversationKeys(projectId);
 const unique=[...new Map(entries.filter(entry=>!entry.path.startsWith('draft:')&&!deleted.has(`${entry.engine}:${entry.id}`)).map(entry=>[`${entry.engine}:${entry.id}`,entry])).values()];
 // A sub-agent transcript travels with its parent but is never a conversation of its own.
 for(const entry of unique)if(!entry.subagent)await ensureConversationRecord(projectId,entry.engine,entry.id,local.id);
 return unique;
}
export async function sharedTranscriptFile(peer:string,projectId:string,engine:string,sessionId:string):Promise<string>{
 const session=(await sourceTranscripts(peer,projectId)).find(row=>row.engine===engine&&row.id===sessionId);
 if(!session)throw new ClusterV2HttpError(404,"Conversation not found in shared project");
 return localTranscriptFile(session);
}
async function localTranscriptFile(session:{engine:string;path:string}):Promise<string>{
 const adapter=getHarness(session.engine),file=adapter.paths.transcriptFile?.(session.path);
 if(!file||!within(adapter.sync.transcriptRoot(),file))throw new ClusterV2HttpError(409,"Conversation transcript is not available");
 if(!(await lstat(file)).isFile()||!within(await realpath(adapter.sync.transcriptRoot()),await realpath(file)))throw new ClusterV2HttpError(409,"Conversation transcript is not a regular local file");
 return file;
}
/** A peer catching up on one conversation names it, so only that transcript is hashed and sent. */
export async function sharedTranscriptInventory(peer:string,projectId:string,only?:{engine:string;sessionId:string}):Promise<Entry[]>{
 const entries:Entry[]=[];
 for(const session of await sourceTranscripts(peer,projectId)){
  if(session.path.startsWith('draft:'))continue;
  if(only&&(session.engine!==only.engine||session.id!==only.sessionId))continue;
  const adapter=getHarness(session.engine),file=await localTranscriptFile(session),info=await stat(file);
  entries.push(entrySchema.parse({engine:session.engine,sessionId:session.id,relativePath:path.relative(adapter.sync.transcriptRoot(),file),size:info.size,hash:await fileHash(file,info)}));
 }
 return entries;
}
async function peerGet(peer:PeerEndpoint,target:string,headers:Record<string,string>={}):Promise<Response>{
 const db=await clusterV2Database(),local=await getClusterNode();
 const response=await fetchPeer(db,peer.nodeId,new URL(target,peer.url),{redirect:'error',signal:AbortSignal.timeout(30000),headers:{...headers,Authorization:signClusterRequest(db,local.id,peer.nodeId,'GET',target,Buffer.alloc(0))}});
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
// The background flush and a takeover can fetch the same transcript at once; the loser would
// see the winner's rename as a local edit. One receive per conversation at a time.
const activeReceives=new Map<string,Promise<void>>();
function receiveTranscript(db:DatabaseSync,peer:PeerEndpoint,projectId:string,entry:Entry):Promise<void>{
 const key=JSON.stringify([peer.nodeId,projectId,entry.engine,entry.sessionId]);
 const run=(activeReceives.get(key)??Promise.resolve()).then(()=>receiveTranscriptNow(db,peer,projectId,entry));
 const settled=run.catch(()=>undefined).finally(()=>{if(activeReceives.get(key)===settled)activeReceives.delete(key);});
 activeReceives.set(key,settled);
 return run;
}
async function receiveTranscriptNow(db:DatabaseSync,peer:PeerEndpoint,projectId:string,entry:Entry):Promise<void>{
 const adapter=getHarness(entry.engine),root=path.resolve(adapter.sync.transcriptRoot()),destination=path.resolve(root,entry.relativePath);
 if(!within(root,destination)||!adapter.paths.ownsTranscript(destination)||(adapter.paths.sessionId(destination)??adapter.paths.sessionId(`${entry.engine}:${destination}`))!==entry.sessionId)throw new Error('Invalid shared transcript identity');
 const receipt=db.prepare('SELECT path,hash FROM cluster_v2_transcript_receipts WHERE peer_id=? AND project_id=? AND engine=? AND session_id=?').get(peer.nodeId,projectId,entry.engine,entry.sessionId) as {path:string;hash:string}|undefined;
 const ownership=await getConversationOwnership(entry.engine,entry.sessionId);
 if(ownership&&ownership.ownerNodeId!==peer.nodeId)return;
 const existing=await lstat(destination).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;});
 if(existing&&(!existing.isFile()||existing.isSymbolicLink()))throw new Error('Shared transcript destination is not a regular file');
 // A receipt describes the bytes we installed, not the bytes still on disk.
 // Another file synchronizer can replace the local copy after the receipt is saved.
 const localHash=existing?await fileHash(destination,existing):undefined;
 if(existing&&receipt?.path===destination&&receipt.hash===entry.hash&&localHash===entry.hash)return;
 await safeParent(root,destination);
 const target='/api/cluster/v2/transcripts/file?'+new URLSearchParams({projectId,engine:entry.engine,sessionId:entry.sessionId});
 // sendFile already supports Range, including on older peers. Later appends
 // belong to the next inventory; an empty snapshot needs no download.
 let source:Readable=Readable.from([]);
 if(entry.size>0){
  const response=await peerGet(peer,target,{Range:`bytes=0-${entry.size-1}`});
  if(!response.body)throw new Error('Empty transcript response');
  source=Readable.fromWeb(response.body as never);
 }
 const temporary=`${destination}.${randomUUID()}.tmp`,hash=createHash('sha256');let bytes=0;
 try{
  await pipeline(source,new Transform({transform(chunk,_encoding,callback){bytes+=chunk.length;if(bytes>entry.size){callback(new Error('Transcript exceeds advertised size'));return;}hash.update(chunk);callback(null,chunk);}}),createWriteStream(temporary,{flags:'wx',mode:0o600}));
  if(bytes!==entry.size||hash.digest('hex')!==entry.hash)throw new Error('Transcript changed during transfer');
  // A local copy changed since the last receipt may contain unsent work. Repair
  // truncated copies, but never overwrite divergent bytes without review.
  if(existing&&(!ownership||receipt?.hash!==localHash)){
   await extendsTranscript(destination,temporary,Math.min(existing.size,entry.size));
   if(existing.size>entry.size)return;
  }
  if(existing){const current=await stat(destination);if(current.size!==existing.size||current.mtimeMs!==existing.mtimeMs)throw new Error('Local transcript changed during transfer');}
  // A peer that has not heard of a deletion yet may still offer the conversation, and a
  // deletion may arrive while its transcript downloads or while tombstones are read.
  if((await deletedConversationKeys(projectId)).has(`${entry.engine}:${entry.sessionId}`))return;
  await sharedTranscriptProject(peer.nodeId,projectId);
  await rename(temporary,destination);
  // Rename yields to other requests; a deletion may have committed while it ran.
  await sharedTranscriptProject(peer.nodeId,projectId);
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
 const payload=inventorySchema.parse(await(await peerGet(peer,target)).json());
 const entry=payload.entries.find(entry=>entry.engine===adapter.id&&entry.sessionId===sessionId);
 if(!entry)throw new Error('Conversation transcript is not available on its owner');
 await receiveTranscript(db,peer,projectId,entry);
 const receipt=db.prepare('SELECT path,hash FROM cluster_v2_transcript_receipts WHERE peer_id=? AND project_id=? AND engine=? AND session_id=?').get(peer.nodeId,projectId,entry.engine,entry.sessionId) as {path:string;hash:string}|undefined;
 if(!receipt||receipt.hash!==entry.hash||await fileHash(receipt.path,await stat(receipt.path))!==entry.hash)throw new Error('Conversation transcript is not synchronized on this node');
}

/** Pulls one conversation from the peer that just ended a run in it, instead of waiting up
    to PULL_INTERVAL_MS for the periodic pull. An owner that ignores the filter answers with
    its whole inventory, which still contains the entry. Each inventory costs the owner a
    catalog build, so a catch-up already under way is joined rather than repeated. */
const activeCatchUps=new Map<string,Promise<void>>();
export function catchUpSharedTranscript(peerId:string,engine:string,sessionId:string):Promise<void>{
 const key=JSON.stringify([peerId,engine,sessionId]),active=activeCatchUps.get(key);
 if(active)return active;
 const run=catchUpSharedTranscriptNow(peerId,engine,sessionId).finally(()=>activeCatchUps.delete(key));
 activeCatchUps.set(key,run);
 return run;
}
async function catchUpSharedTranscriptNow(peerId:string,engine:string,sessionId:string):Promise<void>{
 const db=await clusterV2Database(),local=await getClusterNode();ensureSchema(db);ensureConversationRecordSchema(db);
 const peer=replicationPeers(db,local.id).find(peer=>peer.nodeId===peerId);
 if(!peer)return;
 const projects=db.prepare('SELECT DISTINCT project_id FROM conversation_records WHERE engine=? AND session_id=?').all(engine,sessionId) as unknown as Array<{project_id:string}>;
 for(const {project_id:projectId} of projects){
  if(!mayShareProject(db,local.id,peer.nodeId,projectId)||!await getProject(projectId))continue;
  const target='/api/cluster/v2/transcripts?'+new URLSearchParams({projectId,engine,sessionId});
  const entry=inventorySchema.parse(await(await peerGet(peer,target)).json()).entries.find(entry=>entry.engine===engine&&entry.sessionId===sessionId);
  if(entry)await receiveTranscript(db,peer,projectId,entry);
 }
}

let activeFlush:Promise<void>|undefined;
export function flushSharedTranscripts():Promise<void>{
 if(!activeFlush)activeFlush=runSharedTranscripts().finally(()=>{activeFlush=undefined;});
 return activeFlush;
}
export function sharedTranscriptStatus(db:DatabaseSync,local:string,peer:string):{pending:number;error?:string}{
 ensureSchema(db);
 const projects=sharedProjectIds(db,local,peer).filter(id=>db.prepare('SELECT 1 FROM projects WHERE id=?').get(id)&&projectMetadataVisible(db,local,id));
 // Keep policy/history markers, but discard local sync state for ineligible rows.
 const eligible=new Set(projects);
 for(const table of ['cluster_v2_transcript_errors','cluster_v2_transcript_progress']){
  const rows=db.prepare(`SELECT project_id FROM ${table} WHERE peer_id=?`).all(peer) as Array<{project_id:string}>;
  for(const row of rows)if(!eligible.has(row.project_id))db.prepare(`DELETE FROM ${table} WHERE peer_id=? AND project_id=?`).run(peer,row.project_id);
 }
 const errors=db.prepare(`SELECT e.project_id,p.name,e.error FROM cluster_v2_transcript_errors e
  LEFT JOIN projects p ON p.id=e.project_id WHERE e.peer_id=? ORDER BY p.name,e.project_id`).all(peer) as unknown as Array<{project_id:string;name:string|null;error:string}>;
 const failures=errors.filter(error=>projects.includes(error.project_id));
 const pending=projects.filter(id=>!db.prepare('SELECT 1 FROM cluster_v2_transcript_progress WHERE peer_id=? AND project_id=?').get(peer,id)).length;
 const details=failures.slice(0,10).map(row=>`${row.name??row.project_id}: ${row.error}`);
 if(failures.length>10)details.push(`And ${failures.length-10} more projects.`);
 return {pending,...(failures.length?{error:`Conversation history sync failed:\n${details.join('\n')}`}:{})};
}
/** Each inventory makes the peer build that project's full conversation catalog, and the
    administration flush runs every 2 s: pulling on every flush kept a large project's
    catalog rebuilding nonstop on the peer, starving everything else it served. */
const PULL_INTERVAL_MS=30_000;
const pulledAt=new Map<string,number>();
export function resetSharedTranscriptPulls():void{pulledAt.clear();}
async function runSharedTranscripts():Promise<void>{
 const db=await clusterV2Database(),local=await getClusterNode();ensureSchema(db);
 const eligible=async(peer:string,id:string)=>mayShareProject(db,local.id,peer,id)&&Boolean(await getProject(id));
 for(const peer of replicationPeers(db,local.id))for(const projectId of sharedProjectIds(db,local.id,peer.nodeId))try{
  if(!await getProject(projectId))continue;
  const key=`${peer.nodeId}\n${projectId}`;
  if(Date.now()-(pulledAt.get(key)??0)<PULL_INTERVAL_MS)continue;
  pulledAt.set(key,Date.now());
  const target='/api/cluster/v2/transcripts?'+new URLSearchParams({projectId});
  // A peer known to be down is skipped until its next probe instead of waited on.
  const payload=inventorySchema.parse(await(await whilePeerOptional(()=>peerGet(peer,target))).json());
  // One transcript that keeps failing (still growing, edited here) must not hold back the rest; a peer that stops answering ends the pass.
  let failure:unknown;
  for(const entry of payload.entries)try{await receiveTranscript(db,peer,projectId,entry);}catch(error){failure??=error;if(isPeerUnreachable(error))break;}
  if(failure)throw failure;
  if(await eligible(peer.nodeId,projectId)){
   db.prepare('DELETE FROM cluster_v2_transcript_errors WHERE peer_id=? AND project_id=?').run(peer.nodeId,projectId);
   db.prepare('INSERT OR IGNORE INTO cluster_v2_transcript_progress VALUES(?,?)').run(peer.nodeId,projectId);
  }
 }catch(error){if(await eligible(peer.nodeId,projectId))db.prepare('INSERT OR REPLACE INTO cluster_v2_transcript_errors VALUES(?,?,?)').run(peer.nodeId,projectId,error instanceof Error?error.message:'Transcript transfer failed');}
}
