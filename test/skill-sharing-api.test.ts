import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

async function join(a: SeededNode, sa: SignedIn, b: SeededNode, sb: SignedIn, name: string) {
  const created = await api<{ snapshot: { body: { clusterId: string } } }>(a, sa, "POST", "/clusters", { name });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.snapshot.body.clusterId;
  const invitation = await api<{ link: string }>(a, sa, "POST", `/clusters/${id}/invitations`, { expectedEpoch: 1 });
  const result = await api(b, sb, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return id;
}
const managed = (environment: DevEnvironment, name = "portable") => path.join(environment.home, "JointBob/.agent-resources/shared/skills", name);
const manifest = "---\nname: portable\ndescription: Private test instructions\n---\nDo nothing.\n";

async function refresh(node: SeededNode, session: SignedIn) {
  const response = await api<{ peerStatus: Array<{ error: string | null }> }>(node, session, "POST", "/resources/skills/refresh", {});
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}
async function sharing(node: SeededNode, session: SignedIn, ids: string[]) {
  const response = await api(node, session, "PUT", "/resources/skills/portable/sharing", { clusterIds: ids });
  assert.equal(response.status, 200, JSON.stringify(response.body));
}

test("skill grants distribute to selected clusters, never relay, revoke, preserve edits, and remove without resurrection", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-clusters-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const environments = await Promise.all(["a", "b", "c"].map((key) => seedDevEnvironment(path.join(root, key), 1)));
    const [ea, eb, ec] = environments;
    const [a, b, c] = environments.map((env) => env.nodes[0]);
    await mkdir(path.join(managed(ea), "scripts"), { recursive: true });
    await writeFile(path.join(managed(ea), "SKILL.md"), manifest);
    await writeFile(path.join(managed(ea), "scripts/run.sh"), "#!/bin/sh\necho synthetic\n");
    await chmod(path.join(managed(ea), "scripts/run.sh"), 0o700);
    // Independent native copy must not resurrect a removed managed skill.
    const native = path.join(ea.home, ".pi/agent/skills/portable");
    await mkdir(native, { recursive: true });
    await writeFile(path.join(native, "SKILL.md"), manifest + "independent native copy\n");
    for (const env of environments) children.push(await startDevNode(env, env.nodes[0]));
    const [sa, sb, sc] = await Promise.all(environments.map((env) => signIn(env, env.nodes[0])));
    const x = await join(a, sa, b, sb, "Home");
    const y = await join(a, sa, c, sc, "Work");
    const z = await join(b, sb, c, sc, "Other");
    await refresh(b, sb);
    await assert.rejects(lstat(managed(eb)), { code: "ENOENT" });
    await sharing(a, sa, [x]);
    assert.equal((await signedNodeRequest(ec, c, a, "POST", "/api/cluster/v2/skills/bundle", { name: "portable" })).status, 403);
    await refresh(b, sb); await refresh(c, sc);
    assert.equal(await readFile(path.join(managed(eb), "SKILL.md"), "utf8"), manifest);
    assert.ok((await lstat(path.join(managed(eb), "scripts/run.sh"))).mode & 0o100);
    await assert.rejects(lstat(managed(ec)), { code: "ENOENT" });
    assert.equal((await api(b, sb, "PUT", "/resources/skills/portable/sharing", { clusterIds: [z] })).status, 403);
    const inventory = await signedNodeRequest(ec, c, a, "POST", "/api/cluster/v2/runtime/resources/inventory", {});
    assert.doesNotMatch(JSON.stringify(inventory.body), /portable|Private test instructions/);
    await sharing(a, sa, [x, y]); await refresh(c, sc);
    assert.equal(await readFile(path.join(managed(ec), "SKILL.md"), "utf8"), manifest);
    await sharing(a, sa, [y]); await refresh(b, sb);
    await assert.rejects(lstat(managed(eb)), { code: "ENOENT" });
    const nativeB = path.join(eb.home, ".pi/agent/skills/portable");
    await mkdir(nativeB, { recursive: true });
    await writeFile(path.join(nativeB, "SKILL.md"), manifest + "receiver-owned copy\n");
    const importedB = await api(b, sb, "POST", "/settings/skills/sync", { paths: [nativeB] });
    assert.equal(importedB.status, 200, JSON.stringify(importedB.body));
    assert.match(await readFile(path.join(managed(eb), "SKILL.md"), "utf8"), /receiver-owned/);
    await refresh(c, sc); assert.equal(await readFile(path.join(managed(ec), "SKILL.md"), "utf8"), manifest);
    await writeFile(path.join(managed(ec), "SKILL.md"), manifest + "local edit\n");
    await sharing(a, sa, []);
    const conflict = await refresh(c, sc);
    assert.ok(conflict.peerStatus.some((status) => status.error?.includes("Modified received skill preserved")));
    assert.match(await readFile(path.join(managed(ec), "SKILL.md"), "utf8"), /local edit/);
    const removed = await api(a, sa, "DELETE", "/resources/skills/portable");
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    // Restart invokes actual startup reconciliation, not a fake UI refresh.
    await stopDevNode(children[0]); children[0] = await startDevNode(ea, a);
    await assert.rejects(lstat(managed(ea)), { code: "ENOENT" });
    assert.match(await readFile(path.join(native, "SKILL.md"), "utf8"), /independent native/);
    const fresh = await signIn(ea, a);
    const imported = await api(a, fresh, "POST", "/settings/skills/sync", { paths: [native] });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.match(await readFile(path.join(managed(ea), "SKILL.md"), "utf8"), /independent native/);
    const dismissed = await api(c, sc, "DELETE", "/resources/skills/portable");
    assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
    const nativeC = path.join(ec.home, ".pi/agent/skills/portable");
    await mkdir(nativeC, { recursive: true });
    await writeFile(path.join(nativeC, "SKILL.md"), manifest + "dismissed receiver copy\n");
    const importedC = await api(c, sc, "POST", "/settings/skills/sync", { paths: [nativeC] });
    assert.equal(importedC.status, 200, JSON.stringify(importedC.body));
    assert.match(await readFile(path.join(managed(ec), "SKILL.md"), "utf8"), /dismissed receiver/);
  } finally {
    await Promise.all(children.map(stopDevNode));
    await rm(root, { recursive: true, force: true });
  }
});
