import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {getClusterNode} from '../cluster.js';
import {isTrustedTwin} from '../cluster-sharing-policy.js';
import {clusterV2Database} from '../cluster-v2-store.js';
import {ClusterV2HttpError} from '../cluster-v2-mode.js';
import {decryptSecretValue,encryptSecretValue,ensureSecretSchema} from '../secrets.js';
import {mayShareProject,sharedProjectIds} from './sharing-files.js';
import {replicationPeers,signedPeerPost} from './replication-v2.js';

const scopeSchema=z.object({type:z.enum(['workspace','project','conversation']),id:z.string().min(1).max(300),projectIds:z.array(z.string().min(1).max(300)).min(1).max(10000)}).strict();
const accountSchema=z.object({id:z.string().uuid(),label:z.string().trim().min(1).max(64),provider:z.enum(['aws','google','github','custom']),variables:z.array(z.object({name:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),kind:z.enum(['value','file']),value:z.string().max(100000)}).strict()).min(1).max(20),scopes:z.array(scopeSchema).min(1).max(1000),updatedAt:z.string().datetime()}).strict();
export const scopedCredentialSchema=z.object({accounts:z.array(accountSchema).max(10000)}).strict();
type Account=z.infer<typeof accountSchema>;
function ensureSchema(db:DatabaseSync):void{
 ensureSecretSchema(db);
 db.exec(`CREATE TABLE IF NOT EXISTS cluster_v2_scoped_secret_copies(peer_id TEXT NOT NULL,account_id TEXT PRIMARY KEY,scopes TEXT NOT NULL,payload_hash TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS cluster_v2_scoped_secret_errors(peer_id TEXT PRIMARY KEY,error TEXT NOT NULL);`);
}
function scopesForAccount(db:DatabaseSync,accountId:string,allowed:string[]):Account['scopes']{
 const rows=db.prepare('SELECT scope_type,scope_id FROM secret_assignments WHERE account_id=?').all(accountId) as unknown as Array<{scope_type:'workspace'|'project'|'conversation';scope_id:string}>;
 return rows.flatMap(row=>{
  const projects=row.scope_type==='project'?[{id:row.scope_id}]:row.scope_type==='workspace'
   ?db.prepare('SELECT id FROM projects WHERE workspace_id=?').all(row.scope_id) as unknown as Array<{id:string}>
   :db.prepare("SELECT DISTINCT project_id id FROM conversation_records WHERE engine||':'||session_id=?").all(row.scope_id) as unknown as Array<{id:string}>;
  const projectIds=projects.map(project=>project.id).filter(id=>allowed.includes(id));
  return projectIds.length?[{type:row.scope_type,id:row.scope_id,projectIds}]:[];
 });
}
function snapshot(db:DatabaseSync,local:string,peer:string):Account[]{
 const allowed=sharedProjectIds(db,local,peer);
 const rows=db.prepare(`SELECT id,label,provider,variables_encrypted,updated_at FROM secret_accounts a WHERE replicate=1
  AND website_origin IS NULL AND project_id IS NULL AND provider<>'website' AND (origin_node_id='' OR origin_node_id=?)
  AND NOT EXISTS(SELECT 1 FROM cluster_v2_scoped_secret_copies c WHERE c.account_id=a.id)`).all(local) as unknown as Array<{id:string;label:string;provider:Account['provider'];variables_encrypted:string;updated_at:string}>;
 return rows.flatMap(row=>{const scopes=scopesForAccount(db,row.id,allowed);return scopes.length?[accountSchema.parse({id:row.id,label:row.label,provider:row.provider,variables:JSON.parse(decryptSecretValue(row.variables_encrypted)),updatedAt:row.updated_at,scopes})]:[];});
}
function localScope(db:DatabaseSync,peer:string,scope:Account['scopes'][number]):string{
 if(scope.type!=='workspace')return scope.id;
 const mapping=db.prepare('SELECT workspace_id FROM cluster_v2_shared_workspaces WHERE owner_node_id=? AND source_workspace_id=?').get(peer,scope.id) as {workspace_id:string}|undefined;
 if(!mapping)throw new ClusterV2HttpError(409,'Shared workspace metadata has not arrived');return mapping.workspace_id;
}
function removeCopy(db:DatabaseSync,peer:string,id:string):void{
 if(!db.prepare('SELECT 1 FROM cluster_v2_scoped_secret_copies WHERE peer_id=? AND account_id=?').get(peer,id))return;
 db.prepare('DELETE FROM secret_assignments WHERE account_id=?').run(id);
 db.prepare('DELETE FROM secret_accounts WHERE id=?').run(id);
 db.prepare('DELETE FROM cluster_v2_scoped_secret_copies WHERE peer_id=? AND account_id=?').run(peer,id);
}
function applyAccount(db:DatabaseSync,local:string,peer:string,account:Account):void{
 for(const scope of account.scopes)if(scope.projectIds.some(id=>!mayShareProject(db,local,peer,id)))throw new ClusterV2HttpError(403,'Credential project is not shared');
 const copy=db.prepare('SELECT peer_id,payload_hash FROM cluster_v2_scoped_secret_copies WHERE account_id=?').get(account.id) as {peer_id:string;payload_hash:string}|undefined;
 const existing=db.prepare('SELECT origin_node_id FROM secret_accounts WHERE id=?').get(account.id) as {origin_node_id:string}|undefined;
 if((copy&&copy.peer_id!==peer)||(existing&&existing.origin_node_id!==peer))throw new ClusterV2HttpError(409,'Credential identity belongs to another source');
 const hash=createHash('sha256').update(JSON.stringify(account)).digest('hex');
 if(copy?.payload_hash===hash)return;
 const scopes=account.scopes.map(scope=>({type:scope.type,id:localScope(db,peer,scope)}));
 for(const [index,scope]of scopes.entries()){
  if(scope.type==='project'&&!account.scopes[index].projectIds.includes(scope.id))throw new ClusterV2HttpError(403,'Invalid project credential scope');
  if(scope.type==='workspace'&&account.scopes[index].projectIds.some(id=>!(db.prepare('SELECT 1 FROM projects WHERE id=? AND workspace_id=?').get(id,scope.id))))throw new ClusterV2HttpError(403,'Invalid workspace credential scope');
  if(scope.type==='conversation'&&!account.scopes[index].projectIds.some(id=>db.prepare("SELECT 1 FROM conversation_records WHERE project_id=? AND engine||':'||session_id=?").get(id,scope.id)))throw new ClusterV2HttpError(403,'Invalid conversation credential scope');
 }
 db.prepare(`INSERT INTO secret_accounts(id,label,provider,variables_encrypted,replicate,origin_node_id,created_at,updated_at) VALUES(?,?,?,?,0,?,?,?)
  ON CONFLICT(id) DO UPDATE SET label=excluded.label,provider=excluded.provider,variables_encrypted=excluded.variables_encrypted,updated_at=excluded.updated_at`).run(account.id,account.label,account.provider,encryptSecretValue(JSON.stringify(account.variables)),peer,account.updatedAt,account.updatedAt);
 db.prepare('DELETE FROM secret_assignments WHERE account_id=?').run(account.id);
 for(const scope of scopes)db.prepare('INSERT INTO secret_assignments VALUES(?,?,?)').run(scope.type,scope.id,account.id);
 db.prepare('INSERT OR REPLACE INTO cluster_v2_scoped_secret_copies VALUES(?,?,?,?)').run(peer,account.id,JSON.stringify(account.scopes),hash);
}
export async function receiveScopedCredentials(peer:string,input:unknown):Promise<void>{
 const payload=scopedCredentialSchema.parse(input),db=await clusterV2Database(),local=await getClusterNode();ensureSchema(db);
 if(!replicationPeers(db,local.id).some(row=>row.nodeId===peer))throw new ClusterV2HttpError(403,'Forbidden');
 db.exec('SAVEPOINT scoped_credentials');
 try{
  for(const account of payload.accounts)applyAccount(db,local.id,peer,account);
  const previous=db.prepare('SELECT account_id FROM cluster_v2_scoped_secret_copies WHERE peer_id=?').all(peer) as unknown as Array<{account_id:string}>;
  for(const row of previous)if(!payload.accounts.some(account=>account.id===row.account_id))removeCopy(db,peer,row.account_id);
  db.exec('RELEASE scoped_credentials');
 }catch(error){db.exec('ROLLBACK TO scoped_credentials; RELEASE scoped_credentials');throw error;}
}
export async function flushScopedCredentials():Promise<void>{
 const db=await clusterV2Database(),local=await getClusterNode();ensureSchema(db);
 const copies=db.prepare('SELECT peer_id,account_id,scopes FROM cluster_v2_scoped_secret_copies').all() as unknown as Array<{peer_id:string;account_id:string;scopes:string}>;
 for(const copy of copies){const scopes=z.array(scopeSchema).parse(JSON.parse(copy.scopes));if(scopes.every(scope=>scope.projectIds.every(id=>!mayShareProject(db,local.id,copy.peer_id,id))))removeCopy(db,copy.peer_id,copy.account_id);}
 for(const peer of replicationPeers(db,local.id)){
  if(isTrustedTwin(db,local.id,peer.nodeId))continue;
  try{await signedPeerPost(peer,'/api/cluster/v2/credentials/scoped',{accounts:snapshot(db,local.id,peer.nodeId)});db.prepare('DELETE FROM cluster_v2_scoped_secret_errors WHERE peer_id=?').run(peer.nodeId);}
  catch(error){db.prepare('INSERT OR REPLACE INTO cluster_v2_scoped_secret_errors VALUES(?,?)').run(peer.nodeId,error instanceof Error?error.message:'Scoped credentials failed');}
 }
}
