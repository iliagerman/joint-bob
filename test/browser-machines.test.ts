import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import test, { before, after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { once } from "node:events";
import { api, seedDevEnvironment, startDevNode, stopDevNode, signIn, type DevEnvironment, type SignedIn } from "./dev-nodes.js";

let root: string, env: DevEnvironment, logins: SignedIn[];
const servers: ChildProcess[] = [];
const conversationId = randomUUID();
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "browser-machines-"));
  env = await seedDevEnvironment(root, 2);
  for (const node of env.nodes) servers.push(await startDevNode(env, node, { JOINT_BOB_BROWSER_EXECUTABLE: `/missing/browser-${node.key}` }));
  logins = await Promise.all(env.nodes.map(node => signIn(env, node)));
}, { timeout: 120000 });
after(async () => { await Promise.all(servers.map(stopDevNode)); await rm(root, { recursive: true, force: true }); });
function query() { return new URLSearchParams({ projectId: env.nodes[0].projects[0].id, engine: "pi", conversationId }); }
async function request(index: number, method: string, url: string, body?: unknown) { return api<any>(env.nodes[index], logins[index], method, url, body); }
async function childCode(index: number, code: string) {
  const node=env.nodes[index];
  const result=await promisify(execFile)(process.execPath,["--import","tsx","--input-type=module","-e",code],{env:{...process.env,HOME:env.home,JOINT_BOB_DATA_DIR:node.dataDir}});
  return JSON.parse(result.stdout);
}
async function agent(index: number, body: unknown, engine: "pi" | "claude" = "pi") {
  const token=await childCode(index,`import { browserAgentEnvironment } from './src/browser-agent.ts';console.log(JSON.stringify(browserAgentEnvironment(${JSON.stringify(env.nodes[index].projects[0].id)},${JSON.stringify(engine)},${JSON.stringify(conversationId)}).JOINT_BOB_BROWSER_TOKEN));`);
  const response=await fetch(`${env.nodes[index].url}/api/browser/agent`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(body)});
  return {status:response.status,body:response.headers.get("content-type")?.includes("application/json") ? await response.json() : await response.text()};
}
async function seedSession(index: number) {
  const node = env.nodes[index];
  const code = `import { BrowserStore } from './src/browser-store.ts'; const s = new BrowserStore(); const p=s.createProfile(${JSON.stringify(node.projects[0].id)},'Synthetic account ${randomUUID()}'); const r=s.create({projectId:p.projectId,engine:'pi',conversationId:${JSON.stringify(conversationId)},appNodeId:${JSON.stringify(env.nodes[0].nodeId)},profileId:p.id});s.finish(r.id,'closed');console.log(JSON.stringify(r));s.close();`;
  return childCode(index,code);
}

test("global default and scoped conversation preference converge across real paired nodes", async () => {
  const [a,b] = env.nodes;
  const initial = await request(0, "GET", "/browser/status");
  assert.equal(initial.body.config.executorNodeId, null);
  assert.deepEqual(initial.body.nodes.map((n: any) => n.id).sort(), [a.nodeId,b.nodeId].sort());
  assert.ok(initial.body.nodes.every((n: any) => n.reachable && !n.available && n.reason));
  const start = { projectId:a.projects[0].id, engine:"pi", conversationId, appNodeId:a.nodeId };
  assert.match((await request(0,"POST","/browser/sessions",start)).body.error,/Settings|configur/i);
  assert.equal((await request(0,"PUT","/browser/config",{executorNodeId:b.nodeId})).status,200);
  assert.equal((await request(1,"GET","/browser/config")).body.config.executorNodeId,b.nodeId);
  const preference = `/browser/preferences?${query()}`;
  assert.deepEqual((await request(1,"GET",preference)).body,{nodeId:null,effectiveNodeId:b.nodeId});
  assert.equal((await request(0,"PUT",preference,{nodeId:a.nodeId})).status,200);
  assert.deepEqual((await request(1,"GET",preference)).body,{nodeId:a.nodeId,effectiveNodeId:a.nodeId});
  assert.match((await request(0,"POST","/browser/sessions",start)).body.error,new RegExp(`browser-${a.key}`));
  assert.match((await request(0,"POST",`/browser/sessions?nodeId=${b.nodeId}`,start)).body.error,new RegExp(`browser-${b.key}`));
  assert.equal((await request(1,"PUT",preference,{nodeId:null})).status,200);
  assert.deepEqual((await request(0,"GET",preference)).body,{nodeId:null,effectiveNodeId:b.nodeId});
  assert.equal((await request(0,"GET",`/browser/preferences?${new URLSearchParams({projectId:randomUUID(),engine:"pi",conversationId})}`)).status,404);
  assert.equal((await request(0,"PUT",preference,{nodeId:randomUUID()})).status,503);
});

