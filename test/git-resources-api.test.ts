import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { waitForAssertion } from "./async-assertion.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const resources = (environment: DevEnvironment) => path.join(environment.home, "JointBob/.agent-resources");
const skillFile = (environment: DevEnvironment) => path.join(resources(environment), "shared/skills/alpha/SKILL.md");
const alpha = (version: string) => `---\nname: alpha\ndescription: Synthetic skill\n---\nAlpha ${version}\n`;

async function write(root: string, relative: string, contents: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), contents);
}

async function join(a: SeededNode, sa: SignedIn, b: SeededNode, sb: SignedIn) {
  const created = await api<{ snapshot: { body: { clusterId: string } } }>(a, sa, "POST", "/clusters", { name: "Home" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.snapshot.body.clusterId;
  const invitation = await api<{ link: string }>(a, sa, "POST", `/clusters/${id}/invitations`, { expectedEpoch: 1 });
  const result = await api(b, sb, "POST", "/clusters/join", { link: invitation.body.link, requestId: randomUUID() });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return id;
}

interface SourceBody { id: string; commit: string; ownerNodeId: string | null; ownerName: string | null; recipients: string[]; items: Array<{ key: string; status: string }> }

test("a git repository's picked skills, plugins and MCP servers install, update, and follow the owner to its recipients", { timeout: 240_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-resources-api-"));
  const children: Awaited<ReturnType<typeof startDevNode>>[] = [];
  try {
    const repository = path.join(root, "repo");
    await mkdir(repository, { recursive: true });
    git(repository, "init", "--quiet", "--initial-branch=main");
    await write(repository, "skills/alpha/SKILL.md", alpha("v1"));
    await write(repository, "skills/gamma/SKILL.md", "---\nname: gamma\ndescription: Dismissible skill\n---\n");
    await write(repository, "skills/unpicked/SKILL.md", "---\nname: unpicked\ndescription: Not chosen\n---\n");
    await write(repository, "plugins/kit/.claude-plugin/plugin.json", JSON.stringify({ name: "kit" }));
    await write(repository, "plugins/kit/commands/go.md", "Go\n");
    await write(repository, ".mcp.json", JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://docs.example.invalid/mcp" } } }));
    git(repository, "add", "-A");
    git(repository, "commit", "--quiet", "-m", "v1");
    const url = `file://${repository}`;

    const environments = await Promise.all(["a", "b"].map((key) => seedDevEnvironment(path.join(root, key), 1)));
    const [ea, eb] = environments;
    const [a, b] = environments.map((environment) => environment.nodes[0]);
    for (const environment of environments) children.push(await startDevNode(environment, environment.nodes[0]));
    const [sa, sb] = await Promise.all(environments.map((environment) => signIn(environment, environment.nodes[0])));
    await join(a, sa, b, sb);

    assert.equal((await api(a, sa, "POST", "/resources/git", { url: "https://user:secret@example.invalid/repo.git" })).status, 400);
    const added = await api<{ source: SourceBody }>(a, sa, "POST", "/resources/git", { url, ref: "main" });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    const id = added.body.source.id;
    assert.deepEqual(added.body.source.items.map((item) => item.key).sort(), ["mcp:.mcp.json#docs", "plugin:plugins/kit", "skill:skills/alpha", "skill:skills/gamma", "skill:skills/unpicked"]);

    const keys = ["skill:skills/alpha", "skill:skills/gamma", "plugin:plugins/kit", "mcp:.mcp.json#docs"];
    const applied = await api<{ result: { installed: string[]; errors: string[] }; source: SourceBody }>(a, sa, "PUT", `/resources/git/${id}/selection`, { keys });
    assert.equal(applied.status, 200, JSON.stringify(applied.body));
    assert.deepEqual(applied.body.result.errors, []);
    assert.equal(await readFile(skillFile(ea), "utf8"), alpha("v1"));
    assert.ok((await lstat(path.join(resources(ea), "claude/plugins/kit/commands/go.md"))).isFile());
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(resources(ea), "mcp/config.json"), "utf8")).mcpServers), ["docs"]);
    const inventory = await api<{ nodes: Array<{ inventory: { skills: Array<{ name: string }>; mcpServers: Array<{ name: string }> } }> }>(a, sa, "GET", "/resources/inventory");
    assert.ok(inventory.body.nodes[0].inventory.skills.some((skill) => skill.name === "alpha"), "agents here see the imported skill");
    assert.ok(inventory.body.nodes[0].inventory.mcpServers.some((server) => server.name === "docs"), "agents here see the imported MCP server");

    // Share the repository with B: B clones the same commit and installs the same items.
    assert.equal((await api(a, sa, "PUT", `/resources/git/${id}/options`, { recipients: [a.nodeId] })).status, 400);
    const shared = await api<{ source: SourceBody }>(a, sa, "PUT", `/resources/git/${id}/options`, { recipients: [b.nodeId] });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));
    await waitForAssertion(async () => assert.equal(await readFile(skillFile(eb), "utf8"), alpha("v1")), 30_000);
    await waitForAssertion(async () => assert.ok((await lstat(path.join(resources(eb), "claude/plugins/kit/commands/go.md"))).isFile()), 10_000);
    await waitForAssertion(async () => assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(resources(eb), "mcp/config.json"), "utf8")).mcpServers), ["docs"]), 10_000);
    await assert.rejects(lstat(path.join(resources(eb), "shared/skills/unpicked")), { code: "ENOENT" });
    const received = await api<{ sources: SourceBody[] }>(b, sb, "GET", "/resources/git");
    assert.equal(received.body.sources.length, 1);
    assert.equal(received.body.sources[0].ownerNodeId, a.nodeId);
    assert.ok(received.body.sources[0].ownerName, "the owner is named");
    assert.equal(received.body.sources[0].commit, applied.body.source.commit);
    // A received skill belongs to its owner, so it is never reshared from B.
    const sharingB = await api<{ skills: Array<{ name: string; kind: string; receivedFrom: string | null }> }>(b, sb, "GET", "/resources/skills/sharing");
    assert.deepEqual(sharingB.body.skills.filter((skill) => skill.name === "alpha").map((skill) => [skill.kind, skill.receivedFrom]), [["received", a.nodeId]]);
    assert.equal((await api(b, sb, "PUT", `/resources/git/${id}/selection`, { keys: [] })).status, 404, "a recipient cannot change the owner's selection");

    // B may dismiss its copy; later pushes from A do not bring it back.
    const gammaFile = path.join(resources(eb), "shared/skills/gamma/SKILL.md");
    await lstat(gammaFile);
    assert.equal((await api(b, sb, "DELETE", "/resources/skills/gamma")).status, 200);
    await assert.rejects(lstat(gammaFile), { code: "ENOENT" });
    assert.equal((await api(a, sa, "PUT", `/resources/git/${id}/options`, { recipients: [b.nodeId] })).status, 200);
    await waitForAssertion(async () => {
      const view = await api<{ sources: Array<SourceBody & { items: Array<{ key: string; status: string }> }> }>(b, sb, "GET", "/resources/git");
      assert.equal(view.body.sources[0]?.items.find((item) => item.key === "skill:skills/gamma")?.status, "available");
    }, 10_000);
    await assert.rejects(lstat(gammaFile), { code: "ENOENT" });

    // A new commit upstream: A checks, updates, and B follows without being asked.
    await write(repository, "skills/alpha/SKILL.md", alpha("v2"));
    git(repository, "commit", "--quiet", "-am", "v2");
    const checked = await api<{ source: SourceBody & { updateAvailable: boolean } }>(a, sa, "POST", `/resources/git/${id}/check`, {});
    assert.equal(checked.body.source.updateAvailable, true);
    const updated = await api<{ result: { installed: string[]; commit: string } }>(a, sa, "POST", `/resources/git/${id}/update`, {});
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.deepEqual(updated.body.result.installed, ["alpha"]);
    assert.equal(await readFile(skillFile(ea), "utf8"), alpha("v2"));
    await waitForAssertion(async () => assert.equal(await readFile(skillFile(eb), "utf8"), alpha("v2")), 30_000);
    await assert.rejects(lstat(gammaFile), { code: "ENOENT" }, "the dismissed skill stays dismissed after an update");

    // Only cluster peers may push offers, and they must be well formed.
    assert.equal((await signedNodeRequest(eb, b, a, "POST", "/api/cluster/v2/git-resources/offers", { offers: [{ id, url, ref: "main", commit: "nope", keys: [] }] })).status, 400);
    const pulled = await signedNodeRequest(eb, b, a, "POST", "/api/cluster/v2/git-resources/pull", {});
    assert.equal(pulled.status, 200);
    assert.deepEqual(((await pulled.json()) as { offers: Array<{ keys: string[] }> }).offers.map((offer) => offer.keys), [[...keys].sort()]);

    // Stop sharing: B removes what it installed from the repository.
    assert.equal((await api(a, sa, "PUT", `/resources/git/${id}/options`, { recipients: [] })).status, 200);
    await waitForAssertion(async () => assert.rejects(lstat(skillFile(eb)), { code: "ENOENT" }), 30_000);
    await waitForAssertion(async () => assert.deepEqual(JSON.parse(await readFile(path.join(resources(eb), "mcp/config.json"), "utf8")).mcpServers, {}), 10_000);
    await waitForAssertion(async () => assert.deepEqual((await api<{ sources: SourceBody[] }>(b, sb, "GET", "/resources/git")).body.sources, []), 10_000);

    // A skill shared the ordinary way reaches its receiver again as soon as the repository changes it.
    const skillShare = await api(a, sa, "PUT", "/resources/skills/alpha/sharing", { clusterIds: [], nodeIds: [b.nodeId] });
    assert.equal(skillShare.status, 200, JSON.stringify(skillShare.body));
    assert.equal((await api(b, sb, "POST", "/resources/skills/refresh", {})).status, 200);
    assert.equal(await readFile(skillFile(eb), "utf8"), alpha("v2"));
    await write(repository, "skills/alpha/SKILL.md", alpha("v3"));
    git(repository, "commit", "--quiet", "-am", "v3");
    assert.equal((await api(a, sa, "POST", `/resources/git/${id}/update`, {})).status, 200);
    await waitForAssertion(async () => assert.equal(await readFile(skillFile(eb), "utf8"), alpha("v3")), 30_000);
    assert.equal((await signedNodeRequest(eb, b, a, "POST", "/api/cluster/v2/skills/changed", {})).status, 200);

    const removed = await api<{ result: { removed: string[] } }>(a, sa, "DELETE", `/resources/git/${id}`);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.deepEqual(removed.body.result.removed.sort(), ["alpha", "docs", "gamma", "kit"]);
    await assert.rejects(lstat(skillFile(ea)), { code: "ENOENT" });
  } finally {
    await Promise.all(children.map((child) => stopDevNode(child)));
    await rm(root, { recursive: true, force: true });
  }
});
