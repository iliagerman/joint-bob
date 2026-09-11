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
import { chromium, type Browser } from "playwright-core";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "../dev-nodes.js";
import type { BrowserSessionView } from "../../src/browser-types.js";

// Real servers, real cluster calls, real Chrome, real viewer. No browser API stubs.
test("conversation browser runs on selected peer and survives closing its real viewer", { timeout: 180000 }, async (t) => {
  const executablePath=process.env.CHROME_PATH || process.env.JOINT_BOB_BROWSER_EXECUTABLE || chromium.executablePath();
  const root=await mkdtemp(path.join(os.tmpdir(),"joint-bob-browser-cluster-"));
  const servers:ChildProcess[]=[];let viewerBrowser:Browser|undefined;
  let uploaded=Buffer.alloc(0),workedAfterClose=false;
  const fixture=http.createServer(async (request,response)=>{
    if(request.url==='/upload') { const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(chunk);uploaded=Buffer.concat(chunks);response.end('uploaded');return; }
    if(request.url==='/worked') {workedAfterClose=true;response.end('recorded');return;}
    if(request.url==='/download') {response.setHeader('Content-Disposition','attachment; filename="browser-result.txt"');response.end('downloaded on browser node');return;}
    if(request.url==='/login') {response.end('<title>Popup login</title><button onclick="document.cookie=\'login=remembered; path=/\';opener.postMessage(\'done\',location.origin);window.close()">Sign in</button>');return;}
    response.setHeader('Content-Type','text/html');response.end('<title>Application on source node</title><h1>Remote app</h1><button id="login" onclick="open(\'/login\',\'login\',\'width=520,height=440\')">Popup login</button><input id="upload" type="file" onchange="fetch(\'/upload\',{method:\'POST\',body:this.files[0]})"><a id="download" href="/download" download>Download</a>');
  });
  fixture.listen(0,'127.0.0.1');await once(fixture,'listening');
  try {
    const environment=await seedDevEnvironment(root,2);const [a,b]=environment.nodes;
    servers.push(await startDevNode(environment,a,{JOINT_BOB_BROWSER_EXECUTABLE:'/browser-disabled-on-source'}));
    servers.push(await startDevNode(environment,b,{JOINT_BOB_BROWSER_EXECUTABLE:executablePath}));
    const auth=await signIn(environment,a);t.diagnostic('Paired nodes started');
    const selected=await api(a,auth,'PUT','/browser/config',{executorNodeId:b.nodeId});assert.equal(selected.status,200,JSON.stringify(selected.body));
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
    const started=await agent({operation:'start',url:`http://localhost:${(fixture.address() as AddressInfo).port}`});
    const startBody=await started.json() as {session:BrowserSessionView};assert.equal(started.status,200,JSON.stringify(startBody));
    const session=startBody.session;t.diagnostic('Browser started on selected peer');
    assert.equal(session.appNodeId,a.nodeId);
    const alias=`alias-${projectId}`;
    await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','-e',`import {registerProjectAliases} from './src/store.ts';await registerProjectAliases(${JSON.stringify(projectId)},[${JSON.stringify(alias)}]);`],{cwd:process.cwd(),env:{...process.env,HOME:environment.home,JOINT_BOB_DATA_DIR:b.dataDir},timeout:15000});
    const aliased=await api<{sessions:BrowserSessionView[]}>(a,auth,'GET',`/browser/sessions?${new URLSearchParams({projectId:alias,engine:'pi',conversationId})}`);
    assert.equal(aliased.body.sessions[0]?.id,session.id,'Project aliases must resolve to the same browser session');
    const db=new DatabaseSync(path.join(b.dataDir,'node.db'));try{assert.ok(db.prepare('SELECT id FROM browser_sessions WHERE id=?').get(session.id));}finally{db.close();}
    const snapshot=await command({action:'snapshot'});assert.match(JSON.stringify(snapshot.result),/Remote app/);
    const beforeTarget=session.tabs[0].id;
    viewerBrowser=await chromium.launch({executablePath,headless:true});
    const context=await viewerBrowser.newContext({viewport:{width:1450,height:1000},serviceWorkers:'block'});
    context.setDefaultTimeout(15000);
    await context.addCookies(auth.cookie.split('; ').map(value=>({name:value.slice(0,value.indexOf('=')),value:value.slice(value.indexOf('=')+1),url:a.url})));
    const viewerURL=`${a.url}/browser.html?${new URLSearchParams({browserSessionId:session.id,projectId,engine:'pi',conversationId,appNodeId:a.nodeId})}`;
    let viewer=await context.newPage();await viewer.goto(viewerURL);await viewer.getByTestId('browser-screen').waitFor({timeout:20000});
    await viewer.getByTestId('browser-take-control').click();await viewer.getByTestId('browser-control-status').filter({hasText:'Human control'}).waitFor();
    const blocked=await agent({operation:'command',command:{action:'evaluate',expression:'1+1'}});assert.equal(blocked.status,409);
    await viewer.getByTestId('browser-resume-agent').click();await viewer.getByTestId('browser-control-status').filter({hasText:'Agent control'}).waitFor();
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
    const restored=await(await agent({operation:'start',url:`http://localhost:${(fixture.address() as AddressInfo).port}`,profileId:saved.result.id})).json();assert.notEqual(restored.session.id,session.id);
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
