import assert from "node:assert/strict";
import { execFile, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("revoking a profile grant blocks remembered local downloads without blocking the human", { timeout: 120000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "browser-download-grants-"));
  let server: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    const auth = await signIn(environment, node);
    await api(node, auth, "GET", "/browser/status");
    const projectId = node.projects[0].id;
    const conversationId = randomUUID();
    const fixture = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { BrowserStore } from './src/browser-store.ts';
      import { browserAgentEnvironment } from './src/browser-agent.ts';
      import { mkdirSync, writeFileSync } from 'node:fs';
      import path from 'node:path';
      import { randomUUID } from 'node:crypto';
      const store = new BrowserStore();
      const profile = store.createProfile(${JSON.stringify(projectId)}, 'Synthetic download account');
      store.grantProfileAccess(profile.id, {scope:'conversation',projectId:${JSON.stringify(projectId)},conversationId:${JSON.stringify(conversationId)}});
      const session = store.create({projectId:${JSON.stringify(projectId)},conversationId:${JSON.stringify(conversationId)},engine:'pi',appNodeId:${JSON.stringify(node.nodeId)},profileId:profile.id});
      const downloadId = randomUUID();
      store.saveDownload(session.id, {id:downloadId,name:'fixture.txt',ready:true});
      const directory = path.join(${JSON.stringify(node.dataDir)}, 'browser', session.id, 'downloads');
      mkdirSync(directory, {recursive:true});
      writeFileSync(path.join(directory, downloadId), 'synthetic account download');
      store.close();
      const agent = browserAgentEnvironment(${JSON.stringify(projectId)}, 'pi', ${JSON.stringify(conversationId)});
      console.log(JSON.stringify({profileId:profile.id,sessionId:session.id,downloadId,url:agent.JOINT_BOB_BROWSER_URL,token:agent.JOINT_BOB_BROWSER_TOKEN}));
    `], { env: { ...process.env, HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir, PORT: String(node.port) }, timeout: 15000 });
    const saved = JSON.parse(fixture.stdout) as { profileId: string; sessionId: string; downloadId: string; url: string; token: string };
    const download = () => fetch(saved.url, { method: "POST", headers: { Authorization: `Bearer ${saved.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ operation: "download", profileId: saved.profileId, downloadId: saved.downloadId }) });
    const allowed = await download();
    assert.equal(allowed.status, 200);
    assert.equal(await allowed.text(), "synthetic account download");
    const revoked = await api(node, auth, "PUT", `/browser/profiles/${saved.profileId}/access?${new URLSearchParams({ projectId, conversationId })}`, { revoke: { scope: "conversation", projectId, conversationId } });
    assert.equal(revoked.status, 200);
    const refused = await download();
    assert.equal(refused.status, 403, "a remembered download ID must not bypass revoked profile access");
    assert.match(await refused.text(), /revoked/);
    const human = await fetch(`${node.url}/api/browser/sessions/${saved.sessionId}/downloads/${saved.downloadId}?nodeId=${node.nodeId}`, { headers: { Cookie: auth.cookie } });
    assert.equal(human.status, 200);
    assert.equal(await human.text(), "synthetic account download");
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
