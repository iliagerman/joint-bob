import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

test("authoritative twin initialization then bidirectional additions edits and deletions without shared disk", { timeout: 180_000 }, async () => {
 const root = await mkdtemp(path.join(os.tmpdir(),"twin-sync-api-"));
 const servers: Awaited<ReturnType<typeof startDevNode>>[]=[];
 try {
  const ae=await seedDevEnvironment(path.join(root,"mac"),1),be=await seedDevEnvironment(path.join(root,"homeserver"),1);
  const a=ae.nodes[0],b=be.nodes[0], env={...ae,nodes:[a,b]};
  const ar=path.join(ae.home,"JointBob/.agent-resources/shared/skills"),br=path.join(be.home,"JointBob/.agent-resources/shared/skills");
  const put=async(dir:string,name:string,text:string)=>{await mkdir(path.join(dir,name),{recursive:true});await writeFile(path.join(dir,name,"SKILL.md"),`---\nname: ${name}\ndescription: Sync fixture\n---\n${text}`);};
  await put(ar,"common","mac");await put(ar,"mac-only","initial");await put(br,"common","server");await put(br,"server-extra","extra");
  servers.push(await startDevNode(ae,a),await startDevNode(be,b));const relationshipId=await pairTwinNodes(env);
  const sa=await signIn(ae,a),sb=await signIn(be,b);
  const preview=await api<{token:string;plan:{add:string[];replace:string[];remove:string[]}}>(a,sa,"POST","/resources/skills/twin-sync/preview",{peerNodeId:b.nodeId});
  assert.equal(preview.status,200,JSON.stringify(preview.body));
  assert.deepEqual(preview.body.plan.add,["mac-only"]);assert.deepEqual(preview.body.plan.replace,["common"]);assert.deepEqual(preview.body.plan.remove,["server-extra"]);
  await put(ar,"mac-only","changed after preview");
  assert.equal((await api(a,sa,"POST","/resources/skills/twin-sync/initialize",{token:preview.body.token})).status,409,"source changes invalidate destructive preview");
  const second=await api<{token:string}>(a,sa,"POST","/resources/skills/twin-sync/preview",{peerNodeId:b.nodeId});
  await put(br,"server-extra","changed destination");
  assert.equal((await api(a,sa,"POST","/resources/skills/twin-sync/initialize",{token:second.body.token})).status,409,"destination changes invalidate destructive preview");
  const fresh=await api<{token:string}>(a,sa,"POST","/resources/skills/twin-sync/preview",{peerNodeId:b.nodeId});
  const initialized=await api(a,sa,"POST","/resources/skills/twin-sync/initialize",{token:fresh.body.token});
  assert.equal(initialized.status,200,JSON.stringify(initialized.body));
  assert.match(await readFile(path.join(br,"common/SKILL.md"),"utf8"),/mac$/);
  await assert.rejects(readFile(path.join(br,"server-extra/SKILL.md")),{code:"ENOENT"});
  const tick=async()=>{ for(let i=0;i<2;i++)for(const [node,session] of [[a,sa],[b,sb]] as const){ const r=await api(node,session,"POST","/resources/skills/twin-sync/refresh",{});assert.equal(r.status,200,JSON.stringify(r.body)); } };
  await put(br,"server-new","from server");await tick();assert.match(await readFile(path.join(ar,"server-new/SKILL.md"),"utf8"),/from server$/);
  await put(ar,"common","edited mac");await tick();assert.match(await readFile(path.join(br,"common/SKILL.md"),"utf8"),/edited mac$/);
  const removed=await api(b,sb,"DELETE","/resources/skills/mac-only");assert.equal(removed.status,200,JSON.stringify(removed.body));
  await tick();await assert.rejects(readFile(path.join(ar,"mac-only/SKILL.md")),{code:"ENOENT"});
  // A later explicit import is a new edit, not resurrection by a stale replica.
  const source=path.join(root,"reimport/mac-only");await put(path.dirname(source),"mac-only","explicit import");
  assert.equal((await api(a,sa,"POST","/settings/skills/sync",{paths:[source]})).status,200);
  await tick();assert.match(await readFile(path.join(br,"mac-only/SKILL.md"),"utf8"),/explicit import$/);
  // Concurrent edits retain recoverable copies on both nodes and explicit resolution propagates.
  const pause=async(paused:boolean)=>{for(const [node,session] of [[a,sa],[b,sb]] as const)assert.equal((await api(node,session,"PUT","/resources/skills/twin-sync",{paused})).status,200);};
  await pause(true);await put(ar,"common","concurrent mac");await put(br,"common","concurrent server");await pause(false);await tick();
  assert.equal(await readFile(path.join(ar,"common/SKILL.md"),"utf8"),await readFile(path.join(br,"common/SKILL.md"),"utf8"));
  type Status={conflicts:Array<{name:string;digest:string}>;session:{state:string;error:string|null}};
  const conflicted=await api<Status>(a,sa,"GET","/resources/skills/twin-sync");
  assert.equal(conflicted.body.conflicts.length,1);
  assert.equal((await api<Status>(b,sb,"GET","/resources/skills/twin-sync")).body.conflicts.length,1);
  assert.equal((await api(a,sa,"POST","/resources/skills/twin-sync/resolve",{name:"common",digest:conflicted.body.conflicts[0].digest})).status,200);
  await tick();assert.equal((await api<Status>(b,sb,"GET","/resources/skills/twin-sync")).body.conflicts.length,0);
  // An offline twin restarting with old files must learn the tombstone, not resurrect them.
  await pause(true);await stopDevNode(servers.pop()!);
  assert.equal((await api(a,sa,"DELETE","/resources/skills/mac-only")).status,200);
  await put(ar,"offline-new","offline content");
  servers.push(await startDevNode(be,b));await pause(false);await tick();
  await assert.rejects(readFile(path.join(br,"mac-only/SKILL.md")),{code:"ENOENT"});
  assert.match(await readFile(path.join(br,"offline-new/SKILL.md"),"utf8"),/offline content$/);
  const stale=await api<{token:string}>(a,sa,"POST","/resources/skills/twin-sync/preview",{peerNodeId:b.nodeId});
  assert.equal(stale.status,409,"cannot silently reset an initialized relationship");
  const ce=await seedDevEnvironment(path.join(root,"third"),1),c=ce.nodes[0];servers.push(await startDevNode(ce,c));
  await pairTwinNodes({...ae,nodes:[a,c]});
  assert.equal((await api(a,sa,"POST","/resources/skills/twin-sync/preview",{peerNodeId:c.nodeId})).status,409,"only one skill-sync partner is permitted");
  const thirdRead=await signedNodeRequest(ce,c,a,"POST","/api/cluster/v2/skills/twin-sync/manifest",{offset:0});
  assert.equal(thirdRead.status,409,"another active twin cannot read this relationship's skill history");
  assert.equal((await api(b,sb,"DELETE",`/twins/${relationshipId}`)).status,200);
  for(const [route,payload] of [["manifest",{offset:0}],["bundle",{name:"common",digest:"a".repeat(64)}],["initialize",{}],["ack",{versions:[]}]] as const){
   const rejected=await signedNodeRequest(ae,a,b,"POST",`/api/cluster/v2/skills/twin-sync/${route}`,payload);
   assert.equal(rejected.status,403,`${route} rejects a revoked twin before processing data`);
  }
 } finally {for(const server of servers)await stopDevNode(server);await rm(root,{recursive:true,force:true});}
});
