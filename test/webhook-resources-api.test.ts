import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

test("webhook files and editable memory use the authenticated management API", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-webhook-resources-api-"));
  let server;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const [node] = environment.nodes;
    const projectSkill = path.join(node.projects[0].path, ".agents", "skills", "project-review");
    await mkdir(projectSkill, { recursive: true });
    await writeFile(path.join(projectSkill, "SKILL.md"), "---\nname: project-review\ndescription: Review project references.\n---\n");
    server = await startDevNode(environment, node);
    const auth = await signIn(environment, node);
    const created = await api<{ webhook: { id: string } }>(node, auth, "POST", "/webhooks", { name: "Resources", target: { kind: "project", projectId: node.projects[0].id, engine: "pi" } });
    assert.equal(created.status, 201);
    const id = created.body.webhook.id;
    const bytes = Buffer.from("static CSV bytes");
    const saved = await api<{ resource: { id: string; description: string } }>(node, auth, "POST", `/webhooks/${id}/resources`, {
      kind: "file", name: "rates.csv", description: "Reference rates", mimeType: "text/csv", data: bytes.toString("base64"),
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const list = await api<{ resources: Array<{ id: string; description: string; path?: string }> }>(node, auth, "GET", `/webhooks/${id}/resources`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.resources.map(resource => [resource.id, resource.description, resource.path]), [[saved.body.resource.id, "Reference rates", undefined]]);
    const download = await api<{ name: string; data: string }>(node, auth, "GET", `/webhooks/${id}/resources/${saved.body.resource.id}/download`);
    assert.equal(Buffer.from(download.body.data, "base64").toString(), bytes.toString());
    assert.equal((await api(node, auth, "POST", `/webhooks/${id}/memory`, { action: "enable", enabled: true })).status, 200);
    const initial = await api<{ revision: string; content: string }>(node, auth, "GET", `/webhooks/${id}/memory`);
    assert.equal(initial.body.content, "");
    const changed = await api<{ revision: string; content: string }>(node, auth, "PUT", `/webhooks/${id}/memory`, { content: "# Useful lesson\n", expectedRevision: initial.body.revision });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.content, "# Useful lesson\n");
    const stale = await api(node, auth, "PUT", `/webhooks/${id}/memory`, { content: "overwritten\n", expectedRevision: initial.body.revision });
    assert.equal(stale.status, 409);
    const inventory = await api<{ skills: Array<{ inventoryId: string; name: string }> }>(node, auth, "GET", `/webhooks/${id}/skills?inventory=1`);
    assert.equal(inventory.status, 200);
    assert.equal(JSON.stringify(inventory.body).includes(node.projects[0].path), false, "inventory ids do not reveal local paths");
    const selectable = inventory.body.skills.find(skill => skill.name === "project-review");
    assert.ok(selectable);
    const imported = await api<{ skill: { id: string; name: string; path?: string } }>(node, auth, "POST", `/webhooks/${id}/skills`, { action: "import-existing", inventoryId: selectable.inventoryId });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    assert.equal(imported.body.skill.name, "project-review");
    assert.equal(imported.body.skill.path, undefined);
    const uploaded = await api<{ skill: { name: string; path?: string } }>(node, auth, "POST", `/webhooks/${id}/skills`, { action: "upload", files: [{ relativePath: "SKILL.md", data: Buffer.from("---\nname: webhook-review\ndescription: Uploaded reference skill.\n---\n").toString("base64") }] });
    assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
    assert.equal(uploaded.body.skill.name, "webhook-review");
    assert.equal(uploaded.body.skill.path, undefined);
  } finally {
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
