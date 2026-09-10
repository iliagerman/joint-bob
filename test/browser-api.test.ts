import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import test, { before, after } from "node:test";
import WebSocket, { createWebSocketStream } from "ws";
import { api, seedDevEnvironment, startDevNode, stopDevNode, signIn, type DevEnvironment, type SignedIn } from "./dev-nodes.js";

let root: string, environment: DevEnvironment, logins: SignedIn[];
const servers: ChildProcess[] = [];
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-browser-api-"));
  environment = await seedDevEnvironment(root, 2);
  for (const node of environment.nodes) servers.push(await startDevNode(environment, node, { JOINT_BOB_BROWSER_EXECUTABLE: "/nonexistent/browser-for-api-test" }));
  logins = await Promise.all(environment.nodes.map(node => signIn(environment, node)));
}, { timeout: 120000 });
after(async () => { await Promise.all(servers.map(stopDevNode)); if (root) await rm(root, { recursive: true, force: true }); });

test("browser status discovers both nodes and refuses an unavailable executor without fallback", async () => {
  const [a,b] = environment.nodes;
  const status = await api<{config:{executorNodeId:string|null};nodes:Array<{id:string;available:boolean;reason:string}>}>(a,logins[0],"GET","/browser/status");
  assert.equal(status.status,200);
  assert.equal(status.body.config.executorNodeId,null);
  assert.deepEqual(status.body.nodes.map(n=>n.id).sort(),[a.nodeId,b.nodeId].sort());
  assert.ok(status.body.nodes.every(n=>!n.available && n.reason));
  const selected = await api(a,logins[0],"PUT","/browser/config",{executorNodeId:b.nodeId});
  assert.equal(selected.status,409);
  const start = await api(a,logins[0],"POST","/browser/sessions",{projectId:a.projects[0].id,engine:"pi",conversationId:"fixture-conversation",appNodeId:a.nodeId});
  assert.equal(start.status,409);
});

test("browser configuration requires login and CSRF; cluster endpoints reject browser users", async () => {
  const [a] = environment.nodes;
  assert.equal((await fetch(a.url+"/api/browser/status")).status,401);
  assert.equal((await fetch(a.url+"/api/browser/config",{method:"PUT",headers:{Cookie:logins[0].cookie,"Content-Type":"application/json"},body:JSON.stringify({executorNodeId:null})})).status,403);
  assert.equal((await api(a,logins[0],"GET","/cluster/browser/status")).status,403);
  assert.equal((await fetch(a.url+"/api/browser/agent",{method:"POST",headers:{Authorization:"Bearer invalid","Content-Type":"application/json"},body:'{"operation":"status"}'})).status,401);
});

test("browser tunnel carries HTTP over an authenticated websocket between paired nodes", { timeout: 20000 }, async () => {
  const [a,b] = environment.nodes;
  const token = (await api<{token:string}>(a,logins[0],"GET","/cluster/invite")).body.token;
  const app = http.createServer((_request,response)=>response.end("app on target node"));
  app.listen(0,"127.0.0.1"); await once(app,"listening");
  const port=(app.address() as AddressInfo).port;
  const url = new URL("/ws",b.url); url.protocol="ws:";
  url.search = new URLSearchParams({mode:"browserTunnel",projectId:a.projects[0].id,host:"localhost",port:String(port)}).toString();
  const socket = new WebSocket(url,{headers:{Authorization:`Bearer ${token}`}});
  try {
    const message = await new Promise<WebSocket.RawData>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error("Tunnel ready timeout")),10000);
      socket.once("message",data=>{clearTimeout(timer);resolve(data)});
      socket.once("close",(code,reason)=>{clearTimeout(timer);reject(Error(`Tunnel closed ${code}: ${reason.toString()}`))});
      socket.once("error",error=>{clearTimeout(timer);reject(error)});
    });
    assert.equal(JSON.parse(message.toString()).ready,true);
    const stream = createWebSocketStream(socket);
    let response="";
    const completed = new Promise<void>((resolve,reject)=>{stream.on("data",chunk=>{response+=chunk;if(response.includes("app on target node"))resolve()});stream.on("error",reject);stream.on("close",()=>{if(!response.includes("app on target node"))reject(Error(`Tunnel closed before response: ${response}`));});});
    stream.write(`GET / HTTP/1.1\r\nHost: localhost:${port}\r\nConnection: close\r\n\r\n`);
    await completed;
    assert.match(response,/HTTP\/1.1 200/);
    assert.match(response,/app on target node/);
  } finally { socket.terminate(); app.closeAllConnections(); await new Promise<void>(resolve=>app.close(()=>resolve())); }
});

test("browser users cannot turn the websocket endpoint into a raw network tunnel", { timeout: 15000 }, async () => {
  const a=environment.nodes[0];
  const url=new URL('/ws',a.url);url.protocol='ws:';url.search=new URLSearchParams({mode:'browserTunnel',projectId:a.projects[0].id,host:'localhost',port:'22'}).toString();
  const socket=new WebSocket(url,{headers:{Cookie:logins[0].cookie,Origin:a.url}});
  const [code]=await once(socket,'close');assert.equal(code,1008);
});
