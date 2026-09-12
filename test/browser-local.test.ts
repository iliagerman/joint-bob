import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { addProject } from "../src/store.js";
import { BrowserStore } from "../src/browser-store.js";
import { browserOperation, browserRuntime, browserStatus, closeBrowserRuntime, configureBrowserExecutor, localBrowserOperation } from "../src/server/browser.js";
import type { BrowserSessionView, BrowserStart } from "../src/browser-types.js";

test("browser status reports local machine alongside inherited configuration", async () => {
  try {
    const status = await browserStatus();
    assert.equal(status.config.executorNodeId, null);
    assert.equal((status as unknown as { node: { id: string } }).node.id, (await getClusterNode()).id);
  } finally { await closeBrowserRuntime(); }
});

test("an agent requires configuration but explicit starts and default changes ignore active-session fences", async (t) => {
  const folder = path.join(os.homedir(), "browser-local-start");
  await mkdir(folder, { recursive: true });
  const project = await addProject("Local browser", folder, { writeInstructions: false });
  const node = await getClusterNode();
  const runtime = browserRuntime(), store = new BrowserStore();
  let actual: BrowserStart | undefined;
  t.mock.method(runtime, "create", async (input: BrowserStart) => {
    actual = input;
    return runtime.get(store.create(input).id);
  });
  const args: BrowserStart = { projectId: project.id, engine: "pi", conversationId: randomUUID(), appNodeId: node.id };
  try {
    await assert.rejects(browserOperation({operation:"start",args},{kind:"agent"}),/Settings/);
    const result = await browserOperation({ operation: "start", args }, { kind: "agent" },node.id) as { session: BrowserSessionView };
    assert.equal(result.session.nodeId,node.id);
    await configureBrowserExecutor(node.id);
    await configureBrowserExecutor(null);
    assert.equal((await runtime.get(result.session.id)).state,"running","Changing default must not close or move an active browser");
    assert.equal(result.session.appNodeId, node.id);
    assert.deepEqual(actual, args);
    await assert.rejects(localBrowserOperation({ operation: "start", args: { ...args, appNodeId: randomUUID() } }, { kind: "agent" }), /no longer paired/i);
  } finally { t.mock.restoreAll(); store.close(); await closeBrowserRuntime(); }
});

test("reopening an attached profile does not require its former app node to remain paired", async t => {
  const folder=path.join(os.homedir(),randomUUID());await mkdir(folder,{recursive:true});
  const project=await addProject("Moved conversation",folder,{writeInstructions:false});
  const node=await getClusterNode(),runtime=browserRuntime();await runtime.ready();
  const store=new BrowserStore();
  const identity={projectId:project.id,engine:"pi" as const,conversationId:randomUUID()};
  const profile=store.createProfile(project.id,"Synthetic account");
  const previous=store.create({...identity,appNodeId:randomUUID(),profileId:profile.id});
  t.mock.method(runtime,"create",async(input:BrowserStart)=>{
    assert.equal(input.appNodeId,node.id,"A new start carries the current app node, not stale provenance");
    return runtime.get(previous.id);
  });
  try {
    const result=await browserOperation({operation:"start",args:{...identity,appNodeId:node.id,profileId:profile.id}},{kind:"agent"},node.id) as {session:BrowserSessionView};
    assert.equal(result.session.id,previous.id);
    assert.equal(result.session.appNodeId,previous.appNodeId,"Existing session retains historical provenance");
    assert.equal(result.session.nodeId,node.id);
  } finally {t.mock.restoreAll();store.finish(previous.id,"closed");store.close();await closeBrowserRuntime();}
});
