import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { startNativeSyncthing, stopNativeSyncthing } from "./native-syncthing.js";

/** Forwards a node's Syncthing REST calls and records each one, so a test can see how often the node asks. */
async function countingProxy(target: string): Promise<{ url: string; requests: string[]; server: Server }> {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([name, value]) => typeof value === "string" && !["host", "connection", "content-length"].includes(name))) as Record<string, string>;
      fetch(`${target}${request.url}`, { method: request.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) })
        .then(async (answer) => { response.writeHead(answer.status, { "Content-Type": answer.headers.get("content-type") ?? "application/json" }); response.end(Buffer.from(await answer.arrayBuffer())); })
        .catch(() => { response.writeHead(502); response.end(); });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, server };
}

async function arrives(file: string, content: string, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    try { if (await readFile(file, "utf8") === content) return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

// Enrollment asks the peer and then walks every shared folder through Syncthing's REST API on
// both machines. It ran on every administration flush, a few seconds apart, so two idle twins
// sent each other's Syncthing hundreds of requests a cycle to confirm what was already set up.
test("idle twins leave Syncthing alone, and a newly shared project is still enrolled", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "twin-idle-enrollment-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  const syncs: Awaited<ReturnType<typeof startNativeSyncthing>>[] = [];
  const proxies: Awaited<ReturnType<typeof countingProxy>>[] = [];
  try {
    const a = await seedDevEnvironment(path.join(root, "a"), 1), b = await seedDevEnvironment(path.join(root, "b"), 1);
    const left = a.nodes[0], right = b.nodes[0];
    // The fixture generator reuses demo session UUIDs across independent environments.
    await rm(path.join(b.home, ".pi", "sessions"), { recursive: true, force: true });
    await rm(path.join(b.home, ".claude", "projects"), { recursive: true, force: true });
    const syncA = await startNativeSyncthing(path.join(root, "syncthing-a")); syncs.push(syncA);
    const syncB = await startNativeSyncthing(path.join(root, "syncthing-b")); syncs.push(syncB);
    for (const [local, peer] of [[syncA, syncB], [syncB, syncA]]) await local.request(`config/devices/${peer.deviceId}`, { deviceID: peer.deviceId, name: "Test peer", addresses: [peer.address] });
    const proxyA = await countingProxy(syncA.url), proxyB = await countingProxy(syncB.url); proxies.push(proxyA, proxyB);
    for (const [env, node, sync, proxy] of [[a, left, syncA, proxyA], [b, right, syncB, proxyB]] as const) {
      children.push(await startDevNode(env, node, { JOINT_BOB_SYNCTHING_URL: proxy.url, JOINT_BOB_SYNCTHING_API_KEY: sync.key }));
    }
    const sa = await signIn(a, left), sb = await signIn(b, right);
    const invitation = await api<{ link: string }>(left, sa, "POST", "/twins/invitations", { confirmOwnedData: true });
    assert.equal((await api(right, sb, "POST", "/twins/accept", { link: invitation.body.link, confirmOwnedData: true })).status, 201);

    const share = async (name: string, content: string, owner: SeededNode, session: SignedIn, peer: SeededNode, peerSession: SignedIn): Promise<void> => {
      const directory = path.join(root, name);
      await mkdir(directory);
      await writeFile(path.join(directory, "shared.txt"), content);
      const created = await api<{ project: { id: string } }>(owner, session, "POST", "/projects", { name, type: "personal", path: directory, synced: true });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const deadline = Date.now() + 45_000;
      let mirrored = "";
      while (!mirrored && Date.now() < deadline) {
        mirrored = (await api<{ projects: Array<{ id: string; path: string }> }>(peer, peerSession, "GET", "/projects")).body.projects.find((project) => project.id === created.body.project.id)?.path ?? "";
        if (!mirrored) await new Promise((resolve) => setTimeout(resolve, 200));
      }
      assert.ok(mirrored, `${name} must reach the twin`);
      assert.equal(await arrives(path.join(mirrored, "shared.txt"), content, 45_000), true, `${name}'s files must reach the twin`);
    };
    await share("First shared", "first", left, sa, right, sb);

    // Enrollment in flight may still be finishing: wait until neither Syncthing has been asked
    // for five seconds, then watch a stretch in which nothing changes.
    const configuration = (proxy: (typeof proxies)[number]): string[] => proxy.requests.filter((request) => /\/rest\/(config|db\/ignores)/.test(request));
    const asked = (): number => configuration(proxyA).length + configuration(proxyB).length;
    const settleBy = Date.now() + 90_000;
    for (let seen = asked(), quietSince = Date.now(); Date.now() - quietSince < 5_000;) {
      assert.ok(Date.now() < settleBy, `idle twins never stopped asking Syncthing for configuration (${asked()} requests so far)`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      if (asked() !== seen) { seen = asked(); quietSince = Date.now(); }
    }
    for (const proxy of proxies) proxy.requests.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    for (const [name, proxy] of [["first", proxyA], ["second", proxyB]] as const) {
      const requests = configuration(proxy);
      assert.ok(requests.length <= 2, `the ${name} node asked its Syncthing for configuration ${requests.length} times in 12 idle seconds: ${[...new Set(requests)].join(", ")}`);
    }

    await share("Second shared", "second", right, sb, left, sa);
  } finally {
    await Promise.all(children.map(stopDevNode));
    await Promise.all(syncs.map((sync) => stopNativeSyncthing(sync.child)));
    await Promise.all(proxies.map((proxy) => new Promise<void>((resolve) => { proxy.server.closeAllConnections(); proxy.server.close(() => resolve()); })));
    await rm(root, { recursive: true, force: true });
  }
});
