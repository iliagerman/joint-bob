import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { createProviderProfile, setProviderProfileSelection } from "../src/provider-profiles/store.js";
import { prepareKiroProfile } from "../src/kiro-profiles/native.js";
import { runAsAccount } from "../src/account-context.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { addProject } from "../src/store.js";
import { setResourceOwner } from "../src/ownership.js";
import { listDiscoveredHarnesses } from "../src/harnesses/registry.js";
import { readKiroSession } from "../src/harnesses/kiro/storage.js";

import { kiroV3SessionFixture } from "./kiro-v3-fixture.js";

const fixture = `#!/usr/bin/env node
${kiroV3SessionFixture}
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
if(process.argv.includes('--version'))process.exit(0);
if(process.argv.includes('whoami'))process.exit(fs.existsSync(path.join(process.env.HOME,'fixture-login'))?0:1);
if(process.env.KIRO_API_KEY)process.exit(3);
const native='native-'+path.basename(path.dirname(process.env.HOME));
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);fs.appendFileSync(path.join(process.cwd(),'kiro-events.jsonl'),JSON.stringify({method:request.method,home:process.env.HOME,kiroHome:process.env.KIRO_HOME,params:request.params})+'\\n');
 const result=value=>send({jsonrpc:'2.0',id:request.id,result:value});
 if(request.method==='initialize')return result({protocolVersion:1,agentCapabilities:{loadSession:true}});
 if(request.method==='session/new')return result(v3Session(request,native));
 if(request.method==='session/load')return request.params.sessionId===native?result(v3Session(request,native)):send({jsonrpc:'2.0',id:request.id,error:{code:-1,message:'Wrong account native session'}});
 if(request.method==='session/prompt'){
  send({jsonrpc:'2.0',method:'session/update',params:{sessionId:native,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Fixture account answer'}}}});
  return result({stopReason:'end_turn'});
 }
});
`;

test("Kiro turns use only their selected native account and retain history when profiles change", async () => {
  await getClusterNode();
  const root=await mkdtemp(path.join(os.tmpdir(),'kiro-profile-turn-'));
  const previous=getSettings().runtimes.kiro;
  const executable=path.join(root,'kiro-fixture');
  const actor={accountId:'kiro-turn-owner',username:'fixture',role:'member' as const,isRemoteLogin:false,homeNodeId:null};
  await writeFile(executable,fixture);await chmod(executable,0o700);
  updateSettings({runtimes:{...getSettings().runtimes,kiro:{...previous,executable}}});
  try {
    const project=await addProject('Kiro account turns',root,{writeInstructions:false});
    setResourceOwner('project',project.id,actor.accountId);
    const one=createProviderProfile(actor.accountId,{provider:'kiro',label:'One',kiro:{startUrl:'https://one.awsapps.com/start',region:'us-east-1'}});
    const two=createProviderProfile(actor.accountId,{provider:'kiro',label:'Two',kiro:{startUrl:'https://two.awsapps.com/start',region:'us-east-1'}});
    const homes=await Promise.all([prepareKiroProfile(one),prepareKiroProfile(two)]);
    for(const home of homes)await writeFile(path.join(home.HOME,'fixture-login'),'fixture-native-login');
    const choose=(id:string)=>setProviderProfileSelection(actor.accountId,{provider:'kiro',scope:'default',scopeId:'',profileId:id});
    const runtime=await listDiscoveredHarnesses().find(item=>item.id==='kiro')!.runtime!();
    choose(one.id);
    await runAsAccount(actor,async()=>{
      const session=await runtime.open({projectId:project.id,cwd:root,sessionId:'profile-turn',conversationId:'profile-turn'});
      try {
        await session.preflight();await session.prompt({text:'First account question'});
        choose(two.id);
        await session.preflight();await session.prompt({text:'Second account question'});
        const stored=await readKiroSession(session.file!.replace(/^kiro:/,''));
        assert.equal(stored.nativeProfileId,two.id);
        assert.deepEqual(stored.messages.filter(item=>item.role==='user').map(item=>item.text),['First account question','Second account question']);
        const events=(await readFile(path.join(root,'kiro-events.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
        const prompts=events.filter(item=>item.method==='session/prompt');
        assert.equal(prompts[0].home,homes[0].HOME);assert.equal(prompts[1].home,homes[1].HOME);
        assert.match(JSON.stringify(prompts[1].params),/First account question/);
        assert.equal(events.some(item=>item.method==='session/load'&&item.home===homes[1].HOME),false);
      } finally {session.dispose();}
    });
    await rm(path.join(homes[1].HOME,'fixture-login'));
    await runAsAccount(actor,async()=>{
      const session=await runtime.open({projectId:project.id,cwd:root,sessionId:'unavailable'});
      try {await assert.rejects(session.preflight(),/Sign in to Kiro profile Two/);}finally{session.dispose();}
    });
  } finally {
    updateSettings({runtimes:{...getSettings().runtimes,kiro:previous}});
    await rm(root,{recursive:true,force:true});
  }
});
