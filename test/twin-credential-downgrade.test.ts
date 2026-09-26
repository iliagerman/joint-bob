import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {api,seedDevEnvironment,signIn,startDevNode,stopDevNode} from './dev-nodes.js';
import {signedNodeRequest} from './signed-node-request.js';

async function eventually(check:()=>Promise<void>) {
 const deadline=Date.now()+20000;
 while(true){try{await check();return;}catch(error){if(Date.now()>deadline)throw error;}await new Promise(resolve=>setTimeout(resolve,100));}
}

test('Twin to Selected reuses same-origin credentials but restricts workspace resolution immediately',{timeout:90000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'credential-downgrade-'));
 const children:Awaited<ReturnType<typeof startDevNode>>[]=[];
 try{
  const a=await seedDevEnvironment(path.join(root,'a'),1),b=await seedDevEnvironment(path.join(root,'b'),1),left=a.nodes[0],right=b.nodes[0];
  children.push(await startDevNode(a,left),await startDevNode(b,right));
  const sa=await signIn(a,left),sb=await signIn(b,right);
  const cluster=await api<{snapshot:{body:{clusterId:string}}}>(left,sa,'POST','/clusters',{name:'Credential selection'});
  const clusterId=cluster.body.snapshot.body.clusterId;
  const join=await api<{link:string}>(left,sa,'POST',`/clusters/${clusterId}/invitations`,{expectedEpoch:1});
  assert.equal((await api(right,sb,'POST','/clusters/join',{link:join.body.link,requestId:randomUUID()})).status,201);
  const invite=await api<{link:string;relationshipId:string}>(left,sa,'POST','/twins/invitations',{confirmOwnedData:true});
  assert.equal((await api(right,sb,'POST','/twins/accept',{link:invite.body.link,confirmOwnedData:true})).status,201);
  const p=left.projects[0];
  const sourceDb=new DatabaseSync(path.join(left.dataDir,'node.db'));
  const workspace=(sourceDb.prepare('SELECT workspace_id FROM projects WHERE id=?').get(p.id) as {workspace_id:string}).workspace_id;sourceDb.close();
  const account=await api<{account:{id:string}}>(left,sa,'POST','/secrets/accounts',{label:'Synthetic workspace',provider:'custom',replicate:true,variables:[{name:'DOWNGRADE_SECRET',kind:'value',value:'synthetic-only'}]});
  assert.equal(account.status,201);
  assert.equal((await api(left,sa,'PUT',`/secrets/scopes/workspace/${workspace}`,{accountIds:[account.body.account.id]})).status,200);
  const resolve=(id:string)=>JSON.parse(execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`import {genericSecretEnvironment} from './src/secrets.ts'; console.log(JSON.stringify(genericSecretEnvironment(${JSON.stringify(id)})));`],{env:{...process.env,HOME:b.home,JOINT_BOB_DATA_DIR:right.dataDir},encoding:'utf8'})) as Record<string,string>;
  await eventually(async()=>assert.equal(resolve(p.id).DOWNGRADE_SECRET,'synthetic-only'));
  const runningSnapshot=resolve(p.id);
  const db=new DatabaseSync(path.join(right.dataDir,'node.db'));
  let targetWorkspace:string;
  try{targetWorkspace=(db.prepare('SELECT workspace_id FROM projects WHERE id=?').get(p.id) as {workspace_id:string}).workspace_id;}finally{db.close();}
  assert.equal((await api(left,sa,'PUT',`/clusters/${clusterId}/sharing`,{projectIds:[p.id],workspaceIds:[],confirmOwnedData:true})).status,200);
  assert.equal((await api(right,sb,'DELETE',`/twins/${invite.body.relationshipId}`)).status,200);
  // A new private project in the formerly mirrored workspace must not inherit the imported account.
  const q=await api<{project:{id:string}}>(right,sb,'POST','/projects',{name:'Private Q',type:targetWorkspace!,path:path.join(root,'private-q'),synced:false});
  assert.equal(q.status,201,JSON.stringify(q.body));
  assert.equal(resolve(q.body.project.id).DOWNGRADE_SECRET,undefined,'revoked twin workspace credential must not leak into new private Q');
  const payload={accounts:[{id:account.body.account.id,label:'Synthetic workspace',provider:'custom',variables:[{name:'DOWNGRADE_SECRET',kind:'value',value:'synthetic-only'}],updatedAt:new Date().toISOString(),scopes:[{type:'workspace',id:workspace,projectIds:[p.id]}]}]};
  await eventually(async()=>{
   const received=await signedNodeRequest(a,left,right,'POST','/api/cluster/v2/credentials/scoped',payload);
   assert.equal(received.status,200,`same-origin twin account must convert to a scoped copy without 409: ${await received.text()}`);
  });
  assert.equal(resolve(p.id).DOWNGRADE_SECRET,'synthetic-only');
  assert.equal(resolve(q.body.project.id).DOWNGRADE_SECRET,undefined);
  for(const foreign of [false,true]){
   const protectedAccount=await api<{account:{id:string}}>(right,sb,'POST','/secrets/accounts',{label:foreign?'Other origin':'Local account',provider:'custom',variables:[{name:foreign?'OTHER_SECRET':'LOCAL_SECRET',kind:'value',value:'preserved-synthetic'}]});
   assert.equal(protectedAccount.status,201);
   if(foreign){const handle=new DatabaseSync(path.join(right.dataDir,'node.db'));try{handle.prepare('UPDATE secret_accounts SET origin_node_id=? WHERE id=?').run(randomUUID(),protectedAccount.body.account.id);}finally{handle.close();}}
   const collision=await signedNodeRequest(a,left,right,'POST','/api/cluster/v2/credentials/scoped',{accounts:[{...payload.accounts[0],id:protectedAccount.body.account.id}]});
   assert.equal(collision.status,409,'local and other-origin account identities remain protected');
   const accounts=await api<{accounts:Array<{id:string;label:string}>}>(right,sb,'GET','/secrets');
   assert.equal(accounts.body.accounts.find(account=>account.id===protectedAccount.body.account.id)?.label,foreign?'Other origin':'Local account');
  }
  assert.equal(runningSnapshot.DOWNGRADE_SECRET,'synthetic-only','already resolved turn snapshot stays unchanged');
  assert.equal((await api(left,sa,'PUT',`/clusters/${clusterId}/sharing`,{projectIds:[],workspaceIds:[],confirmOwnedData:true})).status,200);
  await eventually(async()=>assert.equal(resolve(p.id).DOWNGRADE_SECRET,undefined,'full revoke blocks subsequent resolution'));
  assert.equal(runningSnapshot.DOWNGRADE_SECRET,'synthetic-only');
 }finally{await Promise.all(children.map(stopDevNode));await rm(root,{recursive:true,force:true});}
});
