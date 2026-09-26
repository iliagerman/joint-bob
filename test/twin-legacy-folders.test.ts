import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {api,seedDevEnvironment,signIn,startDevNode,stopDevNode} from './dev-nodes.js';
import {startNativeSyncthing,stopNativeSyncthing} from './native-syncthing.js';

test('confirmed legacy mirrors agree owner folder ID, resume paused native folders and preserve both local paths/data',{timeout:120000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'legacy-twin-folders-'));
 const children:Awaited<ReturnType<typeof startDevNode>>[]=[],syncs:Awaited<ReturnType<typeof startNativeSyncthing>>[]=[];
 try{
  const a=await seedDevEnvironment(path.join(root,'a'),1),b=await seedDevEnvironment(path.join(root,'b'),1),left=a.nodes[0],right=b.nodes[0];
  const project=left.projects[0],mirror=right.projects.find(p=>p.name===project.name)!;
  await rm(path.join(b.home,'.pi','sessions'),{recursive:true,force:true});await rm(path.join(b.home,'.claude','projects'),{recursive:true,force:true});
  for(const [node,id,folder]of[[left,project.id,'legacy-owner-folder'],[right,mirror.id,'legacy-replica-folder']]as const){
   const db=new DatabaseSync(path.join(node.dataDir,'node.db'));
   try{db.prepare('UPDATE projects SET id=?,sync_folder_id=? WHERE id=?').run(project.id,folder,id);}finally{db.close();}
  }
  await writeFile(path.join(project.path,'owner.txt'),'owner files stay');await writeFile(path.join(mirror.path,'replica.txt'),'replica files stay');
  const syncA=await startNativeSyncthing(path.join(root,'st-a'));syncs.push(syncA);
  const syncB=await startNativeSyncthing(path.join(root,'st-b'));syncs.push(syncB);
  for(const [local,peer,folder,directory]of[[syncA,syncB,'legacy-owner-folder',project.path],[syncB,syncA,'legacy-replica-folder',mirror.path]]as const){
   await local.request(`config/devices/${peer.deviceId}`,{deviceID:peer.deviceId,name:'Mirror',addresses:[peer.address]});
   await local.request(`config/folders/${folder}`,{id:folder,label:'Legacy',path:directory,type:'sendreceive',paused:true,devices:[{deviceID:local.deviceId}],markerName:'.stfolder'});
  }
  for(const [env,node,sync]of[[a,left,syncA],[b,right,syncB]]as const)children.push(await startDevNode(env,node,{JOINT_BOB_SYNCTHING_URL:sync.url,JOINT_BOB_SYNCTHING_API_KEY:sync.key}));
  const sa=await signIn(a,left),sb=await signIn(b,right);
  const invitation=await api<{link:string;relationshipId:string}>(left,sa,'POST','/twins/invitations',{confirmOwnedData:true});
  assert.equal((await api(right,sb,'POST','/twins/accept',{link:invitation.body.link,confirmOwnedData:true})).status,201);
  let transferred=false;const deadline=Date.now()+35000;
  while(Date.now()<deadline){try{transferred=await readFile(path.join(mirror.path,'owner.txt'),'utf8')==='owner files stay'&&await readFile(path.join(project.path,'replica.txt'),'utf8')==='replica files stay';}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}if(transferred)break;await new Promise(r=>setTimeout(r,200));}
  assert.equal(transferred,true,'both pre-existing native folder contents must survive and transfer');
  const folders=await syncB.request<Array<{id:string;path:string;paused:boolean}>>('config/folders');
  assert.deepEqual(folders.filter(folder=>folder.path===mirror.path).map(folder=>({id:folder.id,paused:folder.paused})),[{id:'legacy-owner-folder',paused:false}]);
  for(const [node,directory]of[[left,project.path],[right,mirror.path]]as const){const db=new DatabaseSync(path.join(node.dataDir,'node.db'));try{assert.equal((db.prepare('SELECT path FROM projects WHERE id=?').get(project.id) as {path:string}).path,directory);}finally{db.close();}}
 }finally{await Promise.all(children.map(stopDevNode));await Promise.all(syncs.map(s=>stopNativeSyncthing(s.child)));await rm(root,{recursive:true,force:true});}
});
