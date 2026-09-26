import assert from "node:assert/strict";
import {mkdtemp,mkdir,rm,writeFile,readFile,readdir,symlink} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {randomUUID} from "node:crypto";
import test from "node:test";
import {DatabaseSync} from "node:sqlite";
import {api,seedDevEnvironment,signIn,startDevNode,stopDevNode} from "./dev-nodes.js";
import {signedNodeRequest} from './signed-node-request.js';
import {startNativeSyncthing,stopNativeSyncthing} from "./native-syncthing.js";

async function eventually(check:()=>Promise<void>):Promise<void>{
 const deadline=Date.now()+30000;
 while(true){try{await check();return;}catch(error){if(Date.now()>deadline)throw error;}await new Promise(r=>setTimeout(r,200));}
}
test("selected projects transfer only their files, transcripts and attached eligible secrets; deselection revokes",{timeout:150000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"selected-runtime-"));
 const children:Awaited<ReturnType<typeof startDevNode>>[]=[],syncs:Awaited<ReturnType<typeof startNativeSyncthing>>[]=[];
 try{
  const a=await seedDevEnvironment(path.join(root,"a"),1),b=await seedDevEnvironment(path.join(root,"b"),1),left=a.nodes[0],right=b.nodes[0];
  // Independently seeded nodes reuse demo conversation UUIDs. Start the recipient's
  // transcript roots empty rather than manufacturing cross-project identity collisions.
  await rm(path.join(b.home,'.pi','sessions'),{recursive:true,force:true});
  await rm(path.join(b.home,'.claude','projects'),{recursive:true,force:true});
  const syncA=await startNativeSyncthing(path.join(root,"st-a"));syncs.push(syncA);
  const syncB=await startNativeSyncthing(path.join(root,"st-b"));syncs.push(syncB);
  for(const [local,peer]of[[syncA,syncB],[syncB,syncA]])await local.request(`config/devices/${peer.deviceId}`,{deviceID:peer.deviceId,name:"Selected test peer",addresses:[peer.address]});
  for(const [env,node,sync]of[[a,left,syncA],[b,right,syncB]]as const)children.push(await startDevNode(env,node,{JOINT_BOB_SYNCTHING_URL:sync.url,JOINT_BOB_SYNCTHING_API_KEY:sync.key}));
  const sa=await signIn(a,left),sb=await signIn(b,right);
  const cluster=await api<{snapshot:{body:{clusterId:string}}}>(left,sa,"POST","/clusters",{name:"Selected runtime"});assert.equal(cluster.status,201);
  const clusterId=cluster.body.snapshot.body.clusterId;
  const invitation=await api<{link:string}>(left,sa,"POST",`/clusters/${clusterId}/invitations`,{expectedEpoch:1});assert.equal(invitation.status,201,JSON.stringify(invitation.body));
  assert.equal((await api(right,sb,"POST","/clusters/join",{link:invitation.body.link,requestId:randomUUID()})).status,201);
  const shared=left.projects.find(p=>p.name==='Internal Assistant')!,hidden=left.projects.find(p=>p.name==='Infra Scripts')!;
  await writeFile(path.join(shared.path,"selected.txt"),"selected file bytes");
  const selectedAccount=await api<{account:{id:string}}>(left,sa,'POST','/secrets/accounts',{label:'Selected credential',provider:'custom',replicate:true,variables:[{name:'SELECTED_SECRET',kind:'value',value:'synthetic-selected-value'}]});
  const hiddenAccount=await api<{account:{id:string}}>(left,sa,'POST','/secrets/accounts',{label:'Private credential',provider:'custom',replicate:true,variables:[{name:'PRIVATE_SECRET',kind:'value',value:'synthetic-private-value'}]});
  assert.equal(selectedAccount.status,201);assert.equal(hiddenAccount.status,201);
  assert.equal((await api(left,sa,'PUT',`/secrets/scopes/project/${shared.id}`,{accountIds:[selectedAccount.body.account.id]})).status,200);
  assert.equal((await api(left,sa,'PUT',`/secrets/scopes/project/${hidden.id}`,{accountIds:[hiddenAccount.body.account.id]})).status,200);
  const selection=`/clusters/${clusterId}/sharing`;
  assert.equal((await api(left,sa,"PUT",selection,{projectIds:[shared.id],workspaceIds:[],confirmOwnedData:true})).status,200);
  let remotePath='';
  await eventually(async()=>{
   const inventory=await api<{projects:Array<{id:string;path:string}>}>(right,sb,"GET","/projects");
   assert.equal(inventory.body.projects.some(p=>p.id===hidden.id),false,'unselected project metadata stays local');
   const project=inventory.body.projects.find(p=>p.id===shared.id);assert.ok(project);remotePath=project.path;
   assert.equal(await readFile(path.join(remotePath,"selected.txt"),'utf8'),'selected file bytes');
  });
  const source=await api<{sessions:Array<{id:string;harnessId:string}>}>(left,sa,"GET",`/projects/${shared.id}/sessions`);assert.ok(source.body.sessions.length>0);
  await eventually(async()=>{
   const sessions=await api<{sessions:Array<{id:string;draft?:boolean}>}>(right,sb,"GET",`/projects/${shared.id}/sessions`);
   const db=new DatabaseSync(path.join(right.dataDir,'node.db'));
   let errors:unknown;try{errors=db.prepare('SELECT error FROM cluster_v2_transcript_errors').all();}finally{db.close();}
   assert.ok(source.body.sessions.every(session=>sessions.body.sessions.some(remote=>remote.id===session.id&&!remote.draft)),`selected conversations must arrive without global transcript enrollment: ${JSON.stringify(errors)}`);
  });
  const conversation=source.body.sessions[0];
  const ownershipTarget='/api/cluster/v2/runtime/sessions/ownership?'+new URLSearchParams({engine:conversation.harnessId,sessionId:conversation.id});
  await eventually(async()=>{assert.equal((await signedNodeRequest(a,left,right,'GET',ownershipTarget)).status,200,'selected runtime must authorize the shared conversation');});
  await eventually(async()=>{
   const secrets=await api<{accounts:Array<{id:string}>}>(right,sb,'GET','/secrets');
   assert.ok(secrets.body.accounts.some(account=>account.id===selectedAccount.body.account.id),'selected project credentials must arrive');
   assert.equal(secrets.body.accounts.some(account=>account.id===hiddenAccount.body.account.id),false,'unselected credentials must stay local');
  });
  const privateSessions=await api<{sessions:Array<{id:string;harnessId:string}>}>(left,sa,'GET',`/projects/${hidden.id}/sessions`);
  const privateSession=privateSessions.body.sessions[0];assert.ok(privateSession);
  const privateTranscript='/api/cluster/v2/transcripts/file?'+new URLSearchParams({projectId:hidden.id,engine:privateSession.harnessId,sessionId:privateSession.id});
  assert.equal((await signedNodeRequest(b,right,left,'GET',privateTranscript)).status,403,'unselected transcript project is forbidden');
  const disguisedTranscript='/api/cluster/v2/transcripts/file?'+new URLSearchParams({projectId:shared.id,engine:privateSession.harnessId,sessionId:privateSession.id});
  assert.equal((await signedNodeRequest(b,right,left,'GET',disguisedTranscript)).status,404,'shared project cannot authorize another project transcript ID');
  await writeFile(path.join(hidden.path,'private.txt'),'private file canary');
  await symlink(path.join(hidden.path,'private.txt'),path.join(shared.path,'escape.txt'));
  const fileTarget=(projectId:string,file:string,taskId?:string)=>'/api/cluster/v2/runtime/project-file-content?'+new URLSearchParams({projectId,path:file,...(taskId?{taskId}:{})});
  assert.equal((await signedNodeRequest(b,right,left,'GET',fileTarget(hidden.id,'private.txt'))).status,403);
  assert.equal((await signedNodeRequest(b,right,left,'GET',fileTarget(shared.id,'escape.txt'))).status,403,'shared file symlink cannot escape project');
  assert.equal((await signedNodeRequest(b,right,left,'GET',fileTarget(shared.id,'../private.txt'))).status,403,'shared file traversal rejected');
  await rm(path.join(shared.path,'escape.txt'));
  const privateTask=await api<{task:{id:string;title:string}}>(left,sa,'POST',`/projects/${hidden.id}/tasks`,{title:'Private task canary',description:'',status:'backlog',engine:'pi',phaseConfig:{}});
  assert.equal(privateTask.status,201);
  const mismatched=await signedNodeRequest(b,right,left,'PATCH','/api/cluster/v2/runtime/tasks/update',{projectId:shared.id,taskId:privateTask.body.task.id,update:{title:'Unauthorized change'}});
  assert.equal(mismatched.status,404,'a shared project must not authorize a global task ID belonging to another project');
  const privateTasks=await api<{tasks:Array<{id:string;title:string}>}>(left,sa,'GET',`/projects/${hidden.id}/tasks`);
  assert.equal(privateTasks.body.tasks.find(task=>task.id===privateTask.body.task.id)?.title,'Private task canary');
  assert.equal((await signedNodeRequest(b,right,left,'GET',fileTarget(shared.id,'private.txt',privateTask.body.task.id))).status,404,'task file roots require matching project');
  const c=await seedDevEnvironment(path.join(root,'c'),1),third=c.nodes[0];
  await rm(path.join(c.home,'.pi','sessions'),{recursive:true,force:true});await rm(path.join(c.home,'.claude','projects'),{recursive:true,force:true});
  const syncC=await startNativeSyncthing(path.join(root,'st-c'));syncs.push(syncC);
  for(const [local,peer]of[[syncB,syncC],[syncC,syncB]])await local.request(`config/devices/${peer.deviceId}`,{deviceID:peer.deviceId,name:'Privacy test peer',addresses:[peer.address]});
  children.push(await startDevNode(c,third,{JOINT_BOB_SYNCTHING_URL:syncC.url,JOINT_BOB_SYNCTHING_API_KEY:syncC.key}));
  const sc=await signIn(c,third);
  const twin=await api<{link:string}>(right,sb,'POST','/twins/invitations',{confirmOwnedData:true});
  assert.equal((await api(third,sc,'POST','/twins/accept',{link:twin.body.link,confirmOwnedData:true})).status,201);
  const canaryPath=path.join(root,'b-owned');await mkdir(canaryPath);await writeFile(path.join(canaryPath,'canary.txt'),'authorized B-owned bytes');
  const canary=await api<{project:{id:string}}>(right,sb,'POST','/projects',{name:'B owned canary',type:'personal',path:canaryPath,synced:true});assert.equal(canary.status,201);
  await eventually(async()=>{
   const inventory=await api<{projects:Array<{id:string;path:string}>}>(third,sc,'GET','/projects');
   assert.equal(inventory.body.projects.some(p=>p.id===shared.id),false,'a twin must not inherit third-party-owned project access');
   const project=inventory.body.projects.find(p=>p.id===canary.body.project.id);assert.ok(project);
   assert.equal(await readFile(path.join(project.path,'canary.txt'),'utf8'),'authorized B-owned bytes');
  });
  const bFolders=await syncB.request<Array<{id:string;path:string;devices:Array<{deviceID:string}>}>>('config/folders');
  for(const folder of bFolders.filter(folder=>folder.devices.some(device=>device.deviceID===syncC.deviceId))){
   assert.notEqual(folder.path,path.join(b.home,'.pi','sessions'),'whole transcript roots leak third-party projects to twins');
   assert.notEqual(folder.path,path.join(b.home,'.claude','projects'),'whole transcript roots leak third-party projects to twins');
   assert.notEqual(folder.path,path.join(b.home,'JointBob','tickets'),'whole ticket roots leak third-party projects to twins');
  }
  for(const transcriptRoot of [path.join(c.home,'.pi','sessions'),path.join(c.home,'.claude','projects')]){
   const files=await readdir(transcriptRoot,{recursive:true}).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;});
   assert.equal(files.some(file=>source.body.sessions.some(session=>file.includes(session.id))),false,'third node receives no unauthorized transcript bytes');
  }
  assert.equal((await signedNodeRequest(c,third,right,'GET',ownershipTarget)).status,403,'twin runtime must reject third-party-owned conversation access');
  const thirdSecrets=await api<{accounts:Array<{id:string}>}>(third,sc,'GET','/secrets');assert.equal(thirdSecrets.body.accounts.some(account=>account.id===selectedAccount.body.account.id),false);
  const nativeFolders=await syncA.request<Array<{id:string;devices:Array<{deviceID:string}>}>>("config/folders");
  assert.equal(nativeFolders.some(folder=>folder.id.includes('conversations')&&folder.devices.some(d=>d.deviceID===syncB.deviceId)),false,'selected mode never enrolls global transcripts');
  assert.equal((await api(left,sa,"PUT",selection,{projectIds:[],workspaceIds:[],confirmOwnedData:true})).status,200);
  await eventually(async()=>{
   const inventory=await api<{projects:Array<{id:string}>}>(right,sb,"GET","/projects");assert.equal(inventory.body.projects.some(p=>p.id===shared.id),false);
   const folders=await syncA.request<Array<{path:string;devices:Array<{deviceID:string}>}>>("config/folders");assert.equal(folders.some(f=>f.path===shared.path&&f.devices.some(d=>d.deviceID===syncB.deviceId)),false);
   const secrets=await api<{accounts:Array<{id:string}>}>(right,sb,'GET','/secrets');assert.equal(secrets.body.accounts.some(account=>account.id===selectedAccount.body.account.id),false,'revocation removes only received scoped credential copies');
  });
  assert.equal(await readFile(path.join(remotePath,'selected.txt'),'utf8'),'selected file bytes');
 }finally{await Promise.all(children.map(stopDevNode));await Promise.all(syncs.map(s=>stopNativeSyncthing(s.child)));await rm(root,{recursive:true,force:true});}
});
