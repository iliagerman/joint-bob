import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {api,seedDevEnvironment,signIn,startDevNode,stopDevNode} from './dev-nodes.js';

async function eventually(check:()=>Promise<void>) {
 const until=Date.now()+30000;
 for(;;){try{await check();return;}catch(error){if(Date.now()>until)throw error;await new Promise(resolve=>setTimeout(resolve,250));}}
}

test('individual secret destinations deliver read-only copies, rotations and revocation', {timeout:110000}, async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'secret-destinations-'));
 const children:Awaited<ReturnType<typeof startDevNode>>[]=[];
 try{
  const a=await seedDevEnvironment(path.join(root,'a'),1),b=await seedDevEnvironment(path.join(root,'b'),1),c=await seedDevEnvironment(path.join(root,'c'),1),d=await seedDevEnvironment(path.join(root,'d'),1);
  const left=a.nodes[0],right=b.nodes[0],third=c.nodes[0],isolated=d.nodes[0];
  children.push(await startDevNode(a,left),await startDevNode(b,right),await startDevNode(c,third),await startDevNode(d,isolated));
  const sa=await signIn(a,left),sb=await signIn(b,right),sc=await signIn(c,third),sd=await signIn(d,isolated);
  const cluster=await api<{snapshot:{body:{clusterId:string}}}>(left,sa,'POST','/clusters',{name:'Secrets test'});
  assert.equal(cluster.status,201);
  const id=cluster.body.snapshot.body.clusterId;
  const invite=await api<{link:string}>(left,sa,'POST',`/clusters/${id}/invitations`,{expectedEpoch:1});
  assert.equal(invite.status,201);
  assert.equal((await api(right,sb,'POST','/clusters/join',{link:invite.body.link,requestId:randomUUID()})).status,201);
  const nextInvite=await api<{link:string}>(left,sa,'POST',`/clusters/${id}/invitations`,{expectedEpoch:1});
  assert.equal(nextInvite.status,201);
  assert.equal((await api(third,sc,'POST','/clusters/join',{link:nextInvite.body.link,requestId:randomUUID()})).status,201);
  const created=await api<{account:{id:string}}>(left,sa,'POST','/secrets/accounts',{label:'Shared canary',provider:'custom',variables:[{name:'CANARY',kind:'value',value:'synthetic-1'}]});
  assert.equal(created.status,201);
  const accountId=created.body.account.id;
  const endpoint=`/secrets/accounts/${accountId}/sharing`;
  await eventually(async()=>{const destinations=await api<{clusters:Array<{id:string;nodes:Array<{id:string}>}>}>(left,sa,'GET','/secrets/destinations');assert.ok(destinations.body.clusters.find(c=>c.id===id)?.nodes.some(n=>n.id===right.nodeId));});
  assert.equal((await api(left,sa,'PUT',endpoint,{grants:[{clusterId:id,nodeId:right.nodeId}]})).status,200);
  await eventually(async()=>{const result=await api<{accounts:Array<{id:string;readOnly?:boolean;shared?:boolean}>}>(right,sb,'GET','/secrets');assert.equal(result.body.accounts.find(a=>a.id===accountId)?.readOnly,true);assert.equal(result.body.accounts.find(a=>a.id===accountId)?.shared,true);});
  const excluded=await api<{accounts:Array<{id:string}>}>(third,sc,'GET','/secrets');
  assert.equal(excluded.body.accounts.some(a=>a.id===accountId),false,'node-specific grant must not reach another cluster member');
  assert.equal((await api(left,sa,'PUT',endpoint,{grants:[{clusterId:id,nodeId:null}]})).status,200);
  await eventually(async()=>{const response=await api<{accounts:Array<{id:string}>}>(third,sc,'GET','/secrets');assert.ok(response.body.accounts.some(a=>a.id===accountId));});
  assert.equal((await api(left,sa,'PUT',endpoint,{grants:[{clusterId:id,nodeId:right.nodeId}]})).status,200);
  await eventually(async()=>{const response=await api<{accounts:Array<{id:string}>}>(third,sc,'GET','/secrets');assert.equal(response.body.accounts.some(a=>a.id===accountId),false);});
  const remote=await api<{accounts:Array<{id:string;variables:Array<{name:string;value?:string}>}>}>(right,sb,'GET','/secrets');
  assert.equal(remote.body.accounts.find(a=>a.id===accountId)?.variables[0].value,undefined,'list does not disclose value');
  assert.equal((await api(right,sb,'PUT',`/secrets/accounts/${accountId}`,{label:'Tamper',provider:'custom',variables:[{name:'CANARY',kind:'value',value:'synthetic-tamper'}]})).status,403);
  assert.equal((await api(right,sb,'DELETE',`/secrets/accounts/${accountId}`)).status,403);
  assert.equal((await api(right,sb,'GET',endpoint)).status,403);
  assert.equal((await api(right,sb,'PUT',endpoint,{grants:[]})).status,403);
  assert.equal((await api(left,sa,'PUT',`/secrets/accounts/${accountId}`,{label:'Rotated canary',provider:'custom',variables:[{name:'CANARY',kind:'value',value:'synthetic-2'}]})).status,200);
  await eventually(async()=>{const response=await api<{accounts:Array<{id:string;label:string}>}>(right,sb,'GET','/secrets');assert.equal(response.body.accounts.find(a=>a.id===accountId)?.label,'Rotated canary');});
  const inventory=await api<{received:Array<{id:string}>}>(right,sb,'GET',`/clusters/${id}/secrets`);
  assert.ok(inventory.body.received.some(a=>a.id===accountId));
  const selection=await api<{workspaces:Array<{id:string}>;projects:Array<{id:string;workspaceId:string}>}>(left,sa,'GET',`/clusters/${id}/sharing`);
  const workspace=selection.body.workspaces[0].id;
  const workspaceAccount=await api<{account:{id:string}}>(left,sa,'POST','/secrets/accounts',{label:'Workspace canary',provider:'custom',variables:[{name:'WORKSPACE_CANARY',kind:'value',value:'synthetic-workspace'}]});
  assert.equal(workspaceAccount.status,201);
  assert.equal((await api(left,sa,'PUT',`/secrets/scopes/workspace/${workspace}`,{accountIds:[workspaceAccount.body.account.id]})).status,200);
  assert.equal((await api(left,sa,'PUT',`/clusters/${id}/sharing`,{projectIds:[],workspaceIds:[workspace],confirmOwnedData:true})).status,200);
  await eventually(async()=>{
   const response=await api<{accounts:Array<{id:string;readOnly?:boolean}>}>(right,sb,'GET','/secrets');
   assert.equal(response.body.accounts.find(a=>a.id===workspaceAccount.body.account.id)?.readOnly,true);
   const projects=await api<{projects:Array<{id:string;type:string}>}>(right,sb,'GET','/projects');
   const shared=projects.body.projects.find(project=>left.projects.some(local=>local.id===project.id));
   assert.ok(shared,'workspace project metadata arrives');
   const assignments=await api<{accountIds:string[]}>(right,sb,'GET',`/secrets/scopes/workspace/${shared.type}`);
   assert.ok(assignments.body.accountIds.includes(workspaceAccount.body.account.id),'recipient workspace receives inherited attachment');
  });
  const workspaceInventory=await api<{shared:Array<{id:string}>}>(left,sa,'GET',`/clusters/${id}/secrets`);
  assert.ok(workspaceInventory.body.shared.some(a=>a.id===workspaceAccount.body.account.id));
  const otherCluster=await api<{snapshot:{body:{clusterId:string}}}>(left,sa,'POST','/clusters',{name:'Unrelated cluster'});
  assert.equal(otherCluster.status,201);
  const otherId=otherCluster.body.snapshot.body.clusterId;
  const otherInvite=await api<{link:string}>(left,sa,'POST',`/clusters/${otherId}/invitations`,{expectedEpoch:1});
  assert.equal(otherInvite.status,201);
  assert.equal((await api(isolated,sd,'POST','/clusters/join',{link:otherInvite.body.link,requestId:randomUUID()})).status,201);
  const otherWorkspace=await api<{workspace:{id:string}}>(left,sa,'PUT','/workspaces',{label:'Other credentials workspace'});
  assert.equal(otherWorkspace.status,200);
  const projectPath=path.join(root,'other-project');await mkdir(projectPath);
  const createdProject=await api<{project:{id:string}}>(left,sa,'POST','/projects',{name:'Unrelated project',type:otherWorkspace.body.workspace.id,path:projectPath,synced:false});
  assert.equal(createdProject.status,201);
  const workProject=createdProject.body.project;
  assert.equal((await api(left,sa,'PUT',`/secrets/scopes/project/${workProject.id}`,{accountIds:[workspaceAccount.body.account.id]})).status,200);
  assert.equal((await api(left,sa,'PUT',`/clusters/${otherId}/sharing`,{projectIds:[workProject.id],workspaceIds:[],confirmOwnedData:true})).status,200);
  await eventually(async()=>{const projects=await api<{projects:Array<{id:string}>}>(isolated,sd,'GET','/projects');assert.ok(projects.body.projects.some(p=>p.id===workProject.id));});
  // Wait for the credential snapshot to run after project delivery, not just for metadata.
  await new Promise(resolve=>setTimeout(resolve,2000));
  const unrelated=await api<{accounts:Array<{id:string}>}>(isolated,sd,'GET','/secrets');
  assert.equal(unrelated.body.accounts.some(a=>a.id===workspaceAccount.body.account.id),false,'workspace grant must not leak into another cluster through a project attachment');
  const projectSecret=await api<{account:{id:string}}>(left,sa,'POST','/secrets/accounts',{label:'Project canary',provider:'custom',projectId:workProject.id,variables:[{name:'PROJECT_CANARY',kind:'value',value:'synthetic-project'}]});
  assert.equal(projectSecret.status,201);
  const projectSecretSharing=`/secrets/accounts/${projectSecret.body.account.id}/sharing`;
  assert.equal((await api(left,sa,'PUT',projectSecretSharing,{grants:[{clusterId:otherId,nodeId:isolated.nodeId}]})).status,200);
  await eventually(async()=>{
   const response=await api<{accounts:Array<{id:string;projectId?:string;readOnly?:boolean}>}>(isolated,sd,'GET','/secrets');
   assert.equal(response.body.accounts.find(a=>a.id===projectSecret.body.account.id)?.projectId,workProject.id);
   assert.equal(response.body.accounts.find(a=>a.id===projectSecret.body.account.id)?.readOnly,true);
  });
  const assigned=await api<{accountIds:string[]}>(isolated,sd,'GET',`/secrets/scopes/project/${workProject.id}`);
  assert.ok(assigned.body.accountIds.includes(projectSecret.body.account.id));
  assert.equal((await api(left,sa,'PUT',`/clusters/${otherId}/sharing`,{projectIds:[],workspaceIds:[],confirmOwnedData:true})).status,200);
  await eventually(async()=>{const response=await api<{accounts:Array<{id:string}>}>(isolated,sd,'GET','/secrets');assert.equal(response.body.accounts.some(a=>a.id===projectSecret.body.account.id),false,'unsharing the owner project revokes its secret even while the account grant remains');});
  assert.equal((await api(left,sa,'PUT',projectSecretSharing,{grants:[]})).status,200);
  assert.equal((await api(left,sa,'PUT',`/clusters/${id}/sharing`,{projectIds:[],workspaceIds:[],confirmOwnedData:true})).status,200);
  await eventually(async()=>{const response=await api<{accounts:Array<{id:string}>}>(right,sb,'GET','/secrets');assert.equal(response.body.accounts.some(a=>a.id===workspaceAccount.body.account.id),false);});
  assert.equal((await api(left,sa,'PUT',endpoint,{grants:[]})).status,200);
  await eventually(async()=>{const response=await api<{accounts:Array<{id:string}>}>(right,sb,'GET','/secrets');assert.equal(response.body.accounts.some(a=>a.id===accountId),false);});
 }finally{await Promise.all(children.map(stopDevNode));await rm(root,{recursive:true,force:true});}
});
