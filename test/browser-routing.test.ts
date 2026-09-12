import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getClusterNode } from "../src/cluster.js";
import { addProject, registerProjectAliases } from "../src/store.js";
import { BrowserStore } from "../src/browser-store.js";
import { browserRuntime, closeBrowserRuntime, localBrowserOperation } from "../src/server/browser.js";
import type { BrowserSessionView, BrowserProfile } from "../src/browser-types.js";

test("local browser resolves project aliases before listing sessions or saved login profiles", async () => {
  const folder=path.join(os.homedir(),"browser-alias-project");await mkdir(folder,{recursive:true});
  const project=await addProject("Browser alias",folder,{writeInstructions:false});
  const alias=`alias-${randomUUID()}`;await registerProjectAliases(project.id,[alias]);
  const node=await getClusterNode();
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

test("legacy central-runner history stays on the node holding its browser data", async () => {
  const folder = path.join(os.homedir(), "browser-legacy-owner");
  await mkdir(folder, { recursive: true });
  const project = await addProject("Legacy browser", folder, { writeInstructions: false });
  const local = await getClusterNode();
  browserRuntime(); const store = new BrowserStore();
  try {
    const record = store.create({ projectId: project.id, engine: "pi", conversationId: randomUUID(), appNodeId: randomUUID() });
    store.finish(record.id, "interrupted");
    const fetched = await localBrowserOperation({ operation: "get", args: { id: record.id } }, { kind: "agent" }) as { session: BrowserSessionView };
    const listed = await localBrowserOperation({ operation: "list", args: { projectId: project.id } }, { kind: "agent" }) as { sessions: BrowserSessionView[] };
    assert.equal(fetched.session.nodeId, local.id, "viewers must follow the physical owner, not the old app node");
    assert.equal(listed.sessions[0].nodeId, local.id);
    assert.equal(fetched.session.appNodeId, record.appNodeId);
    assert.equal(store.get(record.id).appNodeId, record.appNodeId, "historical provenance stays intact in storage");
  } finally { store.close(); await closeBrowserRuntime(); }
});
