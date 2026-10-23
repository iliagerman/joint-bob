import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function cookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected session cookie");
  return value.split(";", 1)[0];
}

test("the global and project AGENTS.md are read, created and saved without overwriting a newer edit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-instructions-"));
  const previous = { dataDir: process.env.PI_WEB_DATA_DIR, username: process.env.MASTER_BOB_ADMIN_USERNAME, password: process.env.MASTER_BOB_INITIAL_PASSWORD };
  process.env.PI_WEB_DATA_DIR = root;
  process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
  process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
  let appServer: import("node:http").Server | undefined;
  try {
    ({ server: appServer } = await import(new URL(`../src/server.ts?instructions=${Date.now()}`, import.meta.url).href));
    const { agentResourcePaths } = await import("../src/agent-resources.ts");
    const { globalInstructionsPath } = await import("../src/agent-instructions.ts");
    const { applyGlobalInstructionsEvent } = await import("../src/global-instructions.ts");
    const { settingsDatabase } = await import("../src/settings-store.ts");
    await new Promise<void>((resolve) => appServer?.listen(0, "127.0.0.1", resolve));
    const address = appServer.address();
    if (!address || typeof address === "string") throw new Error("App server did not bind");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const login = await fetch(`${baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
    const auth = await login.json() as { csrfToken: string };
    const headers = { "Content-Type": "application/json", Cookie: cookie(login), "X-CSRF-Token": auth.csrfToken };
    await fetch(`${baseUrl}/api/auth/change-password`, { method: "POST", headers, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) });
    const get = async (url: string) => { const response = await fetch(url, { headers }); return { status: response.status, body: await response.json() as { path: string; content: string; version: string; exists?: boolean } }; };
    const put = async (url: string, content: string, version: string) => { const response = await fetch(url, { method: "PUT", headers, body: JSON.stringify({ content, version }) }); return { status: response.status, body: await response.json() as { path?: string; version?: string; error?: string } }; };

    // Every project's AGENTS.md.
    const globalUrl = `${baseUrl}/api/instructions/global/content`;
    const empty = await get(globalUrl);
    assert.deepEqual(empty.body, { path: "AGENTS.md", content: "", version: "absent" });
    const created = await put(globalUrl, "GLOBAL ONE", "absent");
    assert.equal(created.status, 200);
    const file = globalInstructionsPath(agentResourcePaths());
    assert.equal(await readFile(file, "utf8"), "GLOBAL ONE");
    assert.equal((await put(globalUrl, "LOST", "absent")).status, 409, "an editor opened before the file existed cannot overwrite it");
    const saved = await put(globalUrl, "GLOBAL TWO", created.body.version!);
    assert.equal(saved.status, 200);
    const outbox = settingsDatabase().prepare("SELECT payload FROM replication_outbox WHERE entity_type = 'instructions.global' ORDER BY created_at").all() as Array<{ payload: string }>;
    assert.deepEqual(outbox.map((row) => JSON.parse(row.payload).content), ["GLOBAL ONE", "GLOBAL TWO"], "each save goes to this person's other machines");

    // The same file edited on another machine: the newest edit wins wherever it arrives first.
    const latest = JSON.parse(outbox[1].payload) as { updatedAt: string };
    const remote = (content: string, updatedAt: string) => ({ id: `remote-${content}`, originNodeId: "other-node", entityType: "instructions.global", entityKey: "AGENTS.md", operation: "upsert", createdAt: updatedAt, payload: { content, updatedAt, originNodeId: "other-node" } });
    applyGlobalInstructionsEvent(settingsDatabase(), remote("OLDER", new Date(Date.parse(latest.updatedAt) - 60_000).toISOString()));
    assert.equal(await readFile(file, "utf8"), "GLOBAL TWO");
    applyGlobalInstructionsEvent(settingsDatabase(), remote("NEWER", new Date(Date.parse(latest.updatedAt) + 60_000).toISOString()));
    assert.equal(await readFile(file, "utf8"), "NEWER");
    assert.throws(() => applyGlobalInstructionsEvent(settingsDatabase(), { ...remote("BAD", latest.updatedAt), entityKey: "other.md" }), /Malformed/);

    // The project's own, in the folder the agent runs in.
    const projectPath = path.join(root, "project");
    await mkdir(projectPath, { recursive: true });
    const project = (await (await fetch(`${baseUrl}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Instructions", path: projectPath }) })).json() as { project: { id: string } }).project;
    const projectUrl = `${baseUrl}/api/projects/${project.id}/instructions/content`;
    await writeFile(path.join(projectPath, "CLAUDE.md"), "ONLY CLAUDE");
    const fallback = await get(projectUrl);
    assert.deepEqual([fallback.body.path, fallback.body.content, fallback.body.exists], ["CLAUDE.md", "ONLY CLAUDE", true]);
    assert.equal((await put(projectUrl, "EDITED CLAUDE", fallback.body.version)).body.path, "CLAUDE.md");
    assert.equal(await readFile(path.join(projectPath, "CLAUDE.md"), "utf8"), "EDITED CLAUDE");
    await rm(path.join(projectPath, "CLAUDE.md"));

    const absent = await get(projectUrl);
    assert.deepEqual([absent.body.path, absent.body.version, absent.body.exists], ["AGENTS.md", "absent", false]);
    const made = await put(projectUrl, "PROJECT RULES", "absent");
    assert.deepEqual([made.status, made.body.path], [200, "AGENTS.md"]);
    assert.equal(await readFile(path.join(projectPath, "AGENTS.md"), "utf8"), "PROJECT RULES");
    assert.equal((await put(projectUrl, "STALE", absent.body.version)).status, 409);
    assert.equal((await get(`${projectUrl}?worktreeId=missing`)).status, 404);

    const outside = path.join(root, "outside.md");
    await writeFile(outside, "OUTSIDE");
    await rm(path.join(projectPath, "AGENTS.md"));
    await symlink(outside, path.join(projectPath, "AGENTS.md"));
    const linked = await get(projectUrl);
    assert.equal((await put(projectUrl, "ESCAPED", linked.body.version)).status, 403);
    assert.equal(await readFile(outside, "utf8"), "OUTSIDE");
  } finally {
    await new Promise<void>((resolve) => appServer?.close(() => resolve()) ?? resolve());
    for (const [key, value] of [["PI_WEB_DATA_DIR", previous.dataDir], ["MASTER_BOB_ADMIN_USERNAME", previous.username], ["MASTER_BOB_INITIAL_PASSWORD", previous.password]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
