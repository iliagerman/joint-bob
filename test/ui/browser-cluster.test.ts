import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { Browser } from "playwright-core";
import { chromeExecutable, launchChrome } from "./launch-chrome.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";
import type { BrowserSessionView } from "../../src/browser-types.js";

// Real servers, real cluster calls, real Chrome, real viewer. No browser API stubs.
test("conversation browser runs independently of its agent node and stays pinned when defaults change", { timeout: 180000 }, async (t) => {
  const executablePath=await chromeExecutable();
  const root=await mkdtemp(path.join(os.tmpdir(),"joint-bob-browser-cluster-"));
  const servers:ChildProcess[]=[];let viewerBrowser:Browser|undefined;
  let uploaded=Buffer.alloc(0),workedAfterClose=false;
  const fixture=http.createServer(async (request,response)=>{
    if(request.url==='/upload') { const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(chunk);uploaded=Buffer.concat(chunks);response.end('uploaded');return; }
    if(request.url==='/worked') {workedAfterClose=true;response.end('recorded');return;}
    if(request.url==='/download') {response.setHeader('Content-Disposition','attachment; filename="browser-result.txt"');response.end('downloaded on browser node');return;}
    if(request.url==='/login') {response.end('<title>Popup login</title><button onclick="document.cookie=\'login=remembered; path=/; Max-Age=86400\';opener.postMessage(\'done\',location.origin);window.close()">Sign in</button>');return;}
    if(request.url==='/handoff') {response.setHeader('Content-Type','text/html');response.end('<title>Login handoff</title><form id="handoff-login"><input id="handoff-password" type="password"><button id="handoff-submit">Sign in</button></form><div id="signed-in" hidden>Signed in</div><script>document.querySelector("#handoff-login").addEventListener("submit",event=>{event.preventDefault();if(document.querySelector("#handoff-password").value==="synthetic-only"){event.currentTarget.remove();document.querySelector("#signed-in").hidden=false}})</script>');return;}
    response.setHeader('Content-Type','text/html');response.end('<title>Application on source node</title><h1>Remote app</h1><button id="login" onclick="open(\'/login\',\'login\',\'width=520,height=440\')">Popup login</button><input id="upload" type="file" onchange="fetch(\'/upload\',{method:\'POST\',body:this.files[0]})"><a id="download" href="/download" download>Download</a>');
  });
  fixture.listen(0,'127.0.0.1');await once(fixture,'listening');
  const fixtureOrigin=`http://localhost:${(fixture.address() as AddressInfo).port}`;
  try {
    const environment=await seedDevEnvironment(root,2);const [a,b]=environment.nodes;
    servers.push(await startDevNode(environment,a,{JOINT_BOB_BROWSER_EXECUTABLE:'/browser-disabled-on-source'}));
    servers.push(await startDevNode(environment,b,{JOINT_BOB_BROWSER_EXECUTABLE:executablePath}));
    const auth=await signIn(environment,a);t.diagnostic('Paired nodes started');
    const configured = await api(a, auth, 'PUT', '/browser/config', { executorNodeId: b.nodeId });
    assert.equal(configured.status, 200, JSON.stringify(configured.body));
    const conversationId=randomUUID(),projectId=a.projects[0].id;
    const issued=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',`import {browserAgentEnvironment} from './src/browser-agent.ts';console.log(JSON.stringify(browserAgentEnvironment(${JSON.stringify(projectId)},'pi',${JSON.stringify(conversationId)})))`],{cwd:process.cwd(),env:{...process.env,HOME:environment.home,JOINT_BOB_DATA_DIR:a.dataDir,PORT:String(a.port)},timeout:15000});
    const agentEnv=JSON.parse(issued.stdout) as Record<string,string>;
    async function agent(body:unknown) {
      return fetch(agentEnv.JOINT_BOB_BROWSER_URL,{method:'POST',headers:{Authorization:`Bearer ${agentEnv.JOINT_BOB_BROWSER_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
    }
    async function command(command:unknown) {
      const response=await agent({operation:'command',command});
      const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;
    }
    const started=await agent({operation:'start',url:fixtureOrigin});
    const startBody=await started.json() as {session:BrowserSessionView};assert.equal(started.status,200,JSON.stringify(startBody));
    const session=startBody.session;t.diagnostic('Agent on source node started browser on the other machine');
    assert.equal(session.appNodeId,a.nodeId);
    assert.equal(session.nodeId,b.nodeId);
    const alias=`alias-${projectId}`;
    await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',`import {registerProjectAliases} from './src/store.ts';await registerProjectAliases(${JSON.stringify(projectId)},[${JSON.stringify(alias)}]);`],{cwd:process.cwd(),env:{...process.env,HOME:environment.home,JOINT_BOB_DATA_DIR:b.dataDir},timeout:15000});
    const aliased=await api<{sessions:BrowserSessionView[]}>(a,auth,'GET',`/browser/sessions?${new URLSearchParams({projectId:alias,engine:'pi',conversationId,nodeId:b.nodeId})}`);
    assert.equal(aliased.body.sessions[0]?.id,session.id,'Project aliases must resolve to the same browser session');
    const db=new DatabaseSync(path.join(b.dataDir,'node.db'));try{assert.ok(db.prepare('SELECT id FROM browser_sessions WHERE id=?').get(session.id));}finally{db.close();}
    const snapshot=await command({action:'snapshot'});assert.match(JSON.stringify(snapshot.result),/Remote app/);
    const beforeTarget=session.tabs[0].id;
    viewerBrowser=await launchChrome({headless:true});
    const context=await viewerBrowser.newContext({viewport:{width:1450,height:1000},serviceWorkers:'block'});
    context.setDefaultTimeout(15000);
    await context.addCookies(auth.cookie.split('; ').map(value=>({name:value.slice(0,value.indexOf('=')),value:value.slice(value.indexOf('=')+1),url:a.url})));
    const viewerURL=`${a.url}/browser.html?${new URLSearchParams({browserSessionId:session.id,projectId,engine:'pi',conversationId,appNodeId:a.nodeId,nodeId:b.nodeId})}`;
    let viewer=await context.newPage();await viewer.goto(viewerURL);await viewer.getByTestId('browser-screen').waitFor({timeout:20000});
    const cleared = await api(a, auth, 'PUT', '/browser/config', { executorNodeId: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    await viewer.getByTestId('browser-reconnect').click();
    await viewer.getByTestId('browser-machines-toggle').click();
    await viewer.getByTestId('browser-machine-status').filter({hasText:'Not configured'}).waitFor();
    assert.match(await viewer.getByTestId('browser-session-status').innerText(), new RegExp(b.name));
    await viewer.getByTestId('browser-take-control').click();await viewer.getByTestId('browser-control-status').filter({hasText:'Human control'}).waitFor();
    const blocked=await agent({operation:'command',command:{action:'evaluate',expression:'1+1'}});assert.equal(blocked.status,409);
    await viewer.getByTestId('browser-resume-agent').click();await viewer.getByTestId('browser-control-status').filter({hasText:'Agent control'}).waitFor();

    await command({action:'navigate',url:`${fixtureOrigin}/handoff`});
    await viewer.getByTestId('browser-login-done').waitFor();
    const authoritative=await api<{session:BrowserSessionView}>(a,auth,'GET',`/browser/sessions/${session.id}?nodeId=${b.nodeId}`);
    assert.equal(authoritative.status,200,JSON.stringify(authoritative.body));
    assert.equal(authoritative.body.session.loginRequest?.automatic,true,'Native login handoff must be automatic');
    assert.equal(authoritative.body.session.loginRequest?.expectedOrigin,fixtureOrigin,'Native login handoff must persist on browser owner');
    const loginRequestId=authoritative.body.session.loginRequest!.id;
    const handoffPageId=authoritative.body.session.activePageId!;
    const paused=await agent({operation:'command',command:{action:'evaluate',expression:'window.__agentRan=true'}});
    assert.equal(paused.status,409);assert.match(await paused.text(),/login required/i);
    await viewer.getByTestId('browser-control-status').filter({hasText:'Human control'}).waitFor();
    await viewer.getByTestId('browser-login-done').waitFor();assert.equal(await viewer.getByTestId('browser-login-done').isDisabled(),false,'Visible sign-in handoff automatically claims human control');
    const takeover=await api<BrowserSessionView>(a,auth,'POST',`/browser/sessions/${session.id}/command?nodeId=${b.nodeId}`,{action:'takeControl',loginRequestId});
    assert.equal(takeover.status,200,JSON.stringify(takeover.body));await viewer.getByTestId('browser-control-status').filter({hasText:'Human control'}).waitFor();
    await viewer.getByTestId('browser-login-done').click();await viewer.getByTestId('browser-error').filter({hasText:/could not be verified/i}).waitFor();
    const premature=await api<{session:BrowserSessionView}>(a,auth,'GET',`/browser/sessions/${session.id}?nodeId=${b.nodeId}`);
    assert.equal(premature.body.session.loginRequest?.id,loginRequestId);assert.equal(premature.body.session.owner,'human');assert.equal(await viewer.getByTestId('browser-resume-agent').isVisible(),false);
    const fill=await api(a,auth,'POST',`/browser/sessions/${session.id}/command?nodeId=${b.nodeId}`,{action:'fill',selector:'#handoff-password',text:'synthetic-only',expectedPageId:handoffPageId});assert.equal(fill.status,200,JSON.stringify(fill.body));
    const submit=await api(a,auth,'POST',`/browser/sessions/${session.id}/command?nodeId=${b.nodeId}`,{action:'clickElement',selector:'#handoff-submit',expectedPageId:handoffPageId});assert.equal(submit.status,200,JSON.stringify(submit.body));
    await viewer.getByTestId('browser-login-done').click();await viewer.getByTestId('browser-login-notice').waitFor({state:'hidden'});await viewer.getByTestId('browser-control-status').filter({hasText:'Agent control'}).waitFor();
    const completed=await api<{session:BrowserSessionView}>(a,auth,'GET',`/browser/sessions/${session.id}?nodeId=${b.nodeId}`);assert.equal(completed.body.session.loginRequest,null);
    const verified=await command({action:'evaluate',expression:"Boolean(document.querySelector('#signed-in') && !document.querySelector('#signed-in').hidden)"});assert.equal(verified.result,true);
    const replay=await api<BrowserSessionView>(a,auth,'POST',`/browser/sessions/${session.id}/command?nodeId=${b.nodeId}`,{action:'takeControl',loginRequestId});assert.equal(replay.status,409);
    const afterReplay=await api<{session:BrowserSessionView}>(a,auth,'GET',`/browser/sessions/${session.id}?nodeId=${b.nodeId}`);assert.equal(afterReplay.body.session.owner,'agent');
    await command({action:'navigate',url:fixtureOrigin});
    await command({action:'clickElement',selector:'#login'});
    await viewer.getByTestId('browser-select-tab').filter({hasText:'Popup login'}).waitFor();
    await command({action:'clickElement',selector:'text=Sign in'});
    await command({action:'clickElement',selector:'#upload'});
    await viewer.getByTestId('browser-upload').waitFor();await viewer.getByTestId('browser-take-control').click();
    await viewer.getByTestId('browser-control-status').filter({hasText:'Human control'}).waitFor();
    const upload=Buffer.from('User upload across two nodes');
    await viewer.getByTestId('browser-upload').setInputFiles({name:'proof.txt',mimeType:'text/plain',buffer:upload});
    await viewer.waitForFunction(()=>document.querySelector('[data-testid="browser-upload-status"]')?.textContent?.includes('Uploaded'));t.diagnostic('Popup and upload completed through viewer');
    for(let attempt=0;attempt<100 && !uploaded.length;attempt++)await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(createHash('sha256').update(uploaded).digest('hex'),createHash('sha256').update(upload).digest('hex'));
    await viewer.getByTestId('browser-resume-agent').click();await viewer.getByTestId('browser-control-status').filter({hasText:'Agent control'}).waitFor();
    await viewer.close();
    await command({action:'evaluate',expression:"fetch('/worked').then(r=>r.text())"});assert.ok(workedAfterClose);t.diagnostic('Agent work completed after viewer closed');
    viewer=await context.newPage();await viewer.goto(viewerURL);await viewer.getByTestId('browser-screen').waitFor({timeout:20000});
    const status=await (await agent({operation:'status'})).json() as {sessions:BrowserSessionView[]};
    assert.equal(status.sessions.filter(row=>row.state==='running').length,1);assert.equal(status.sessions[0].id,session.id);assert.equal(status.sessions[0].tabs[0].id,beforeTarget);
    await command({action:'clickElement',selector:'#download'});
    let downloadId:string|undefined;
    for(let attempt=0;attempt<100;attempt++){const state=await(await agent({operation:'status'})).json() as {sessions:BrowserSessionView[]};downloadId=state.sessions[0].downloads.find(item=>item.ready)?.id;if(downloadId)break;await new Promise(resolve=>setTimeout(resolve,25));}
    assert.ok(downloadId);const downloaded=await agent({operation:'download',downloadId});assert.equal(await downloaded.text(),'downloaded on browser node');
    const saved=await command({action:'saveProfile',label:'Integration login'});assert.ok(saved.result.id);
    await viewer.close();await command({action:'close'});
    const restored=await(await agent({operation:'start',nodeId:b.nodeId,url:fixtureOrigin,profileId:saved.result.id})).json();assert.notEqual(restored.session.id,session.id);
    assert.match((await command({action:'evaluate',expression:'document.cookie'})).result,/login=remembered/);
    await command({action:'close'});
  } finally {
    await viewerBrowser?.close();
    let forced = false;
    await Promise.all(servers.map(async child=>{
      if(child.exitCode!==null||child.signalCode!==null)return;
      const timer=setTimeout(()=>{ forced = true; child.kill('SIGKILL'); },10000);
      try {await stopDevNode(child);} finally {clearTimeout(timer);}
    }));
    fixture.closeAllConnections();fixture.close();await rm(root,{recursive:true,force:true});
    assert.equal(forced, false, 'Browser nodes must exit on SIGTERM without requiring SIGKILL');
  }
});

// Scope-grant and cross-node enforcement at the live-browser level: a restricted
// profile stops already-queued remote commands, and a revoked grant redacts live
// page metadata from the agent's own listing while the owner node keeps seeing it.
test("cross-node restriction stops queued remote commands and revoked grants redact agent status", { timeout: 240000 }, async (t) => {
  const executablePath = await chromeExecutable();
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-browser-grants-"));
  const servers: ChildProcess[] = [];
  let viewerBrowser: Browser | undefined;
  let releaseSlow: (() => void) | undefined;
  const fixture = http.createServer((request, response) => {
    if (request.url === "/slow") {
      response.setHeader("Content-Type", "text/html");
      setTimeout(() => response.end("<title>Slow page</title>"), releaseSlow ? 4000 : 0);
      return;
    }
    response.setHeader("Content-Type", "text/html");
    response.end("<title>Grants fixture</title><h1>Loopback fixture</h1>");
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const fixtureOrigin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
  try {
    const environment = await seedDevEnvironment(root, 2);
    const [a, b] = environment.nodes;
    servers.push(await startDevNode(environment, a, { JOINT_BOB_BROWSER_EXECUTABLE: "/browser-disabled-on-source" }));
    servers.push(await startDevNode(environment, b, { JOINT_BOB_BROWSER_EXECUTABLE: executablePath }));
    const authA = await signIn(environment, a);
    const authB = await signIn(environment, b);
    await api(a, authA, "PUT", "/browser/config", { executorNodeId: b.nodeId });
    const conversationId = randomUUID(), projectId = a.projects[0].id;
    const issued = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `import {browserAgentEnvironment} from './src/browser-agent.ts';const environment=browserAgentEnvironment(${JSON.stringify(projectId)},'pi',${JSON.stringify(conversationId)});console.log(JSON.stringify({url:environment.JOINT_BOB_BROWSER_URL,token:environment.JOINT_BOB_BROWSER_TOKEN}))`], { cwd: process.cwd(), env: { ...process.env, HOME: environment.home, JOINT_BOB_DATA_DIR: a.dataDir, PORT: String(a.port) }, timeout: 15000 });
    const agentEnv = JSON.parse(issued.stdout) as { url: string; token: string };
    const agent = async (body: unknown) => fetch(agentEnv.url, { method: "POST", headers: { Authorization: `Bearer ${agentEnv.token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
    // Both queued commands travel the agent relay, so they pass the relay's own
    // cross-node admission before the toggle and only the queue recheck can stop them.
    const remoteCommand = (command: unknown) => agent({ operation: "command", profileId: session.profileId, command });

    // A relayed start creates the profile cross-node-enabled, granted to this conversation.
    releaseSlow = undefined;
    const started = await (await agent({ operation: "start", url: fixtureOrigin })).json() as { session: BrowserSessionView };
    const session = started.session;
    assert.equal(session.nodeId, b.nodeId);
    assert.equal(session.state, "running");
    const projectsOnB = await api<{ projects: Array<{ id: string; name: string }> }>(b, authB, "GET", "/projects");
    const projectOnB = projectsOnB.body.projects.find(candidate => candidate.name === a.projects[0].name)!;

    // Hold one remote command in flight, enqueue a second behind it, then restrict
    // the profile: the queued command must be refused before touching the page.
    releaseSlow = () => {};
    const first = remoteCommand({ action: "navigate", url: `${fixtureOrigin}/slow` });
    await new Promise(resolve => setTimeout(resolve, 800));
    const second = remoteCommand({ action: "evaluate", expression: "window.__queued = true" });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal((await api<{ profile: { crossNodeAccess: boolean } }>(b, authB, "PUT", `/browser/profiles/${session.profileId}/access?${new URLSearchParams({ projectId: projectOnB.id, conversationId })}`, { crossNodeAccess: false })).status, 200);
    assert.equal((await first).status, 200, "the admitted command finishes");
    const refused = await second;
    const refusal = await refused.json() as { error: string };
    assert.equal(refused.status, 403, JSON.stringify(refusal));
    assert.match(refusal.error, /restricted to this node/i, "a command queued before the toggle must be refused when its turn comes");
    assert.equal((await api(b, authB, "PUT", `/browser/profiles/${session.profileId}/access?${new URLSearchParams({ projectId: projectOnB.id, conversationId })}`, { crossNodeAccess: true })).status, 200, "the owner node re-enables cross-node access");

    // A revoked conversation grant redacts live metadata from the agent's own status…
    await api(b, authB, "PUT", `/browser/profiles/${session.profileId}/access?${new URLSearchParams({ projectId: projectOnB.id, conversationId })}`, { revoke: { scope: "conversation", projectId: projectOnB.id, conversationId } });
    const ownerView = await api<{ session: BrowserSessionView }>(b, authB, "GET", `/browser/sessions/${session.id}?nodeId=${b.nodeId}`);
    assert.ok(ownerView.body.session.tabs.length >= 1, "the owner node still sees live tabs");
    const status = await (await agent({ operation: "status" })).json() as { sessions: BrowserSessionView[] };
    const revokedRow = status.sessions.find(row => row.id === session.id)!;
    assert.equal(revokedRow.accessRevoked, true);
    assert.deepEqual(revokedRow.tabs, [], "revoked agent listings must not leak live tab URLs and titles");
    assert.equal(revokedRow.loginRequest, null);
    // …while the same agent's commands are refused except closing its own session.
    const blocked = await agent({ operation: "command", profileId: session.profileId, command: { action: "evaluate", expression: "1+1" } });
    assert.equal(blocked.status, 403);
    assert.match(await blocked.text(), /revoked/i);
    const closed = await agent({ operation: "command", profileId: session.profileId, command: { action: "close" } });
    assert.equal(closed.status, 200, "closing stays available to the revoked conversation");
    t.diagnostic("Verified queued-remote-command refusal on restriction and revoked-grant status redaction");
  } finally {
    await viewerBrowser?.close();
    let forced = false;
    await Promise.all(servers.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const timer = setTimeout(() => { forced = true; child.kill("SIGKILL"); }, 10000);
      try { await stopDevNode(child); } finally { clearTimeout(timer); }
    }));
    fixture.closeAllConnections();
    await new Promise<void>(resolve => fixture.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
    assert.equal(forced, false, "Browser nodes must exit on SIGTERM without requiring SIGKILL");
  }
});
