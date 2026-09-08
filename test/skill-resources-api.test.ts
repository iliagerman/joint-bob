import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
let root: string, environment: DevEnvironment, node: SeededNode, session: SignedIn, server: ChildProcess;
before(async () => { root = await mkdtemp(path.join(os.tmpdir(), "skill-api-")); environment = await seedDevEnvironment(root, 1); node = environment.nodes[0]; server = await startDevNode(environment, node); session = await signIn(environment, node); }, { timeout: 120_000 });
after(async () => { if (server) await stopDevNode(server); if (root) await rm(root, { recursive: true, force: true }); });
test("authenticated skill publishing and reload endpoints validate and expose published skills", async () => {
  const source = path.join(root, "external"); await mkdir(path.join(source, "api-skill"), { recursive: true });
  await writeFile(path.join(source, "api-skill/SKILL.md"), "---\nname: api-skill\ndescription: first\n---\n");
  const published = await api<{ published: string[] }>(node, session, "POST", "/settings/skills/sync", { paths: [source] });
  assert.equal(published.status, 200); assert.deepEqual(published.body.published, ["api-skill"]);
  assert.match(await readFile(path.join(environment.home, "JointBob/.agent-resources/shared/skills/api-skill/SKILL.md"), "utf8"), /first/);
  await writeFile(path.join(source, "api-skill/SKILL.md"), "---\nname: api-skill\ndescription: second\n---\n");
  assert.equal((await api(node, session, "POST", "/settings/skills/sync", { paths: [source] })).status, 200);
  const listed = await api<{ skills: Array<{ name: string; description: string }> }>(node, session, "GET", `/projects/${node.projects[0].id}/skills`);
  assert.ok(listed.body.skills.some((skill) => skill.name === "api-skill" && skill.description === "second"));
  const reload = await api<{ reloaded: number; skipped: number; failed: unknown[] }>(node, session, "POST", "/settings/skills/reload", {});
  assert.equal(reload.status, 200);
  assert.deepEqual(reload.body, { reloaded: 0, skipped: 0, failed: [] });
  for (const paths of [[], ["relative"], [path.join(root, "missing")]]) assert.equal((await api(node, session, "POST", "/settings/skills/sync", { paths })).status, 400);
  for (const endpoint of ["sync", "reload"]) {
    const rejected = await fetch(`${node.url}/api/settings/skills/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: session.cookie },
      body: endpoint === "sync" ? JSON.stringify({ paths: [source] }) : "{}",
    });
    assert.equal(rejected.status, 403);
  }
  const unauthenticated = await fetch(`${node.url}/api/settings/skills/reload`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(unauthenticated.status, 401);
});
