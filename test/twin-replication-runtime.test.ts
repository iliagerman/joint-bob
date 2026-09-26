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
  const deadline = Date.now() + 25_000;
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
      const peers=await api<{peers:Array<{id:string;online:boolean;tokenConfigured:boolean;lastSeenAt:string}>}>(left,sa,'GET','/cluster/peers');
      const peer=peers.body.peers.find(peer=>peer.id===right.nodeId);
      assert.ok(peer,'signed twin must appear in the public node inventory');
      assert.equal(peer.tokenConfigured,true,'signed authentication is configured without a bearer token');
      assert.equal(peer.online,true,'successful signed traffic marks the twin online');
      assert.ok(Date.parse(peer.lastSeenAt)>Date.now()-90000);
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