test("durable attachments aggregate physical owners and stay pinned after defaults change", async () => {
  const [a,b] = env.nodes;
  const first=await seedSession(0), second=await seedSession(1);
  const result=await request(0,"GET",`/browser/sessions?${query()}`);
  assert.equal(result.status,200);
  assert.deepEqual(result.body.unavailableNodes,[]);
  assert.deepEqual(result.body.sessions.map((s:any)=>s.nodeId).sort(),[a.nodeId,b.nodeId].sort());
  assert.ok(result.body.sessions.every((s:any)=>s.appNodeId===a.nodeId && s.state==="closed"));
  await request(0,"PUT","/browser/config",{executorNodeId:a.nodeId});
  const fetched=await request(0,"GET",`/browser/sessions/${second.id}?nodeId=${b.nodeId}`);
  assert.equal(fetched.body.session.nodeId,b.nodeId);
  assert.equal(fetched.body.session.appNodeId,a.nodeId);
  const reopen=await request(0,"POST",`/browser/sessions?nodeId=${a.nodeId}`,{projectId:a.projects[0].id,engine:"pi",conversationId,appNodeId:a.nodeId,profileId:second.profileId});
  assert.equal(reopen.status,409,"Conflicting explicit machine must reject, not silently retarget");
  assert.match(reopen.body.error,new RegExp(b.nodeId));
  const pinned=await request(0,"POST","/browser/sessions",{projectId:a.projects[0].id,engine:"pi",conversationId,appNodeId:a.nodeId,profileId:second.profileId});
  assert.match(pinned.body.error,new RegExp(`browser-${b.key}`),"Inherited default must not retarget an existing profile");
  assert.equal((await request(0,"GET",`/browser/sessions/${first.id}?nodeId=${randomUUID()}`)).status,503);
});

test("implicit profile start resolves its machine before reusing attached accounts", async () => {
  const [a,b]=env.nodes;
  const body={projectId:a.projects[0].id,engine:"pi",conversationId,appNodeId:a.nodeId};
  await request(0,"PUT",`/browser/preferences?${query()}`,{nodeId:a.nodeId});
  for(const node of [a,b]) {
    const started=await request(0,"POST",`/browser/sessions?nodeId=${node.nodeId}`,body);
    assert.match(started.body.error,new RegExp(`browser-${node.key}`),"Other machines' attachments must not cause ambiguity or change selected target");
  }
  assert.match((await request(0,"POST","/browser/sessions",body)).body.error,new RegExp(`browser-${a.key}`));
});

test("legacy exact session-ID lookup resolves its owner without selecting another account", async () => {
  const [a,b]=env.nodes;
  const remote=await seedSession(1);
  const found=await request(0,"GET",`/browser/sessions/${remote.id}`);
  assert.equal(found.status,200);
  assert.equal(found.body.session.id,remote.id);
  assert.equal(found.body.session.nodeId,b.nodeId);
  assert.equal((await request(0,"GET",`/browser/sessions/${randomUUID()}`)).status,404);
  const db=new DatabaseSync(path.join(b.dataDir,"node.db"));
  db.prepare("UPDATE browser_sessions SET state='interrupted',restoreOnRestart=1 WHERE id=?").run(remote.id);
  try {
    const closed=await request(0,"POST",`/browser/sessions/${remote.id}/command`,{action:"close"});
    assert.equal(closed.status,200);
    assert.equal(closed.body.session.nodeId,b.nodeId);
    assert.equal(db.prepare("SELECT restoreOnRestart FROM browser_sessions WHERE id=?").get(remote.id)?.restoreOnRestart,0);
    assert.equal((await request(0,"GET",`/browser/sessions/${remote.id}?nodeId=${a.nodeId}`)).status,404,"Explicit wrong owner never redirects");
  } finally {db.close();}
});

