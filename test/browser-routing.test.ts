import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { addProject, registerProjectAliases } from "../src/store.js";
import { BrowserStore } from "../src/browser-store.js";
import { browserRuntime, closeBrowserRuntime, localBrowserOperation, configureBrowserExecutor } from "../src/server/browser.js";
import { applyBrowserConfiguration } from "../src/browser-configuration.js";
import type { BrowserSessionView, BrowserProfile, BrowserStart } from "../src/browser-types.js";

test("executor cannot change while browser startup is still in flight", async (t) => {
  const folder=path.join(os.homedir(),"browser-start-race");await mkdir(folder,{recursive:true});
  const project=await addProject("Browser start race",folder,{writeInstructions:false});
  const node=await getClusterNode();applyBrowserConfiguration({executorNodeId:node.id,originNodeId:node.id,updatedAt:new Date().toISOString()});
  const runtime=browserRuntime(),store=new BrowserStore();
  let started!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{started=resolve});
  const gate=new Promise<void>(resolve=>{release=resolve});
  t.mock.method(runtime,"create",async (input:BrowserStart)=>{started();await gate;return runtime.get(store.create(input).id);});
  const pending=localBrowserOperation({operation:"start",args:{projectId:project.id,engine:"pi",conversationId:randomUUID(),appNodeId:node.id}},{kind:"agent"});
  try {
    await entered;
    await assert.rejects(configureBrowserExecutor(null),/running browser|starting browser/i);
  } finally {
    release();await pending.catch(()=>{});t.mock.restoreAll();store.close();await closeBrowserRuntime();
  }
});

test("executor resolves project aliases before listing sessions or saved login profiles", async () => {
  const folder=path.join(os.homedir(),"browser-alias-project");await mkdir(folder,{recursive:true});
  const project=await addProject("Browser alias",folder,{writeInstructions:false});
  const alias=`alias-${randomUUID()}`;await registerProjectAliases(project.id,[alias]);
  const node=await getClusterNode();applyBrowserConfiguration({executorNodeId:node.id,originNodeId:node.id,updatedAt:new Date().toISOString()});
  browserRuntime();const store=new BrowserStore();
  try {
    const session=store.create({projectId:project.id,engine:"pi",conversationId:randomUUID(),appNodeId:node.id});
    const profile=store.saveProfile(project.id,"Login",{cookies:[],origins:[]});
    const listed=await localBrowserOperation({operation:"list",args:{projectId:alias,engine:"pi",conversationId:session.conversationId}},{kind:"agent"}) as {sessions:BrowserSessionView[]};
    assert.equal(listed.sessions[0]?.id,session.id,"same project alias must not hide an existing browser");
    const profiles=await localBrowserOperation({operation:"profiles",args:{projectId:alias}},{kind:"agent"}) as {profiles:BrowserProfile[]};
    assert.equal(profiles.profiles[0]?.id,profile.id);
  } finally {store.close();await closeBrowserRuntime();}
});
