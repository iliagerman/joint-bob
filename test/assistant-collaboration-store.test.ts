import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { remapAccountKey } from "../src/account-keys.js";
import { askAllowedBySwitch, asksForTurns, asksServedBy, finishAsk, getAsk, insertAsk, setAskSwitch } from "../src/assistant-collaboration/store.js";
import { getClusterNode } from "../src/cluster.js";
import { addSharingMember, createSharingCluster, getSharingCluster, registerOwnedResource, setResourceShares } from "../src/cluster-sharing-policy.js";
import { clusterV2Database } from "../src/cluster-v2-store.js";
import { beginPersonalAssistantTurn, finishPersonalAssistantTurn, runningPersonalAssistantTurn, savePersonalAssistant } from "../src/personal-assistants.js";
import { addProject, projectPrivateToOwner } from "../src/store.js";

const ask = (id: string, over: Record<string, string | null> = {}) => ({
  id, accountId: "owner", askerId: "a", askerName: "Work", askerTurnRequestId: "turn-1", helperId: "b", helperName: "Calendar",
  helperNodeId: "node", purpose: "work calendar", question: "When am I free?", startedAt: "2026-11-03T08:00:00.000Z", ...over,
});

test("turns record where they came from", async () => {
  const assistant = await savePersonalAssistant("owner", { projectId: "project", engine: "pi", sessionId: "origin-session", name: "Origin", instructions: "" });
  await beginPersonalAssistantTurn("owner", assistant.id, "hook-1", "pi:origin-session", "Payload", "webhook");
  assert.deepEqual(await runningPersonalAssistantTurn(assistant.id, ["pi:other", "pi:origin-session"]), { requestId: "hook-1", origin: "webhook" });
  assert.equal(await runningPersonalAssistantTurn(assistant.id, ["pi:other"]), null);
  await finishPersonalAssistantTurn("owner", assistant.id, "hook-1", "Done");
  assert.equal(await runningPersonalAssistantTurn(assistant.id, ["pi:origin-session"]), null);
});

test("switches default on and turn off per direction", async () => {
  assert.equal(await askAllowedBySwitch("a", "b"), true);
  await setAskSwitch("a", "b", false);
  assert.equal(await askAllowedBySwitch("a", "b"), false);
  assert.equal(await askAllowedBySwitch("b", "a"), true);
  await setAskSwitch("a", "b", true);
  assert.equal(await askAllowedBySwitch("a", "b"), true);
});

test("an ask finishes once", async () => {
  await insertAsk(ask("ask-1"));
  await insertAsk(ask("ask-1", { question: "Different" }));
  assert.equal((await asksServedBy("b")).length, 1);
  assert.equal((await getAsk("ask-1"))!.question, "When am I free?");
  assert.equal(await finishAsk("ask-1", { answer: "x" }), true);
  assert.equal(await finishAsk("ask-1", { error: "y" }), false);
  const done = (await getAsk("ask-1"))!;
  assert.deepEqual([done.status, done.answer, done.error], ["completed", "x", null]);
  assert.deepEqual((await asksForTurns("a", ["turn-1"])).map(row => row.id), ["ask-1"]);
  assert.deepEqual(await asksForTurns("a", ["turn-2"]), []);
  await insertAsk(ask("ask-2", { startedAt: "2026-11-03T09:00:00.000Z" }));
  await finishAsk("ask-2", { error: "offline" });
  assert.deepEqual((await asksServedBy("b")).map(row => [row.id, row.status, row.error]), [["ask-2", "failed", "offline"], ["ask-1", "completed", null]]);
  assert.equal(await getAsk("missing"), null);
});

test("a project shared into a cluster is not private", async () => {
  const db = await clusterV2Database(), local = (await getClusterNode()).id, cluster = randomUUID();
  createSharingCluster(db, { id: cluster, name: "Work" }, local);
  addSharingMember(db, cluster, local, randomUUID(), getSharingCluster(db, cluster).managerEpoch);
  const folder = path.join(os.homedir(), "private-check");
  await mkdir(folder, { recursive: true });
  const project = await addProject("Private check", folder, { writeInstructions: false });
  registerOwnedResource(db, { kind: "project", id: project.id, ownerNodeId: local }, local);
  assert.equal(await projectPrivateToOwner(project.id), true);
  assert.equal(await projectPrivateToOwner("missing-project"), false);
  setResourceShares(db, local, "project", project.id, [{ clusterId: cluster, projectId: null }]);
  assert.equal(await projectPrivateToOwner(project.id), false);
});

test("assistant rows follow an account id change", async () => {
  const assistant = await savePersonalAssistant("old-account", { projectId: "project", engine: "pi", sessionId: "account-session", name: "Mover", instructions: "" });
  remapAccountKey(await clusterV2Database(), "old-account", "new-account");
  const row = (await clusterV2Database()).prepare("SELECT account_id accountId FROM personal_assistants WHERE id=?").get(assistant.id) as { accountId: string };
  assert.equal(row.accountId, "new-account");
});

test("a failure reading the shares is not read as private", async () => {
  const db = await clusterV2Database(), local = (await getClusterNode()).id;
  const folder = path.join(os.homedir(), "unreadable-shares");
  await mkdir(folder, { recursive: true });
  const project = await addProject("Unreadable shares", folder, { writeInstructions: false });
  registerOwnedResource(db, { kind: "project", id: project.id, ownerNodeId: local }, local);
  assert.equal(await projectPrivateToOwner(project.id), true);
  db.exec("DROP TABLE sharing_resource_shares");
  await assert.rejects(projectPrivateToOwner(project.id));
});