test("agent discovery follows conversation across nodes and relay keeps paused recovery authority", async () => {
  const [a,b]=env.nodes;
  const discovery=await agent(0,{operation:"status",conversationId:"forged"});
  assert.equal(discovery.status,200);
  assert.deepEqual([...new Set(discovery.body.sessions.map((s:any)=>s.nodeId))].sort(),[a.nodeId,b.nodeId].sort());
  assert.equal(discovery.body.nodes.length,2);
  const profiles=await agent(0,{operation:"profiles"});
  assert.deepEqual([...new Set(profiles.body.profiles.map((p:any)=>p.nodeId))].sort(),[a.nodeId,b.nodeId].sort());
  const remote=discovery.body.sessions.find((s:any)=>s.nodeId===b.nodeId);
  const db=new DatabaseSync(path.join(b.dataDir,"node.db"));
  db.prepare("UPDATE browser_sessions SET state='interrupted',restoreOnRestart=1,recovery=? WHERE id=?").run(JSON.stringify({origins:["http://127.0.0.1:1234"],activeIndex:0,human:"synthetic-human"}),remote.id);
  try {
    const paused=await agent(0,{operation:"command",profileId:remote.profileId,command:{action:"close"}});
    assert.equal(paused.status,409);
    assert.match(paused.body.error,/human|paused/i);
    assert.equal(db.prepare("SELECT restoreOnRestart FROM browser_sessions WHERE id=?").get(remote.id)?.restoreOnRestart,1);
    const token=(await request(0,"GET","/cluster/invite")).body.token;
    const relay=async(body:unknown)=>fetch(`${b.url}/api/cluster/browser/operation`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(body)});
    const identity={projectId:a.projects[0].id,engine:"pi",conversationId};
    assert.equal((await relay({operation:"command",args:{id:remote.id,command:{action:"takeControl"}},actor:{kind:"agent"},identity})).status,409);
    assert.equal((await relay({operation:"get",args:{id:remote.id},actor:{kind:"agent"},identity:{...identity,conversationId:"forged"}})).status,403);
    assert.equal((await relay({operation:"get",args:{id:remote.id},actor:{kind:"agent"}})).status,400);
    db.prepare("UPDATE browser_sessions SET recovery=? WHERE id=?").run(JSON.stringify({origins:[],activeIndex:0,human:null}),remote.id);
    assert.equal((await agent(0,{operation:"command",profileId:remote.profileId,command:{action:"close"}})).status,200,"Unpaused cancellation must reach the physical owner as agent");
    assert.equal(db.prepare("SELECT restoreOnRestart FROM browser_sessions WHERE id=?").get(remote.id)?.restoreOnRestart,0);
    const unattached=await childCode(1,`import { BrowserStore } from './src/browser-store.ts';const s=new BrowserStore();console.log(JSON.stringify(s.createProfile(${JSON.stringify(b.projects[0].id)},'Other conversation')));s.close();`);
    assert.equal((await agent(0,{operation:"start",profileId:unattached.id,nodeId:b.nodeId})).status,403);
    assert.ok(!(await agent(0,{operation:"profiles"})).body.profiles.some((p:any)=>p.id===unattached.id));
  } finally {db.close();}
});

