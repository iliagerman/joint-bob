import assert from "node:assert/strict";
import { mkdtemp,mkdir,readFile,writeFile,rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {DatabaseSync} from 'node:sqlite';
import {enqueueReplicationEvent} from '../src/replication.js';
import { api,seedDevEnvironment,signIn,startDevNode,stopDevNode } from "./dev-nodes.js";
import { startNativeSyncthing,stopNativeSyncthing } from "./native-syncthing.js";

test("twins enroll new project files using native Syncthing and revoke device access",{timeout:120000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"twin-native-files-"));
 const children:Awaited<ReturnType<typeof startDevNode>>[]=[],syncs:Awaited<ReturnType<typeof startNativeSyncthing>>[]=[];
 try{
  const a=await seedDevEnvironment(path.join(root,"a"),1),b=await seedDevEnvironment(path.join(root,"b"),1);
  const left=a.nodes[0],right=b.nodes[0];
  // The fixture generator reuses demo session UUIDs across independent environments.
  await rm(path.join(b.home,'.pi','sessions'),{recursive:true,force:true});
  await rm(path.join(b.home,'.claude','projects'),{recursive:true,force:true});
  const syncA=await startNativeSyncthing(path.join(root,"syncthing-a"));syncs.push(syncA);
  const syncB=await startNativeSyncthing(path.join(root,"syncthing-b"));syncs.push(syncB);
  for(const [local,peer] of [[syncA,syncB],[syncB,syncA]]) await local.request(`config/devices/${peer.deviceId}`,{deviceID:peer.deviceId,name:"Test peer",addresses:[peer.address]});
  for(const [env,sync]of [[a,syncA],[b,syncB]] as const){
    for(const [id,folder]of [['joint-bob-ticket-workspaces',path.join(env.home,'JointBob','tickets')],['joint-bob-conversations-pi',path.join(env.home,'.pi','sessions')]]){
      await mkdir(folder,{recursive:true});await sync.request(`config/folders/${id}`,{id,path:folder,type:'sendreceive',paused:true,devices:[]});
    }
  }
  const engineLog=path.join(root,'engine.log');
  for(const [env,node,sync] of [[a,left,syncA],[b,right,syncB]] as const) children.push(await startDevNode(env,node,{JOINT_BOB_SYNCTHING_URL:sync.url,JOINT_BOB_SYNCTHING_API_KEY:sync.key,JOINT_BOB_TEST_ENGINE_LOG:engineLog}));
  const sa=await signIn(a,left),sb=await signIn(b,right);
  const invitation=await api<{link:string;relationshipId:string}>(left,sa,"POST","/twins/invitations",{confirmOwnedData:true});
  assert.equal((await api(right,sb,"POST","/twins/accept",{link:invitation.body.link,confirmOwnedData:true})).status,201);
  const directory=path.join(root,"project");await mkdir(directory);await writeFile(path.join(directory,"shared.txt"),"actual native transfer");
  const created=await api<{project:{id:string}}>(left,sa,"POST","/projects",{name:"Native files",type:"personal",path:directory,synced:true});assert.equal(created.status,201);
  let transferred=false,remotePath="";
  const deadline=Date.now()+35000;
  while(Date.now()<deadline){
   const projects=await api<{projects:Array<{id:string;path:string}>}>(right,sb,"GET","/projects");
   const project=projects.body.projects.find(p=>p.id===created.body.project.id);
   if(project){remotePath=project.path;try{transferred=await readFile(path.join(project.path,"shared.txt"),"utf8")==="actual native transfer";}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
   if(transferred)break;await new Promise(r=>setTimeout(r,200));
  }
  assert.equal(transferred,true,"actual file bytes must arrive, not merely an idle Syncthing status");
  const task=await api<{task:{id:string}}>(left,sa,"POST",`/projects/${created.body.project.id}/tasks`,{title:"Shared task",description:"",status:"backlog",engine:"pi",phaseConfig:{}});
  assert.equal(task.status,201,JSON.stringify(task.body));
  const taskDeadline=Date.now()+10000;
  let taskArrived=false;
  while(Date.now()<taskDeadline){
   const tasks=await api<{tasks:Array<{id:string}>}>(right,sb,"GET",`/projects/${created.body.project.id}/tasks`);
   taskArrived=tasks.body.tasks.some(row=>row.id===task.body.task.id);if(taskArrived)break;await new Promise(r=>setTimeout(r,150));
  }
  assert.equal(taskArrived,true,'task events must replicate to twin');
  const renamedTask=await api(right,sb,"PATCH",`/projects/${created.body.project.id}/tasks/${task.body.task.id}`,{title:"Edited through twin"});
  assert.equal(renamedTask.status,200,'twin must forward task edits to current owner with signed transport');
  const note=await api<{note:{id:string}}>(left,sa,'POST','/quick-notes',{projectId:created.body.project.id,title:'Execute on twin',content:'Synthetic twin prompt',harnessId:'pi',nodeId:right.nodeId,scheduledAt:'2099-01-01T00:00:00.000Z',images:[],secretAccountIds:[]});
  assert.equal(note.status,201,JSON.stringify(note.body));
  const launch=await api<{sessionId:string;nodeId:string}>(left,sa,'POST',`/quick-notes/${note.body.note.id}/start`,{});
  assert.equal(launch.status,200,JSON.stringify(launch.body));assert.equal(launch.body.nodeId,right.nodeId);
  let runs='';const executionDeadline=Date.now()+15000;
  while(Date.now()<executionDeadline){try{runs=await readFile(engineLog,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(runs)break;await new Promise(r=>setTimeout(r,100));}
  assert.deepEqual(runs.trim().split('\n'),[`pi:${right.nodeId}`],'conversation executes exactly once on signed target twin, never locally');
  const startedTask=await api(left,sa,'PATCH',`/projects/${created.body.project.id}/tasks/${task.body.task.id}`,{status:'in_progress'});
  assert.equal(startedTask.status,200,JSON.stringify(startedTask.body));
  type ExecutedTask={id:string;sessionPath:string;worktreePath:string;currentNodeId:string;executionState:string;status:string};
  let executed:ExecutedTask|undefined;const taskRunDeadline=Date.now()+15000;
  while(Date.now()<taskRunDeadline){
    executed=(await api<{tasks:ExecutedTask[]}>(left,sa,'GET',`/projects/${created.body.project.id}/tasks`)).body.tasks.find(row=>row.id===task.body.task.id);
    if(executed?.sessionPath&&executed.worktreePath&&executed.status==='review'&&executed.executionState==='idle')break;
    await new Promise(r=>setTimeout(r,100));
  }
  assert.ok(executed?.sessionPath&&executed.worktreePath,'task produces an actual ticket workspace and conversation');
  let handedOff:Awaited<ReturnType<typeof api<{task:ExecutedTask}>>>|undefined;const handoffDeadline=Date.now()+20000;
  while(Date.now()<handoffDeadline){
    handedOff=await api<{task:ExecutedTask}>(left,sa,'POST',`/projects/${created.body.project.id}/tasks/${task.body.task.id}/handoff`,{peerId:right.nodeId});
    if(handedOff.status===200)break;await new Promise(r=>setTimeout(r,250));
  }
  const eligibility=await api(left,sa,'GET',`/projects/${created.body.project.id}/tasks/${task.body.task.id}/eligibility`);
  assert.equal(handedOff?.status,200,JSON.stringify({handoff:handedOff?.body,eligibility}));
  assert.equal(handedOff.body.task.currentNodeId,right.nodeId);
  const targetTask=(await api<{tasks:ExecutedTask[]}>(right,sb,'GET',`/projects/${created.body.project.id}/tasks`)).body.tasks.find(row=>row.id===task.body.task.id)!;
  assert.equal(await readFile(path.join(targetTask.worktreePath,'shared.txt'),'utf8'),'actual native transfer','ticket workspace bytes survive takeover');
  assert.match(await readFile(targetTask.sessionPath,'utf8'),/stubbed response/,'ticket conversation bytes survive takeover');
  for(const sync of [syncA,syncB]){
    const folders=await sync.request<Array<{id:string;paused:boolean;devices:Array<{deviceID:string}>}>>('config/folders');
    for(const id of ['joint-bob-ticket-workspaces','joint-bob-conversations-pi']){
      const folder=folders.find(folder=>folder.id===id)!;assert.equal(folder.paused,true);assert.equal(folder.devices.some(device=>device.deviceID===(sync===syncA?syncB:syncA).deviceId),false);
    }
  }
  const sharingEndpoint=`/twins/${invitation.body.relationshipId}/sharing`;
  assert.equal((await api(left,sa,"POST",sharingEndpoint,{ownerNodeId:left.nodeId,confirmOwnedData:true})).status,200);
  let ready=false;
  const readyDeadline=Date.now()+25000;
  while(Date.now()<readyDeadline){
   const state=await api<{state:string}>(left,sa,"GET",sharingEndpoint);
   ready=state.body.state==='ready';if(ready)break;await new Promise(r=>setTimeout(r,200));
  }
  assert.equal(ready,true,"ready requires acknowledged sharing and both native Syncthing indexes caught up");
  for(const [sender,recipient]of[[left,right],[right,left]]){
   const db=new DatabaseSync(path.join(sender.dataDir,'node.db'));
   const now=new Date().toISOString();
   const event=enqueueReplicationEvent(db,{originNodeId:sender.nodeId,entityType:'name.override',entityKey:`projects:${created.body.project.id}`,operation:'upsert',payload:{scope:'projects',key:created.body.project.id,name:'Pending rename',updatedAt:now,originNodeId:sender.nodeId}});
   db.prepare('INSERT INTO replication_deliveries VALUES(?,?,0,?,NULL,?)').run(event.id,recipient.nodeId,'2099-01-01T00:00:00.000Z','Synthetic replication delivery failure');
   try{
    const status=await api<{state:string;pendingDeliveries:number;error?:string}>(left,sa,'GET',sharingEndpoint);
    assert.equal(status.body.state,'error','either side replication failure must be visible, not silently pending');
    assert.equal(status.body.error,'Synthetic replication delivery failure');
    assert.ok(status.body.pendingDeliveries>0,'sharing status counts ordinary event deliveries');
   }finally{db.prepare('DELETE FROM replication_deliveries WHERE event_id=?').run(event.id);db.prepare('DELETE FROM replication_outbox WHERE event_id=?').run(event.id);db.close();}
  }
  const sourceProject=left.projects.find(project=>project.name==='Internal Assistant')!;
  const sourceSessions=await api<{sessions:Array<{id:string}>}>(left,sa,"GET",`/projects/${sourceProject.id}/sessions`);
  assert.ok(sourceSessions.body.sessions.length>0,'seeded source has real transcripts');
  const remoteSessions=await api<{sessions:Array<{id:string;draft?:boolean}>}>(right,sb,"GET",`/projects/${sourceProject.id}/sessions`);
  assert.ok(sourceSessions.body.sessions.every(session=>remoteSessions.body.sessions.some(remote=>remote.id===session.id&&!remote.draft)),
    'twin discovers transferred transcripts through source project location mapping');
  assert.equal((await api(left,sa,"DELETE",`/twins/${invitation.body.relationshipId}`)).status,200);
  const revokeDeadline=Date.now()+15000;
  let enrolled=true;
  while(Date.now()<revokeDeadline){
   const folders=await syncA.request<Array<{path:string;devices:Array<{deviceID:string}>}>>("config/folders");
   enrolled=folders.some(f=>f.path===directory&&f.devices.some(d=>d.deviceID===syncB.deviceId));
   if(!enrolled)break;await new Promise(r=>setTimeout(r,200));
  }
  assert.equal(enrolled,false,"revocation must remove the peer from native folder devices");
  assert.equal(await readFile(path.join(remotePath,"shared.txt"),"utf8"),"actual native transfer","revocation preserves files");
 }finally{await Promise.all(children.map(stopDevNode));await Promise.all(syncs.map(s=>stopNativeSyncthing(s.child)));await rm(root,{recursive:true,force:true});}
});
