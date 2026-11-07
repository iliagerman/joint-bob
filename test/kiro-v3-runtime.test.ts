import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getSettings, updateSettings } from "../src/settings.js";
import { addProject } from "../src/store.js";
import runtime from "../src/harnesses/kiro/runtime.js";
import { initializeKiroSession, readKiroSession } from "../src/harnesses/kiro/storage.js";

const fixture = `#!/usr/bin/env node
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2);
if(args.includes('--version')||args.includes('whoami'))process.exit(0);
assert.deepEqual(args,['acp','--agent-engine=v3']);
const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const notify=update=>send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'native-v3',update}});
const config=mode=>[{id:'mode',type:'select',currentValue:mode,options:[{value:mode,name:mode}]},{id:'model',type:'select',currentValue:'model-v3',options:[{value:'model-v3',name:'V3 model'}]},{id:'effortLevel',type:'select',currentValue:'medium',options:[{value:'medium',name:'Medium'}]},{id:'autopilot',type:'select',currentValue:'off',options:[{value:'off',name:'Off'}]}];
let mode,promptId;
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const r=JSON.parse(line),reply=result=>send({jsonrpc:'2.0',id:r.id,result});
if(r.id==='permission') {assert.equal(r.result.outcome.outcome,'cancelled');notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'V3 complete'}});send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}});return;}
if(r.method==='initialize')return reply({protocolVersion:1,agentCapabilities:{loadSession:true,_meta:{kiro:{extensionMethods:['_kiro/session/compact']}}}});
if(r.method==='session/new'||r.method==='session/load'){
assert.ok(r.params._meta.kiro.modeId.startsWith('joint-bob-'));assert.equal(r.params._meta.kiro.effortLevel,'medium');assert.ok(Array.isArray(r.params.mcpServers));
mode=r.params._meta.kiro.modeId;const profile=JSON.parse(fs.readFileSync(path.join(process.env.KIRO_HOME,'agents',mode+'.json')));assert.equal(profile.allowedTools,undefined);assert.equal(profile.includePowers,false);
if(r.method==='session/load')notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Do not duplicate replay'},_meta:{kiro:{replay:true}}});
return reply({...(r.method==='session/new'?{sessionId:'native-v3'}:{}),modes:{currentModeId:mode,availableModes:[{id:mode,name:mode}]},configOptions:config(mode)});
}
if(r.method==='session/set_config_option'){assert.equal(r.params.configId,'autopilot');assert.equal(r.params.value,'off');return reply({configOptions:config(mode)});}
if(r.method==='session/prompt'){
promptId=r.id;notify({sessionUpdate:'session_info_update',_meta:{kiro:{kind:'context_usage',usagePercentage:37}}});
notify({sessionUpdate:'session_info_update',_meta:{kiro:{kind:'turn_end'}}});notify({sessionUpdate:'future_update',extra:'ignored'});
notify({sessionUpdate:'agent_message_chunk',content:{type:'text',text:'replayed'},_meta:{kiro:{replay:true}}});
send({jsonrpc:'2.0',id:'permission',method:'session/request_permission',params:{sessionId:'other-session',toolCall:{toolCallId:'wrong',title:'Read',kind:'read'},options:[{optionId:'allow',kind:'allow_once',name:'Allow'}]}});return;
}
if(r.method==='_kiro/session/compact'){assert.deepEqual(r.params,{sessionId:'native-v3'});return reply({});}
throw Error('Unexpected V3 method '+r.method);
}).on('close',()=>process.exit(0));
`;

test("V3 launch, native profile selection, replay, metadata, permissions, resume and compaction", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kiro-v3-runtime-")), previous = getSettings();
  let session: Awaited<ReturnType<typeof runtime.open>> | undefined;
  try {
    const executable = path.join(root, "kiro"), configPath = path.join(root, "config");
    await mkdir(path.join(configPath, "sessions"), { recursive: true });
    await writeFile(executable, fixture); await chmod(executable, 0o700);
    updateSettings({ runtimes: { ...previous.runtimes, kiro: { ...previous.runtimes.kiro, executable, configPath, sessionPath: path.join(configPath, "sessions") } } });
    const project = await addProject("V3 fixture", root, { writeInstructions: false });
    session = await runtime.open({ projectId: project.id, cwd: root, sessionId: "v3-runtime" });
    await session.configure({ provider: "kiro", modelId: "model-v3", reasoning: "medium", enabledTools: ["read"] });
    const texts: string[] = []; session.subscribe(event => { if (event.type === "textDelta") texts.push(event.text); });
    await session.prompt({ text: "hello" });
    assert.deepEqual(texts, ["V3 complete"]);
    assert.deepEqual(session.status().contextUsage, { percent: 37 });
    assert.deepEqual(session.status().model, { provider: "kiro", id: "model-v3", label: "V3 model" });
    assert.equal((await readKiroSession(session.file!.replace(/^kiro:/, ""))).nativeEngine, "v3");
    const file = session.file!; session.dispose();
    session = await runtime.open({ projectId: project.id, cwd: root, sessionId: "v3-runtime", sessionPath: file });
    await session.prompt({ text: "again" });
    assert.equal(session.messages.filter(message => message.role === "assistant").length, 2);
    await session.compact();
    assert.equal(session.isBusy(), false);
  } finally { if (session?.isBusy()) await session.stopForUpdate(); session?.dispose(); updateSettings({ runtimes: previous.runtimes }); await rm(root, { recursive: true, force: true }); }
});

test("existing V2 alias keeps its explicit V2 launch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kiro-v2-resume-")), previous = getSettings();
  let session: Awaited<ReturnType<typeof runtime.open>> | undefined;
  try {
    const executable = path.join(root, "kiro");
    await writeFile(executable, `#!/usr/bin/env node\nrequire('node:assert/strict').ok(process.argv.includes('v2'));process.stderr.write('legacy-fixture');process.exit(1);`); await chmod(executable, 0o700);
    updateSettings({ runtimes: { ...previous.runtimes, kiro: { ...previous.runtimes.kiro, executable, configPath: root, sessionPath: path.join(root, "sessions") } } });
    const project = await addProject("V2 fixture", root, { writeInstructions: false });
    const options = { projectId: project.id, cwd: root, sessionId: "legacy" };
    const file = await initializeKiroSession(options, { provider: "kiro", modelId: "default", reasoning: "medium" }, "v2");
    session = await runtime.open({ ...options, sessionPath: `kiro:${file}` });
    await assert.rejects(session.prompt({ text: "hello" }), /legacy-fixture/);
    assert.equal((await readKiroSession(file)).nativeEngine, "v2");
  } finally { if (session?.isBusy()) await session.stopForUpdate(); session?.dispose(); updateSettings({ runtimes: previous.runtimes }); await rm(root, { recursive: true, force: true }); }
});
