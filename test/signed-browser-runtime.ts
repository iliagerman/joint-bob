import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {api,seedDevEnvironment,signIn,startDevNode,stopDevNode} from './dev-nodes.js';
import {chromeExecutable} from './ui/launch-chrome.js';

// Explicit native-browser check, outside npm test's browser-free glob.
test('selected signed peers route native browser commands and enforce profile grants without bearer peers',{timeout:90000},async()=>{
 const executable=await chromeExecutable(),root=await mkdtemp(path.join(os.tmpdir(),'signed-browser-'));
 const servers:Awaited<ReturnType<typeof startDevNode>>[]=[];
 const fixture=http.createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<title>Signed browser fixture</title><h1>Loopback only</h1>');});
 fixture.listen(0,'127.0.0.1');await once(fixture,'listening');
 try{
  const a=await seedDevEnvironment(path.join(root,'a'),1),b=await seedDevEnvironment(path.join(root,'b'),1),left=a.nodes[0],right=b.nodes[0];
  servers.push(await startDevNode(a,left,{JOINT_BOB_BROWSER_EXECUTABLE:'/test-disabled-source-browser'}),await startDevNode(b,right,{JOINT_BOB_BROWSER_EXECUTABLE:executable}));
  const sa=await signIn(a,left),sb=await signIn(b,right);
  const cluster=await api<{snapshot:{body:{clusterId:string}}}>(left,sa,'POST','/clusters',{name:'Browser selected'}),clusterId=cluster.body.snapshot.body.clusterId;
  const invitation=await api<{link:string}>(left,sa,'POST',`/clusters/${clusterId}/invitations`,{expectedEpoch:1});
  assert.equal((await api(right,sb,'POST','/clusters/join',{link:invitation.body.link,requestId:randomUUID()})).status,201);
  const projectId=left.projects[0].id;
  assert.equal((await api(left,sa,'PUT',`/clusters/${clusterId}/sharing`,{projectIds:[projectId],workspaceIds:[],confirmOwnedData:true})).status,200);
  const deadline=Date.now()+15000;
  while(!(await api<{projects:Array<{id:string}>}>(right,sb,'GET','/projects')).body.projects.some(project=>project.id===projectId)){
   assert.ok(Date.now()<deadline,'shared browser project metadata arrives');await new Promise(resolve=>setTimeout(resolve,100));
  }
  const suffix=`?nodeId=${right.nodeId}`,conversationId=randomUUID();
  const started=await api<{session:{id:string;nodeId:string;profileId:string}}>(left,sa,'POST','/browser/sessions'+suffix,{projectId,conversationId,engine:'pi',appNodeId:left.nodeId,url:`http://127.0.0.1:${(fixture.address() as {port:number}).port}`,profileName:'Synthetic profile'});
  assert.equal(started.status,201,JSON.stringify(started.body));assert.equal(started.body.session.nodeId,right.nodeId);
  const id=started.body.session.id,profileId=started.body.session.profileId;
  assert.equal((await api(left,sa,'POST',`/browser/sessions/${id}/command${suffix}`,{action:'takeControl'})).status,200);
  const evaluated=await api<{result:unknown}>(left,sa,'POST',`/browser/sessions/${id}/command${suffix}`,{action:'evaluate',expression:'document.title'});
  assert.equal(evaluated.status,200,JSON.stringify(evaluated.body));assert.equal(evaluated.body.result,'Signed browser fixture');
  const query=`?nodeId=${right.nodeId}&projectId=${projectId}`;
  const grant=await api(left,sa,'PUT',`/browser/profiles/${profileId}/access${query}`,{grant:{scope:'project',projectId}});
  assert.equal(grant.status,200,JSON.stringify(grant.body));
  assert.equal((await api(left,sa,'PUT',`/browser/profiles/${profileId}/access${query}`,{grant:{scope:'global'}})).status,403,'remote caller cannot grant global profile access');
  const denied=await api(left,sa,'PUT',`/browser/profiles/${profileId}/access${query}`,{grant:{scope:'project',projectId:right.projects[0].id}});
  assert.equal(denied.status,403,'remote caller cannot grant an unshared project');
  assert.equal((await api(left,sa,'POST',`/browser/sessions/${id}/command${suffix}`,{action:'close'})).status,200);
  const revoke=await api(right,sb,'PUT',`/browser/profiles/${profileId}/access?projectId=${projectId}`,{crossNodeAccess:false});
  assert.equal(revoke.status,200);
  const blocked=await api(left,sa,'POST','/browser/sessions'+suffix,{projectId,conversationId:randomUUID(),engine:'pi',appNodeId:left.nodeId,profileId});
  assert.equal(blocked.status,403,'profile owner can revoke cross-node launch immediately');
 }finally{await Promise.all(servers.map(stopDevNode));fixture.closeAllConnections();await new Promise<void>(resolve=>fixture.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
