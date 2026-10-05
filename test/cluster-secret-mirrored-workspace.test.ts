import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {api,seedDevEnvironment,signIn,startDevNode,stopDevNode} from './dev-nodes.js';

async function eventually(check:()=>Promise<void>) {
 const until=Date.now()+30000;
 for(;;){try{await check();return;}catch(error){if(Date.now()>until)throw error;await new Promise(resolve=>setTimeout(resolve,250));}}
}

test('a secret attached to a workspace mirrored from the recipient reaches the recipient', {timeout:90000}, async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'secret-mirrored-'));
 const children:Awaited<ReturnType<typeof startDevNode>>[]=[];
 try{
  const a=await seedDevEnvironment(path.join(root,'a'),1),b=await seedDevEnvironment(path.join(root,'b'),1);
  const sharer=a.nodes[0],owner=b.nodes[0];
  children.push(await startDevNode(a,sharer),await startDevNode(b,owner));
  const sa=await signIn(a,sharer),sb=await signIn(b,owner);
  const cluster=await api<{snapshot:{body:{clusterId:string}}}>(sharer,sa,'POST','/clusters',{name:'Mirrored workspace'});
  const id=cluster.body.snapshot.body.clusterId;
  const invite=await api<{link:string}>(sharer,sa,'POST',`/clusters/${id}/invitations`,{expectedEpoch:1});
  assert.equal((await api(owner,sb,'POST','/clusters/join',{link:invite.body.link,requestId:randomUUID()})).status,201);
  const selection=await api<{workspaces:Array<{id:string}>}>(owner,sb,'GET',`/clusters/${id}/sharing`);
  const ownWorkspace=selection.body.workspaces[0].id;
  assert.equal((await api(owner,sb,'PUT',`/clusters/${id}/sharing`,{projectIds:[],workspaceIds:[ownWorkspace],confirmOwnedData:true})).status,200);
  let mirrored='',projectId='';
  await eventually(async()=>{
   const projects=await api<{projects:Array<{id:string;type:string}>}>(sharer,sa,'GET','/projects');
   const project=projects.body.projects.find(item=>owner.projects.some(own=>own.id===item.id));
   assert.ok(project,'owner project metadata arrives');
   assert.notEqual(project.type,ownWorkspace,'the sharer sees a local mirror id, not the owner workspace id');
   mirrored=project.type;projectId=project.id;
  });
  const created=await api<{account:{id:string}}>(sharer,sa,'POST','/secrets/accounts',{label:'Stripe dev',provider:'stripe',variables:[{name:'STRIPE_API_KEY',kind:'value',value:'synthetic-stripe'}]});
  const accountId=created.body.account.id;
  assert.equal((await api(sharer,sa,'PUT',`/secrets/scopes/workspace/${mirrored}`,{accountIds:[accountId]})).status,200);
  assert.equal((await api(sharer,sa,'PUT',`/secrets/accounts/${accountId}/sharing`,{grants:[{clusterId:id,nodeId:owner.nodeId}]})).status,200);
  assert.equal((await api(sharer,sa,'PUT',`/clusters/${id}/secrets`,{accountIds:[accountId]})).status,200);
  const grants=await api<{grants:Array<{clusterId:string;nodeId:string|null}>}>(sharer,sa,'GET',`/secrets/accounts/${accountId}/sharing`);
  assert.equal(grants.body.grants.length,2,'cluster sharing keeps the existing node grant');
  const inventory=await api<{granted:string[]}>(sharer,sa,'GET',`/clusters/${id}/secrets`);
  assert.deepEqual(inventory.body.granted,[accountId]);
  await eventually(async()=>{
   const secrets=await api<{accounts:Array<{id:string;readOnly?:boolean}>}>(owner,sb,'GET','/secrets');
   assert.equal(secrets.body.accounts.find(item=>item.id===accountId)?.readOnly,true);
   const assigned=await api<{accountIds:string[]}>(owner,sb,'GET',`/secrets/scopes/project/${projectId}`);
   assert.ok(assigned.body.accountIds.includes(accountId),'the owner project receives the attachment');
  });
  assert.equal((await api(sharer,sa,'PUT',`/clusters/${id}/secrets`,{accountIds:[]})).status,200);
  const remaining=await api<{grants:Array<{clusterId:string;nodeId:string|null}>}>(sharer,sa,'GET',`/secrets/accounts/${accountId}/sharing`);
  assert.deepEqual(remaining.body.grants,[{clusterId:id,nodeId:owner.nodeId}],'unticking the cluster leaves the node grant');
 }finally{await Promise.all(children.map(stopDevNode));await rm(root,{recursive:true,force:true});}
});
