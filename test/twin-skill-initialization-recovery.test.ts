import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp,mkdir,writeFile,readFile,rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { beginTwinSkillInitialization,nextSkillVersion,type TwinSkillSession } from "../src/twin-skill-sync.js";
import { api,pairTwinNodes,seedDevEnvironment,signIn,startDevNode,stopDevNode } from "./dev-nodes.js";

test("changed pending initialization can be cancelled and previewed again without losing files",{timeout:120_000},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"twin-init-recovery-")),servers:Awaited<ReturnType<typeof startDevNode>>[]=[];
 try{
  const ae=await seedDevEnvironment(path.join(root,"a"),1),be=await seedDevEnvironment(path.join(root,"b"),1),a=ae.nodes[0],b=be.nodes[0];
  const ar=path.join(ae.home,"JointBob/.agent-resources/shared/skills"),br=path.join(be.home,"JointBob/.agent-resources/shared/skills");
  const put=async(dir:string,name:string)=>{await mkdir(path.join(dir,name),{recursive:true});await writeFile(path.join(dir,name,"SKILL.md"),`---\nname: ${name}\ndescription: Recovery fixture\n---\n`);};
  await put(ar,"source");await put(br,"extra");servers.push(await startDevNode(ae,a),await startDevNode(be,b));await pairTwinNodes({...ae,nodes:[a,b]});
  const sa=await signIn(ae,a),sb=await signIn(be,b);
  const preview=await api<{token:string;relationshipId:string}>(a,sa,"POST","/resources/skills/twin-sync/preview",{peerNodeId:b.nodeId});assert.equal(preview.status,200);
  // Simulate a process interruption after both durable session writes, before the first application.
  const ad=new DatabaseSync(path.join(a.dataDir,"node.db"),{timeout:10_000}),bd=new DatabaseSync(path.join(b.dataDir,"node.db"),{timeout:10_000});
  let payload:unknown;
  try{
   const row=ad.prepare("SELECT plan FROM twin_skill_previews WHERE token=?").get(preview.body.token) as {plan:string},stored=JSON.parse(row.plan);
   const versions=[...stored.source.skills.map((s:{name:string;digest:string})=>nextSkillVersion(undefined,a.nodeId,s.digest,s.name)),...stored.plan.remove.map((n:string)=>nextSkillVersion(undefined,a.nodeId,null,n))];
   payload={token:preview.body.token,relationshipId:preview.body.relationshipId,sourceNodeId:a.nodeId,source:stored.source,destination:stored.destination,versions};
   const session:TwinSkillSession={relationshipId:preview.body.relationshipId,peerNodeId:b.nodeId,sourceNodeId:a.nodeId,state:"initializing",paused:false,lastSuccess:null,error:null,initialization:JSON.stringify(payload)};
   beginTwinSkillInitialization(ad,session,versions);beginTwinSkillInitialization(bd,{...session,peerNodeId:a.nodeId},[]);
  }finally{ad.close();bd.close();}
  await put(br,"unconfirmed-addition");
  const resumed=await api(a,sa,"POST","/resources/skills/twin-sync/refresh",{});assert.notEqual(resumed.status,200,"new destination-only skills invalidate pending baseline");
  assert.match(await readFile(path.join(br,"unconfirmed-addition/SKILL.md"),"utf8"),/unconfirmed-addition/);
  const cancelled=await api(a,sa,"POST","/resources/skills/twin-sync/cancel-initialization",{});assert.equal(cancelled.status,200,JSON.stringify(cancelled.body));
  const next=await api<{token:string;plan:{remove:string[]}}>(a,sa,"POST","/resources/skills/twin-sync/preview",{peerNodeId:b.nodeId});assert.equal(next.status,200,JSON.stringify(next.body));assert.ok(next.body.plan.remove.includes("unconfirmed-addition"));
  const retry=await api(a,sa,"POST","/resources/skills/twin-sync/initialize",{token:next.body.token});assert.equal(retry.status,200,JSON.stringify(retry.body));
  await assert.rejects(readFile(path.join(br,"unconfirmed-addition/SKILL.md")),{code:"ENOENT"});
  assert.equal((await api(b,sb,"GET","/resources/skills/twin-sync")).status,200);
 }finally{for(const s of servers)await stopDevNode(s);await rm(root,{recursive:true,force:true});}
});
