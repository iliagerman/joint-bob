import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

const managed = (environment: DevEnvironment) => path.join(environment.home, "JointBob/.agent-resources/shared/skills", "portable");
const scoped = (node: SeededNode) => path.join(node.dataDir, "scoped-skills/portable/portable");
const index = async (node: SeededNode) => JSON.parse(await readFile(path.join(node.dataDir, "scoped-skills/index.json"), "utf8")) as Array<{ name: string; projectIds: string[]; conversations: Array<{ projectId: string; conversationId: string }> }>;
const manifest = "---\nname: portable\ndescription: Scoped test instructions\n---\nDo nothing.\n";

test("workspace and conversation skill grants reach only nodes sharing the project, load only there, and revoke", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-scoped-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const environments = await Promise.all(["a", "b"].map((key) => seedDevEnvironment(path.join(root, key), 1)));
    const [ea, eb] = environments;
    const [a, b] = environments.map((env) => env.nodes[0]);
    await mkdir(managed(ea), { recursive: true });
    await writeFile(path.join(managed(ea), "SKILL.md"), manifest);
    for (const env of environments) children.push(await startDevNode(env, env.nodes[0]));
    const [sa, sb] = await Promise.all(environments.map((env) => signIn(env, env.nodes[0])));
    const created = await api<{ snapshot: { body: { clusterId: string } } }>(a, sa, "POST", "/clusters", { name: "Home" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const clusterId = created.body.snapshot.body.clusterId;
    const invitation = await api<{ link: string }>(a, sa, "POST", `/clusters/${clusterId}/invitations`, { expectedEpoch: 1 });
    assert.equal((await api(b, sb, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() })).status, 201);

    type Selection = { projects: Array<{ id: string; workspaceId: string }> };
    const selection = await api<Selection>(a, sa, "GET", `/clusters/${clusterId}/sharing`);
    const shared = selection.body.projects[0];
    assert.ok(shared, "node A seeds a project");
    const otherWorkspace = shared.workspaceId === "personal" ? "work" : "personal";
    const privateDirectory = path.join(root, "private"); await mkdir(privateDirectory);
    const unshared = await api<{ project: { id: string } }>(a, sa, "POST", "/projects", { name: "Private", type: otherWorkspace, path: privateDirectory, synced: false });
    assert.equal(unshared.status, 201, JSON.stringify(unshared.body));
    const sharedOnly = await api(a, sa, "PUT", `/clusters/${clusterId}/sharing`, { projectIds: [shared.id], workspaceIds: [], confirmOwnedData: true });
    assert.equal(sharedOnly.status, 200, JSON.stringify(sharedOnly.body));

    // Unknown targets are refused, not silently dropped.
    assert.equal((await api(a, sa, "PUT", "/resources/skills/portable/sharing", { clusterIds: [], workspaceIds: ["missing"] })).status, 400);
    assert.equal((await api(a, sa, "PUT", "/resources/skills/portable/sharing", { clusterIds: [], projectIds: ["missing"] })).status, 400);
    assert.equal((await api(a, sa, "PUT", "/resources/skills/portable/sharing", { clusterIds: [], projectIds: [shared.id, shared.id] })).status, 400);
    assert.equal((await api(a, sa, "PUT", "/resources/skills/portable/sharing", { clusterIds: [], conversations: [{ projectId: "missing", conversationId: "c-1" }] })).status, 400);

    const conversations = [{ projectId: shared.id, conversationId: "conversation-1" }, { projectId: unshared.body.project.id, conversationId: "conversation-2" }];
    const granted = await api<{ conversations: unknown[]; workspaceIds: string[] }>(a, sa, "PUT", "/resources/skills/portable/sharing", { clusterIds: [], conversations });
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    const byProject = (items: Array<{ projectId: string }>) => [...items].sort((left, right) => left.projectId < right.projectId ? -1 : 1);
    assert.deepEqual(byProject(granted.body.conversations as typeof conversations), byProject(conversations));
    const view = await api<{ workspaces: Array<{ id: string }>; skills: Array<{ name: string; conversations: unknown[] }> }>(a, sa, "GET", "/resources/skills/sharing");
    assert.ok(view.body.workspaces.some((workspace) => workspace.id === shared.workspaceId), "the sharing view lists this node's workspaces");
    assert.equal(view.body.skills.find((skill) => skill.name === "portable")?.conversations.length, 2);

    assert.equal((await api(b, sb, "POST", "/resources/skills/refresh", {})).status, 200);
    await assert.rejects(lstat(managed(eb)), { code: "ENOENT" }, "a scoped grant never lands where every conversation loads it");
    assert.equal(await readFile(path.join(scoped(b), "SKILL.md"), "utf8"), manifest);
    assert.deepEqual(await index(b), [{ name: "portable", projectIds: [], conversations: [conversations[0]] }], "only the conversation in a project shared with B reaches B");
    assert.equal((await signedNodeRequest(eb, b, a, "POST", "/api/cluster/v2/skills/bundle", { name: "portable" })).status, 200);
    const peerInventory = await signedNodeRequest(ea, a, b, "POST", "/api/cluster/v2/runtime/resources/inventory", {});
    assert.doesNotMatch(JSON.stringify(peerInventory.body), /Scoped test instructions/, "a scoped copy is not disclosed to the owner's peers");

    const projectGrant = await api(a, sa, "PUT", "/resources/skills/portable/sharing", { clusterIds: [], projectIds: [shared.id, unshared.body.project.id] });
    assert.equal(projectGrant.status, 200, JSON.stringify(projectGrant.body));
    await api(b, sb, "POST", "/resources/skills/refresh", {});
    assert.deepEqual(await index(b), [{ name: "portable", projectIds: [shared.id], conversations: [] }], "direct project grants authorize only projects shared with the receiver");
    const inventory = async (projectId?: string, conversationId?: string) => {
      const result = await api<{ nodes: Array<{ inventory: { skills: Array<{ name: string }> } }> }>(a, sa, "GET", `/resources/inventory?${new URLSearchParams({ ...(projectId ? { projectId } : {}), ...(conversationId ? { conversationId } : {}) })}`);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return { body: result.body.nodes[0].inventory };
    };
    assert.equal((await inventory()).body.skills.some((skill) => skill.name === "portable"), false, "owner node-wide inventory cannot leak project-scoped skills");
    assert.equal((await inventory(shared.id)).body.skills.some((skill) => skill.name === "portable"), true);
    assert.equal((await api(a, sa, "GET", "/usage/skills/content?name=portable")).status, 404);
    assert.equal((await api(a, sa, "GET", `/usage/skills/content?name=portable&projectId=${shared.id}`)).status, 200);
    await writeFile(path.join(managed(ea), "SKILL.md"), manifest + "Updated instructions.\n");
    await api(b, sb, "POST", "/resources/skills/refresh", {});
    assert.equal(await readFile(path.join(scoped(b), "SKILL.md"), "utf8"), manifest + "Updated instructions.\n", "scoped receivers get content updates");
    await writeFile(path.join(managed(ea), "SKILL.md"), manifest);
    await api(a, sa, "PUT", "/resources/skills/portable/sharing", { clusterIds: [], conversations: [conversations[0]] });
    assert.equal((await inventory(shared.id)).body.skills.some((skill) => skill.name === "portable"), false);
    assert.equal((await inventory(shared.id, "conversation-1")).body.skills.some((skill) => skill.name === "portable"), true);
    assert.equal((await api(a, sa, "GET", `/usage/skills/content?name=portable&projectId=${shared.id}&conversationId=conversation-1`)).status, 200);
    assert.equal((await api(a, sa, "GET", `/usage/skills/content?name=portable&projectId=${shared.id}&conversationId=other`)).status, 404);
    for (const conversationId of ["conversation-1", "other"]) {
      const commands = await api<{ commands: Array<{ name: string }> }>(a, sa, "GET", `/projects/${shared.id}/commands?harness=pi&conversationId=${conversationId}`);
      assert.equal(commands.status, 200, JSON.stringify(commands.body));
      assert.equal(commands.body.commands.some((command) => command.name === "skill:portable"), conversationId === "conversation-1", "slash command discovery follows conversation scope");
    }

    const workspace = await api(a, sa, "PUT", "/resources/skills/portable/sharing", { clusterIds: [], workspaceIds: [shared.workspaceId, otherWorkspace], conversations: [conversations[0]] });
    assert.equal(workspace.status, 200, JSON.stringify(workspace.body));
    await api(b, sb, "POST", "/resources/skills/refresh", {});
    assert.deepEqual(await index(b), [{ name: "portable", projectIds: [shared.id], conversations: [] }], "a workspace grant covers its shared projects and absorbs their conversation grants");

    await api(a, sa, "PUT", "/resources/skills/portable/sharing", { clusterIds: [clusterId] });
    await api(b, sb, "POST", "/resources/skills/refresh", {});
    assert.equal(await readFile(path.join(managed(eb), "SKILL.md"), "utf8"), manifest, "a cluster grant upgrades the copy to every conversation");
    await assert.rejects(lstat(scoped(b)), { code: "ENOENT" });
    assert.deepEqual(await index(b), []);

    await api(a, sa, "PUT", "/resources/skills/portable/sharing", { clusterIds: [], conversations: [conversations[0]] });
    await api(b, sb, "POST", "/resources/skills/refresh", {});
    await assert.rejects(lstat(managed(eb)), { code: "ENOENT" });
    assert.equal((await index(b)).length, 1);

    const revoked = await api(a, sa, "PUT", "/resources/skills/portable/sharing", { clusterIds: [] });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    await api(b, sb, "POST", "/resources/skills/refresh", {});
    await assert.rejects(lstat(scoped(b)), { code: "ENOENT" });
    assert.deepEqual(await index(b), []);
    assert.equal((await signedNodeRequest(eb, b, a, "POST", "/api/cluster/v2/skills/bundle", { name: "portable" })).status, 403);

    // Local edits must never retain permission that the owner narrowed or revoked.
    await api(a, sa, "PUT", "/resources/skills/portable/sharing", { clusterIds: [], projectIds: [shared.id] });
    await api(b, sb, "POST", "/resources/skills/refresh", {});
    await writeFile(path.join(scoped(b), "SKILL.md"), manifest + "Local edits.\n");
    await api(a, sa, "PUT", "/resources/skills/portable/sharing", { clusterIds: [], conversations: [conversations[0]] });
    await api(b, sb, "POST", "/resources/skills/refresh", {});
    assert.deepEqual(await index(b), [{ name: "portable", projectIds: [], conversations: [conversations[0]] }], "scope narrowing survives a refused content overwrite");
    await api(a, sa, "PUT", "/resources/skills/portable/sharing", { clusterIds: [] });
    await api(b, sb, "POST", "/resources/skills/refresh", {});
    assert.equal(await readFile(path.join(scoped(b), "SKILL.md"), "utf8"), manifest + "Local edits.\n", "revocation preserves locally modified files");
    const denied = await api<{ nodes: Array<{ inventory: { skills: Array<{ name: string }> } }> }>(b, sb, "GET", `/resources/inventory?projectId=${shared.id}&conversationId=conversation-1`);
    assert.equal(denied.status, 200, JSON.stringify(denied.body));
    assert.equal(denied.body.nodes[0].inventory.skills.some((skill) => skill.name === "portable"), false, "preserved revoked files never remain available");
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
