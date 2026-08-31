import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("workspaces seed personal and work, then accept new user-defined workspaces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-workspaces-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const { addProject, deleteWorkspace, listWorkspaces, saveWorkspace, WorkspaceError } = await import("../src/store.js");

  try {
    const seeded = await listWorkspaces();
    assert.deepEqual(seeded.map((workspace) => workspace.id), ["personal", "work"]);

    const created = await saveWorkspace({ label: "Client Work" });
    assert.equal(created.id, "client-work");
    assert.equal(created.label, "Client Work");

    const withNew = await listWorkspaces();
    assert.equal(withNew.length, 3);

    // The id is stable across a rename, so project membership and secret attachments survive.
    const renamed = await saveWorkspace({ id: "client-work", label: "Clients" });
    assert.equal(renamed.id, "client-work");
    assert.equal(renamed.label, "Clients");
    assert.equal((await listWorkspaces()).length, 3);

    await assert.rejects(() => saveWorkspace({ label: "tickets" }), WorkspaceError);
    await assert.rejects(() => saveWorkspace({ label: "   " }), WorkspaceError);

    const project = await addProject("client site", path.join(root, "work", "client-site"), { type: "client-work" });
    assert.equal(project.type, "client-work");

    await assert.rejects(() => deleteWorkspace("client-work"), WorkspaceError);

    await deleteWorkspace("work");
    assert.deepEqual((await listWorkspaces()).map((workspace) => workspace.id), ["personal", "client-work"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
