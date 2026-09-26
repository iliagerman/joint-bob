import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from 'node:crypto';
import { createTwinInvitation, prepareTwinAcceptance, confirmTwinAcceptance, applyTwinCertificate } from '../src/cluster-twins.js';
import { recordPeerEndpoint } from '../src/cluster-peer-endpoints.js';
import { activateSelectiveSharing } from '../src/cluster-v2-mode.js';
import { registerLocalSharingResource } from '../src/cluster-sharing.js';
import { DatabaseSync } from "node:sqlite";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("confirmed twins adopt mirrored IDs without changing local paths or established owners", {timeout:120_000}, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),"twin-adoption-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[]=[];
  const handles: DatabaseSync[]=[];
  try {
    const a=await seedDevEnvironment(path.join(root,"a"),1),b=await seedDevEnvironment(path.join(root,"b"),1);
    const left=a.nodes[0],right=b.nodes[0];
    const da=new DatabaseSync(path.join(left.dataDir,"node.db")),db=new DatabaseSync(path.join(right.dataDir,"node.db"));handles.push(da,db);
    for (const project of da.prepare("SELECT id,name FROM projects").all() as unknown as Array<{id:string;name:string}>) {
      db.prepare("UPDATE projects SET id=? WHERE name=?").run(project.id,project.name);
    }
    const original = db.prepare("SELECT id,path FROM projects ORDER BY id").all() as unknown as Array<{id:string;path:string}>;
    children.push(await startDevNode(a,left),await startDevNode(b,right));
    const sa=await signIn(a,left),sb=await signIn(b,right);
    const cluster=await api<{snapshot:{body:{clusterId:string}}}>(right,sb,'POST','/clusters',{name:'Home manager'});
    assert.equal(cluster.status,201);
    const join=await api<{link:string}>(right,sb,'POST',`/clusters/${cluster.body.snapshot.body.clusterId}/invitations`,{expectedEpoch:1});
    assert.equal((await api(left,sa,'POST','/clusters/join',{link:join.body.link,requestId:randomUUID()})).status,201);
    const preservedId=original[0].id;
    registerLocalSharingResource(da,left.nodeId,{kind:'project',id:preservedId});
    const invitation=await api<{link:string;relationshipId:string}>(left,sa,"POST","/twins/invitations",{confirmOwnedData:true});
    assert.equal((await api(right,sb,"POST","/twins/accept",{link:invitation.body.link,confirmOwnedData:true})).status,201);
    for(const handle of [da,db])for(const row of original){
      const owner=handle.prepare("SELECT owner_node_id FROM sharing_resource_owners WHERE kind='project' AND resource_id=?").get(row.id) as {owner_node_id:string}|undefined;
      assert.equal(owner?.owner_node_id,row.id===preservedId?left.nodeId:right.nodeId,'bilateral accept uses common manager, preserving established owners, without a second completion action');
    }
    const endpoint=`/twins/${invitation.body.relationshipId}/sharing`;
    const initial=await api<{state:string}>(left,sa,"GET",endpoint);
    assert.equal(initial.status,200,"sharing status endpoint must exist");
    assert.notEqual(initial.body.state,"ready","certificate alone is not sharing readiness");
    assert.equal((await api(left,sa,"POST",endpoint,{ownerNodeId:left.nodeId})).status,400);
    assert.equal((await api(left,sa,"POST",endpoint,{ownerNodeId:"00000000-0000-4000-8000-000000000000",confirmOwnedData:true})).status,403);
    const completions=await Promise.all([
      api(left,sa,"POST",endpoint,{ownerNodeId:left.nodeId,confirmOwnedData:true}),
      api(right,sb,"POST",endpoint,{ownerNodeId:right.nodeId,confirmOwnedData:true}),
    ]);
    assert.deepEqual(completions.map(result=>result.status).sort(),[200,409],JSON.stringify(completions));
    const chosenOwner=completions[0].status===200?left.nodeId:right.nodeId;
    for(const [node,session]of [[left,sa],[right,sb]]as const){
      const retry=await api(node,session,"POST",endpoint,{ownerNodeId:chosenOwner,confirmOwnedData:true});
      assert.equal(retry.status,200,JSON.stringify(retry.body));
    }
    for(const row of original){
      assert.equal((db.prepare("SELECT path FROM projects WHERE id=?").get(row.id) as {path:string}).path,row.path);
      assert.equal((db.prepare("SELECT owner_node_id FROM sharing_resource_owners WHERE kind='project' AND resource_id=?").get(row.id) as {owner_node_id:string}).owner_node_id,row.id===preservedId?left.nodeId:chosenOwner);
    }
    assert.equal((await api(right,sb,"POST",endpoint,{ownerNodeId:chosenOwner===left.nodeId?right.nodeId:left.nodeId,confirmOwnedData:true})).status,409);
    for(const row of original) assert.equal((da.prepare("SELECT owner_node_id FROM sharing_resource_owners WHERE kind='project' AND resource_id=?").get(row.id) as {owner_node_id:string}).owner_node_id,row.id===preservedId?left.nodeId:chosenOwner);
  }finally{await Promise.all(children.map(stopDevNode));for(const db of handles)db.close();await rm(root,{recursive:true,force:true});}
});
