import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";
import { startNativeSyncthing, stopNativeSyncthing } from "./native-syncthing.js";

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

async function until(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return check();
}

type Worktree = { id: string; name: string; path: string };

test("a worktree reaches the other node through native Syncthing, keeps heavy files out, and its deletion removes it there", { timeout: 360_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "worktree-native-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  const syncs: Awaited<ReturnType<typeof startNativeSyncthing>>[] = [];
  try {
    const a = await seedDevEnvironment(path.join(root, "a"), 1), b = await seedDevEnvironment(path.join(root, "b"), 1);
    const left = a.nodes[0], right = b.nodes[0];
    await rm(path.join(b.home, ".pi", "sessions"), { recursive: true, force: true });
    await rm(path.join(b.home, ".claude", "projects"), { recursive: true, force: true });
    const syncA = await startNativeSyncthing(path.join(root, "syncthing-a")); syncs.push(syncA);
    const syncB = await startNativeSyncthing(path.join(root, "syncthing-b")); syncs.push(syncB);
    for (const [local, peer] of [[syncA, syncB], [syncB, syncA]]) await local.request(`config/devices/${peer.deviceId}`, { deviceID: peer.deviceId, name: "Test peer", addresses: [peer.address] });
    for (const [env, node, sync] of [[a, left, syncA], [b, right, syncB]] as const) children.push(await startDevNode(env, node, { JOINT_BOB_SYNCTHING_URL: sync.url, JOINT_BOB_SYNCTHING_API_KEY: sync.key }));
    const sa = await signIn(a, left), sb = await signIn(b, right);
    const invitation = await api<{ link: string }>(left, sa, "POST", "/twins/invitations", { confirmOwnedData: true });
    assert.equal((await api(right, sb, "POST", "/twins/accept", { link: invitation.body.link, confirmOwnedData: true })).status, 201);

    const directory = path.join(root, "project");
    await mkdir(path.join(directory, "src"), { recursive: true });
    await writeFile(path.join(directory, "src", "inbox.ts"), "export const inbox = 'mock';\n");
    const created = await api<{ project: { id: string } }>(left, sa, "POST", "/projects", { name: "Worktree native", type: "personal", path: directory, synced: true });
    assert.equal(created.status, 201);
    const projectId = created.body.project.id;

    const made = await api<{ worktree: Worktree }>(left, sa, "POST", `/projects/${projectId}/worktrees`, { name: "Native slice" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const source = made.body.worktree;
    await mkdir(path.join(source.path, "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(source.path, "node_modules", "pkg", "index.js"), "module.exports = 1;\n");
    await writeFile(path.join(source.path, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]));
    await writeFile(path.join(source.path, "src", "later.ts"), "export const later = true;\n");

    let remote: Worktree | undefined;
    const arrived = await until(async () => {
      remote = (await api<{ worktrees: Worktree[] }>(right, sb, "GET", `/projects/${projectId}/worktrees`)).body.worktrees?.find((worktree) => worktree.id === source.id);
      return Boolean(remote && await exists(path.join(remote.path, "src", "later.ts")) && await exists(path.join(remote.path, "src", "inbox.ts")));
    }, 60_000);
    assert.equal(arrived, true, "the worktree and files added to it later reach the other node");
    assert.equal(remote!.name, "Native slice");
    assert.equal(await readFile(path.join(remote!.path, "src", "inbox.ts"), "utf8"), "export const inbox = 'mock';\n");
    assert.equal(await exists(path.join(remote!.path, "node_modules")), false, "packages never travel");
    assert.equal(await exists(path.join(remote!.path, "logo.png")), false, "binaries never travel");

    // The other node installs its own packages and records a conversation there.
    await mkdir(path.join(remote!.path, "node_modules", "local"), { recursive: true });
    await writeFile(path.join(remote!.path, "node_modules", "local", "x.js"), "local only\n");
    const marker = path.join(remote!.path, ".joint-bob-worktree", "conversations", "pi--remote-conversation.json");
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, "{}\n");
    assert.equal(await until(() => exists(path.join(source.path, ".joint-bob-worktree", "conversations", "pi--remote-conversation.json")), 90_000), true, "conversation markers travel back");
    assert.equal(await until(() => exists(path.join(source.path, ".joint-bob-worktree", "nodes", `${right.nodeId}.json`)), 90_000), true, "every node publishes its own worktree path");

    const removed = await fetch(`${left.url}/api/projects/${projectId}/worktrees/${source.id}`, { method: "DELETE", headers: { Cookie: sa.cookie, "x-csrf-token": sa.csrfToken } });
    assert.equal(removed.status, 204);
    assert.equal(await until(async () => !await exists(remote!.path), 60_000), true, "deleting the worktree removes it on the other node, ignored packages included");
    assert.deepEqual((await api<{ worktrees: Worktree[] }>(right, sb, "GET", `/projects/${projectId}/worktrees`)).body.worktrees, []);
  } finally {
    await Promise.all(children.map(stopDevNode));
    await Promise.all(syncs.map((sync) => stopNativeSyncthing(sync.child)));
    await rm(root, { recursive: true, force: true });
  }
});
