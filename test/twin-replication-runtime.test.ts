import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { signedNodeRequest } from "./signed-node-request.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

async function eventually(check: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 50_000;
  while (true) {
    try { await check(); return; }
    catch (error) { if (Date.now() >= deadline) throw error; }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

test("twins replicate project events over signed transport without bearer peers", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "twin-runtime-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const a = await seedDevEnvironment(path.join(root, "a"), 1);
    const b = await seedDevEnvironment(path.join(root, "b"), 1);
    const left = a.nodes[0], right = b.nodes[0];
    children.push(await startDevNode(a, left), await startDevNode(b, right));
    const sa = await signIn(a, left), sb = await signIn(b, right);
    const invitation = await api<{ link: string }>(left, sa, "POST", "/twins/invitations", { confirmOwnedData: true });
    assert.equal(invitation.status, 201);
    assert.equal((await api(right, sb, "POST", "/twins/accept", { link: invitation.body.link, confirmOwnedData: true })).status, 201);
    const secret = await api<{ account: { id: string } }>(left, sa, "POST", "/secrets/accounts", {
      label: "Twin runtime secret", provider: "custom", replicate: true,
      variables: [{ name: "TWIN_TEST_SECRET", kind: "value", value: "disposable-synthetic-secret" }],
    });
    assert.equal(secret.status, 201, JSON.stringify(secret.body));
    await eventually(async () => {
      const accounts = await api<{ accounts: Array<{ id: string }> }>(right, sb, "GET", "/secrets");
      assert.ok(accounts.body.accounts.some(account => account.id === secret.body.account.id), "eligible credentials must use signed twin transport");
    });
    await eventually(async()=>{
      const inventory=await api<{remote:Array<{peerId:string;reachable:boolean}>}>(left,sa,'GET','/cluster/inventory');
      const peer=inventory.body.remote.find(peer=>peer.peerId===right.nodeId);
      assert.ok(peer,'signed twin must appear in the node inventory');
      assert.equal(peer.reachable,true,'the twin answers signed inventory requests without a bearer token');
      const db=new DatabaseSync(path.join(left.dataDir,'node.db'));
      try{
        const activity=db.prepare('SELECT last_seen_at FROM cluster_v2_peer_activity WHERE node_id=?').get(right.nodeId) as {last_seen_at:string|null}|undefined;
        assert.ok(activity?.last_seen_at&&Date.parse(activity.last_seen_at)>Date.now()-90000,'successful signed traffic records the twin as recently seen');
      }finally{db.close();}
    });
    const directory = path.join(root, "project");
    await mkdir(directory);
    const project = await api<{ project: { id: string } }>(left, sa, "POST", "/projects", { name: "Runtime", type: "personal", path: directory, synced: false });
    assert.equal(project.status, 201);
    const id = project.body.project.id;
    await eventually(async () => {
      const projects = await api<{ projects: Array<{ id: string }> }>(right, sb, "GET", "/projects");
      assert.ok(projects.body.projects.some((project) => project.id === id), "twin project metadata must arrive");
    });
    execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',`
      import {ensureConversationRecord} from './src/conversation-records.ts';
      await ensureConversationRecord(${JSON.stringify(id)},'pi','signed-runtime-session',${JSON.stringify(left.nodeId)});
    `],{env:{...process.env,HOME:a.home,JOINT_BOB_DATA_DIR:left.dataDir}});
    await eventually(async()=>{
      const result=await signedNodeRequest(a,left,right,'POST','/api/cluster/v2/runtime/sessions/ownership/apply',{originNodeId:left.nodeId,record:{engine:'pi',sessionId:'signed-runtime-session',ownerNodeId:left.nodeId,epoch:1,status:'owned',transferToNodeId:null}});
      assert.equal(result.status,200,'signed runtime must acknowledge authorized conversation ownership');
      assert.equal((await result.json() as {accepted:boolean}).accepted,true);
    });
    const cronInput = { projectId: id, name: "Twin schedule", prompt: "Continue", ownerNodeId: right.nodeId, engine: "pi", sessionId: null, enabled: true, schedule: { frequency: "daily", minute: 0, hour: 9, weekday: 1, timezone: "UTC" } };
    const cron = (command: unknown) => api<{ task: { id: string; enabled: boolean }; runs: unknown[] }>(left, sa, "POST", "/cron", { nodeId: right.nodeId, command });
    const created = await cron({ action: "create", input: cronInput });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const cronId = created.body.task.id;
    const paused = await cron({ action: "update", id: cronId, input: { ...cronInput, enabled: false } });
    assert.equal(paused.status, 200, JSON.stringify(paused.body));
    assert.equal(paused.body.task.enabled, false);
    const history = await cron({ action: "history", id: cronId });
    assert.equal(history.status, 200, JSON.stringify(history.body));
    assert.equal((await cron({ action: "delete", id: cronId })).status, 200, "a twin must be able to stop a task it owns remotely");
    const unknown = await signedNodeRequest(a, left, right, "POST", "/api/cluster/v2/runtime/cron", { action: "delete", id: cronId });
    assert.equal(unknown.status, 403, "a task ID with no stored project cannot authorize itself");
    const renamed = await api(left, sa, "PATCH", `/projects/${id}`, { name: "Signed project" });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    const db = new DatabaseSync(path.join(right.dataDir, "node.db"));
    try {
      await eventually(async () => {
        const row = db.prepare("SELECT name FROM name_overrides WHERE scope='projects' AND key=?").get(id) as { name: string } | undefined;
        assert.equal(row?.name, "Signed project", "project event must replicate without legacy peers");
      });
    } finally { db.close(); }
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