test("agent downloads use the selected remote account after the default changes", async () => {
  const [a,b]=env.nodes;
  const discovery=await agent(0,{operation:"status"});
  const remote=discovery.body.sessions.find((s:any)=>s.nodeId===b.nodeId);
  const downloadId=randomUUID();
  await childCode(1,`import { BrowserStore } from './src/browser-store.ts';import { mkdirSync,writeFileSync } from 'node:fs';import path from 'node:path';const s=new BrowserStore();s.saveDownload(${JSON.stringify(remote.id)},{id:${JSON.stringify(downloadId)},name:'fixture.txt',ready:true});const folder=path.join(process.env.JOINT_BOB_DATA_DIR,'browser',${JSON.stringify(remote.id)},'downloads');mkdirSync(folder,{recursive:true});writeFileSync(path.join(folder,${JSON.stringify(downloadId)}),'remote fixture bytes');s.close();console.log('null');`);
  const db=new DatabaseSync(path.join(b.dataDir,"node.db"));
  db.prepare("UPDATE browser_sessions SET state='running',restoreOnRestart=0 WHERE id=?").run(remote.id);
  try {
    await request(0,"PUT","/browser/config",{executorNodeId:a.nodeId});
    const download=await agent(0,{operation:"download",profileId:remote.profileId,downloadId});
    assert.equal(download.status,200);
    assert.equal(download.body,"remote fixture bytes");
    const legacy=await fetch(`${a.url}/api/browser/sessions/${remote.id}/downloads/${downloadId}`,{headers:{Cookie:logins[0].cookie}});
    assert.equal(legacy.status,200);assert.equal(await legacy.text(),"remote fixture bytes");
    const switched=await agent(0,{operation:"download",profileId:remote.profileId,downloadId},"claude");
    assert.equal(switched.status,200);assert.equal(switched.body,"remote fixture bytes");
    assert.equal((await agent(0,{operation:"download",profileId:randomUUID(),downloadId})).status,404);
  } finally {db.prepare("UPDATE browser_sessions SET state='closed' WHERE id=?").run(remote.id);db.close();}
});

test("logical conversation preference and remote recovery commands survive engine changes", async () => {
  const [a,b]=env.nodes;
  await request(0,"PUT",`/browser/preferences?${query()}`,{nodeId:b.nodeId});
  const switchedQuery=query();switchedQuery.set("engine","claude");
  assert.deepEqual((await request(1,"GET",`/browser/preferences?${switchedQuery}`)).body,{nodeId:b.nodeId,effectiveNodeId:b.nodeId});
  await request(1,"PUT",`/browser/preferences?${switchedQuery}`,{nodeId:a.nodeId});
  assert.deepEqual((await request(0,"GET",`/browser/preferences?${query()}`)).body,{nodeId:a.nodeId,effectiveNodeId:a.nodeId});
  const listed=await agent(0,{operation:"status"},"claude");
  const remote=listed.body.sessions.find((s:any)=>s.nodeId===b.nodeId);
  const db=new DatabaseSync(path.join(b.dataDir,"node.db"));
  db.prepare("UPDATE browser_sessions SET state='interrupted',restoreOnRestart=1,recovery=? WHERE id=?").run(JSON.stringify({origins:[],activeIndex:0,human:null}),remote.id);
  try {assert.equal((await agent(0,{operation:"command",profileId:remote.profileId,command:{action:"close"}},"claude")).status,200);}
  finally {db.close();}
});

test("preference replication and browser relay enforce project sharing", async () => {
  const [a,b]=env.nodes;
  const db=new DatabaseSync(path.join(b.dataDir,"node.db"));
  db.prepare("INSERT INTO cluster_project_grants VALUES (?,?,?,?)").run(a.nodeId,"[]",new Date().toISOString(),b.nodeId);
  try {
    const token=(await request(0,"GET","/cluster/invite")).body.token;
    for(const [route,body] of [
      ["preferences",{identity:{projectId:a.projects[0].id,engine:"pi",conversationId},preference:null}],
      ["operation",{operation:"profiles",args:{projectId:a.projects[0].id},actor:{kind:"human",id:"fixture"}}],
    ] as const) {
      const response=await fetch(`${b.url}/api/cluster/browser/${route}`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(body)});
      assert.equal(response.status,403,route);
    }
  } finally {db.prepare("DELETE FROM cluster_project_grants WHERE node_id=?").run(a.nodeId);db.close();}
});

