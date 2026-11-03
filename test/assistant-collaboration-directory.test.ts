import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { askableHelpers, localAssistantSummaries } from "../src/assistant-collaboration/directory.js";
import { setAskSwitch } from "../src/assistant-collaboration/store.js";
import { BrowserStore } from "../src/browser-store.js";
import { getClusterNode } from "../src/cluster.js";
import { addSharingMember, createSharingCluster, getSharingCluster, registerOwnedResource, setResourceShares } from "../src/cluster-sharing-policy.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { personalAssistantDatabase, savePersonalAssistant } from "../src/personal-assistants.js";
import { conversationScopeId, saveSecretAccount, setScopeSecretAccounts } from "../src/secrets.js";
import { createAction, setActionStatus } from "../src/social/actions.js";
import { addProject } from "../src/store.js";
import { api, pairTwinNodes, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

async function privateProject(name: string): Promise<string> {
  const folder = path.join(os.homedir(), `directory-${name}-${randomUUID()}`);
  await mkdir(folder, { recursive: true });
  const project = await addProject(name, folder, { writeInstructions: false });
  registerOwnedResource(await clusterV2Database(), { kind: "project", id: project.id, ownerNodeId: (await getClusterNode()).id }, (await getClusterNode()).id);
  return project.id;
}

test("a summary names what is attached and what is published", async () => {
  const projectId = await privateProject("summary");
  const assistant = await savePersonalAssistant("summary-owner", { projectId, engine: "pi", sessionId: "summary-session", name: "Work", mcpServerNames: ["kms-jira"], instructions: "x".repeat(400) });
  const secret = await saveSecretAccount({ label: "Work Google", provider: "custom", variables: [{ name: "WORK_GOOGLE", kind: "value", value: "fake-value" }] });
  await setScopeSecretAccounts("conversation", conversationScopeId("pi", "summary-session"), [secret.id]);
  const profile = new BrowserStore().createProfile(projectId, "LinkedIn");
  (await personalAssistantDatabase()).prepare("INSERT INTO personal_assistant_logins (assistant_id, profile_id, created_at) VALUES (?,?,?)").run(assistant.id, profile.id, new Date().toISOString());
  const action = await createAction(assistant.id, { name: "Read free and busy times", description: "", inputs: "", instructions: "Only on weekdays", operations: ["calendar.freebusy"], shareText: "" });
  await setActionStatus(assistant.id, action.id, "published");
  await createAction(assistant.id, { name: "Unpublished draft", description: "", inputs: "", instructions: "", operations: ["calendar.freebusy"], shareText: "" });

  const [summary] = await localAssistantSummaries("summary-owner");
  assert.deepEqual(summary.has, ["Work Google", "LinkedIn", "kms-jira", "Read free and busy times"]);
  assert.equal(summary.private, true);
  assert.equal(summary.about, "x".repeat(300));
  assert.equal(summary.nodeId, (await getClusterNode()).id);
  assert.deepEqual(summary.actions.map(item => [item.name, item.status, item.revision]), [["Read free and busy times", "published", 2]]);
  assert.doesNotMatch(JSON.stringify(summary), /fake-value/);

  // An assistant stored as running on another machine is summarized as running there.
  const elsewhere = randomUUID();
  await savePersonalAssistant("summary-elsewhere", { projectId, engine: "pi", sessionId: "elsewhere-session", nodeId: elsewhere, name: "Away", instructions: "" });
  const [away] = await localAssistantSummaries("summary-elsewhere");
  assert.deepEqual([away.nodeId, away.machineName], [elsewhere, "another machine"]);
});

test("helpers explain why they can't be asked", async () => {
  const [askerProject, helperProject] = [await privateProject("asker"), await privateProject("helper")];
  const asker = await savePersonalAssistant("helpers-owner", { projectId: askerProject, engine: "pi", sessionId: "asker-session", name: "Planner", instructions: "" });
  const helper = await savePersonalAssistant("helpers-owner", { projectId: helperProject, engine: "pi", sessionId: "helper-session", name: "Calendar", instructions: "" });
  const reasons = async () => (await askableHelpers(asker)).map(view => [view.id, view.available, view.reason]);
  assert.deepEqual(await reasons(), [[helper.id, true, null]]);

  await setAskSwitch(asker.id, helper.id, false);
  assert.deepEqual(await reasons(), [[helper.id, false, "Turned off for this assistant."]]);
  await setAskSwitch(asker.id, helper.id, true);

  const db = await clusterV2Database(), local = (await getClusterNode()).id, cluster = randomUUID();
  createSharingCluster(db, { id: cluster, name: "Team" }, local);
  addSharingMember(db, cluster, local, randomUUID(), getSharingCluster(db, cluster).managerEpoch);
  setResourceShares(db, local, "project", helperProject, [{ clusterId: cluster, projectId: null }]);
  assert.deepEqual(await reasons(), [[helper.id, false, "Calendar is in a shared project, so other assistants can't ask it."]]);
  setResourceShares(db, local, "project", askerProject, [{ clusterId: cluster, projectId: null }]);
  assert.deepEqual(await reasons(), [[helper.id, false, "Planner is in a shared project, so it can't ask your other assistants."]]);
});

test("twin sync never polls", async () => {
  assert.doesNotMatch(await readFile("src/assistant-collaboration/twin-sync.ts", "utf8"), /setInterval/);
});

async function eventually<T>(check: () => T | undefined, limitMs: number): Promise<T> {
  const deadline = Date.now() + limitMs;
  for (;;) {
    const found = check();
    if (found !== undefined) return found;
    assert.ok(Date.now() < deadline, "timed out");
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

test("twins exchange assistant lists without polling", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assistant-directory-twins-"));
  const env = await seedDevEnvironment(root, 2), [a, b] = env.nodes;
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    for (const node of env.nodes) children.push(await startDevNode(env, node, { JOINT_BOB_TEST_MULTI_USER_READY: "1" }));
    await pairTwinNodes(env);
    const sb = await signIn(env, b);
    const projectId = b.projects[0].id;
    const sessions = await api<{ sessions: Array<{ id: string; harnessId: string }> }>(b, sb, "GET", `/projects/${projectId}/sessions`);
    const conversation = sessions.body.sessions[0];
    const created = await api<{ assistant: { id: string } }>(b, sb, "POST", "/personal-assistants", { projectId, engine: conversation.harnessId, sessionId: conversation.id, name: "On B", instructions: "Helps from B" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    // The announce from B is the only thing that makes A pull.
    const db = new DatabaseSync(path.join(a.dataDir, "node.db"));
    try {
      const summary = await eventually(() => {
        // The table appears with the first pull.
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='assistant_twin_summaries'").get()) return undefined;
        const row = db.prepare("SELECT summary FROM assistant_twin_summaries WHERE assistant_id=?").get(created.body.assistant.id) as { summary: string } | undefined;
        return row && JSON.parse(row.summary) as { nodeId: string; name: string; about: string };
      }, 10_000);
      assert.deepEqual([summary.nodeId, summary.name, summary.about], [b.nodeId, "On B", "Helps from B"]);
      const manifest = await signedNodeRequest(env, a, b, "POST", "/api/cluster/v2/assistants/manifest", {});
      assert.equal(manifest.status, 200, "a twin may read the manifest");
      assert.deepEqual((await manifest.json() as { assistants: Array<{ id: string }> }).assistants.map(item => item.id), [created.body.assistant.id]);
    } finally { db.close(); }
  } finally { await Promise.all(children.map(stopDevNode)); await rm(root, { recursive: true, force: true }); }
});

async function pairAsCluster(env: Awaited<ReturnType<typeof seedDevEnvironment>>, manager: SeededNode, member: SeededNode): Promise<void> {
  const [sm, sj] = await Promise.all([signIn(env, manager), signIn(env, member)]);
  const created = await api<{ snapshot: { body: { clusterId: string } } }>(manager, sm, "POST", "/clusters", { name: "Not twins" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const invitation = await api<{ link: string }>(manager, sm, "POST", `/clusters/${created.body.snapshot.body.clusterId}/invitations`, { expectedEpoch: 1 });
  assert.equal((await api(member, sj, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);
}

test("only twins can read the manifest", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "assistant-directory-cluster-"));
  const env = await seedDevEnvironment(root, 2), [a, b] = env.nodes;
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    for (const node of env.nodes) children.push(await startDevNode(env, node, { JOINT_BOB_TEST_MULTI_USER_READY: "1" }));
    await pairAsCluster(env, a, b);
    for (const target of ["/api/cluster/v2/assistants/manifest", "/api/cluster/v2/assistants/changed", "/api/cluster/v2/assistants/ask", "/api/cluster/v2/assistants/ask-status"]) {
      assert.equal((await signedNodeRequest(env, b, a, "POST", target, {})).status, 403, target);
    }
  } finally { await Promise.all(children.map(stopDevNode)); await rm(root, { recursive: true, force: true }); }
});