test("a peer missing the browser endpoint is unavailable, not an empty account inventory", async () => {
  const [a,b]=env.nodes;
  const fixture=createServer((_request,response)=>{response.writeHead(404,{"Content-Type":"application/json"});response.end(JSON.stringify({error:"Endpoint not found"}));});
  fixture.listen(0,"127.0.0.1");await once(fixture,"listening");
  const address=fixture.address();assert.ok(address && typeof address!=="string");
  const db=new DatabaseSync(path.join(a.dataDir,"node.db"));
  db.prepare("UPDATE cluster_peers SET url=? WHERE id=?").run(`http://127.0.0.1:${address.port}`,b.nodeId);
  try {
    const discovery=await request(0,"GET",`/browser/sessions?${query()}`);
    assert.deepEqual(discovery.body.unavailableNodes.map((n:any)=>n.nodeId),[b.nodeId]);
    assert.equal((await agent(0,{operation:"command",command:{action:"close"}})).status,503);
  } finally {db.prepare("UPDATE cluster_peers SET url=? WHERE id=?").run(b.url,b.nodeId);db.close();fixture.closeAllConnections();await new Promise<void>(resolve=>fixture.close(()=>resolve()));}
});

test("human explicit owner profile attachment works while an unrelated peer is offline", async () => {
  const [a,b]=env.nodes;
  const profile=await childCode(0,`import { BrowserStore } from './src/browser-store.ts';const s=new BrowserStore();console.log(JSON.stringify(s.createProfile(${JSON.stringify(a.projects[0].id)},'Selected owner-local account')));s.close();`);
  await stopDevNode(servers[1]);
  try {
    const attach=await request(0,"POST",`/browser/sessions?nodeId=${a.nodeId}`,{projectId:a.projects[0].id,engine:"pi",conversationId:randomUUID(),appNodeId:a.nodeId,profileId:profile.id});
    assert.equal(attach.status,409);assert.match(attach.body.error,new RegExp(`browser-${a.key}`));
  } finally {servers[1]=await startDevNode(env,b,{JOINT_BOB_BROWSER_EXECUTABLE:`/missing/browser-${b.key}`});}
});

test("offline discovery is explicit, rejects guesses, and preferences converge after restart", async () => {
  const [a,b]=env.nodes;
  const before=await agent(0,{operation:"status"});
  const local=before.body.sessions.find((s:any)=>s.nodeId===a.nodeId);
  const db=new DatabaseSync(path.join(a.dataDir,"node.db"));
  db.prepare("UPDATE browser_sessions SET state='interrupted',restoreOnRestart=1 WHERE id=?").run(local.id);
  await stopDevNode(servers[1]);
  try {
    const partial=await request(0,"GET",`/browser/sessions?${query()}`);
    assert.deepEqual(partial.body.unavailableNodes.map((n:any)=>n.nodeId),[b.nodeId]);
    assert.equal((await agent(0,{operation:"command",command:{action:"close"}})).status,503);
    const named=await agent(0,{operation:"start",profileName:"Explicit new account",nodeId:a.nodeId});
    assert.equal(named.status,409);
    assert.match(named.body.error,new RegExp(`browser-${a.key}`),"Explicit creation reaches selected node despite unrelated offline peer");
    assert.equal((await agent(0,{operation:"command",profileId:local.profileId,command:{action:"close"}})).status,200);
    const profile=await childCode(0,`import { BrowserStore } from './src/browser-store.ts';const s=new BrowserStore();console.log(JSON.stringify(s.createProfile(${JSON.stringify(a.projects[0].id)},'Unattached synthetic profile')));s.close();`);
    const attach=await request(0,"POST",`/browser/sessions?nodeId=${a.nodeId}`,{projectId:a.projects[0].id,engine:"pi",conversationId,appNodeId:a.nodeId,profileId:profile.id});
    assert.equal(attach.status,409);assert.match(attach.body.error,new RegExp(`browser-${a.key}`),"Human can attach a known owner-local profile despite unrelated offline peer");
    const unknown=await request(0,"GET",`/browser/sessions/${randomUUID()}`);assert.equal(unknown.status,503,"Missing exact ID plus offline peer must not select another account");
    assert.equal((await request(0,"PUT",`/browser/preferences?${query()}`,{nodeId:b.nodeId})).status,200);
  } finally {db.close();servers[1]=await startDevNode(env,b,{JOINT_BOB_BROWSER_EXECUTABLE:`/missing/browser-${b.key}`});}
  assert.deepEqual((await request(1,"GET",`/browser/preferences?${query()}`)).body,{nodeId:b.nodeId,effectiveNodeId:b.nodeId});
});
