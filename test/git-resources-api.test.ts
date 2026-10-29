import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { waitForAssertion } from "./async-assertion.js";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type DevEnvironment, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { signedNodeRequest } from "./signed-node-request.js";
import type { ResourceInventory } from "../src/resource-inventory.js";

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
    await write(repository, "plugins/kit/.mcp.json", JSON.stringify({ mcpServers: { "kit-docs": { command: "plugin-fixture" } } }));
    await write(repository, ".mcp.json", JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://docs.example.invalid/mcp" } } }));
    git(repository, "add", "-A");
    git(repository, "commit", "--quiet", "-m", "v1");
    const url = `file://${repository}`;

    const environments = await Promise.all(["a", "b"].map((key) => seedDevEnvironment(path.join(root, key), 1)));
    const [ea, eb] = environments;
    const [a, b] = environments.map((environment) => environment.nodes[0]);
    for (const environment of environments) children.push(await startDevNode(environment, environment.nodes[0]));
    let [sa, sb] = await Promise.all(environments.map((environment) => signIn(environment, environment.nodes[0])));
    await join(a, sa, b, sb);
    assert.equal((await api(b, sb, "PUT", "/resources/activation", { autoActivateSharedSkills: false })).status, 200);
    const receiverInventory = async () => (await api<{ nodes: Array<{ inventory: ResourceInventory }> }>(b, sb, "GET", "/resources/inventory")).body.nodes[0].inventory;
    const choose = async (kind: string, name: string, harness: string, enabled: boolean) => {
      assert.equal((await api(b, sb, "PUT", "/resources/activation/item", { kind, name, harness, enabled })).status, 200);
    };
    const assertChoices = async () => {
      const inventory = await receiverInventory();
      const skill = inventory.skills.find((item) => item.name === "alpha")!;
      assert.deepEqual([skill.activation?.pi?.enabled, skill.activation?.claude?.enabled, skill.activation?.kiro?.enabled], [true, false, true]);
      assert.equal(inventory.plugins.find((item) => item.name === "kit")?.activation.claude?.enabled, false);
      const mcp = inventory.mcpServers.find((item) => item.name === "docs")!;
      assert.deepEqual([mcp.activation?.claude?.enabled, mcp.activation?.kiro?.enabled], [false, true]);
    };

    assert.equal((await api(a, sa, "POST", "/resources/git", { url: "https://user:secret@example.invalid/repo.git" })).status, 400);
    const credential = await api<{ account: { id: string } }>(a, sa, "POST", "/secrets/accounts", { label: "GitLab fixture", provider: "gitlab", variables: [
      { name: "GITLAB_URL", kind: "value", value: "https://gitlab.example.test" },
      { name: "GITLAB_TOKEN", kind: "value", value: "synthetic-gitlab-token" },
    ] });
    assert.equal(credential.status, 201, JSON.stringify(credential.body));
    const availableCredentials = await api<{ accounts: Array<{ id: string; label: string }> }>(a, sa, "GET", "/resources/git/credentials");
    assert.deepEqual(availableCredentials.body.accounts, [{ id: credential.body.account.id, label: "GitLab fixture" }]);
    const mismatchedCredential = await api(a, sa, "POST", "/resources/git", { url, ref: "main", gitlabAccountId: credential.body.account.id });
    assert.equal(mismatchedCredential.status, 400);
    assert.match(JSON.stringify(mismatchedCredential.body), /GitLab credential host does not match/);
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
    const received = await waitForAssertion(async () => {
      const response = await api<{ sources: SourceBody[] }>(b, sb, "GET", "/resources/git");
      assert.equal(response.body.sources.length, 1, "delivery must finish publishing its source and activation provenance");
      return response;
    }, 10_000);
    assert.equal(received.body.sources[0].ownerNodeId, a.nodeId);
    assert.ok(received.body.sources[0].ownerName, "the owner is named");
    assert.equal(received.body.sources[0].commit, applied.body.source.commit);
    // A received skill belongs to its owner, so it is never reshared from B.
    const sharingB = await api<{ skills: Array<{ name: string; kind: string; receivedFrom: string | null }> }>(b, sb, "GET", "/resources/skills/sharing");
    assert.deepEqual(sharingB.body.skills.filter((skill) => skill.name === "alpha").map((skill) => [skill.kind, skill.receivedFrom]), [["received", a.nodeId]]);
    assert.equal((await api(b, sb, "PUT", `/resources/git/${id}/selection`, { keys: [] })).status, 404, "a recipient cannot change the owner's selection");

    // A granted plugin carries its MCP inventory, but not the owner's private aliases or other plugins.
    const ownerPlugins = path.join(resources(ea), "claude/plugins");
    const privateAlias = path.join(ownerPlugins, "private-alias-fixture");
    await symlink(path.join(ownerPlugins, "kit"), privateAlias, "dir");
    await write(ownerPlugins, "private-kit/.claude-plugin/plugin.json", '{"name":"private-kit"}');
    await write(ownerPlugins, "private-kit/.mcp.json", '{"mcpServers":{"private-server":{"command":"private-fixture"}}}');
    assert.equal((await api(a, sa, "PUT", "/resources/activation/item", { kind: "plugin", name: "private-alias-fixture", harness: "claude", enabled: false })).status, 200);
    const peerInventory = await signedNodeRequest(eb, b, a, "POST", "/api/cluster/v2/runtime/resources/inventory", {});
    assert.equal(peerInventory.status, 200);
    const peerBody = await peerInventory.json() as ResourceInventory;
    assert.ok(peerBody.plugins.some((plugin) => plugin.name === "kit"));
    assert.ok(peerBody.mcpServers.some((server) => server.name === "plugin:kit:kit-docs"));
    assert.doesNotMatch(JSON.stringify(peerBody), /private-alias-fixture|private-kit|private-server|private-fixture/);
    await rm(privateAlias);
    await rm(path.join(ownerPlugins, "private-kit"), { recursive: true });

    // Receiving real Git resources honors default-off for every supported harness.
    const off = await receiverInventory();
    for (const item of [...off.skills.filter((item) => ["alpha", "gamma"].includes(item.name)), ...off.plugins.filter((item) => item.name === "kit"), ...off.mcpServers.filter((item) => item.name === "docs")]) {
      assert.ok(Object.values(item.activation ?? {}).length);
      for (const decision of Object.values(item.activation ?? {})) assert.equal(decision?.enabled, false);
    }
    assert.equal((await api(b, sb, "PUT", "/resources/activation", { autoActivateSharedSkills: true })).status, 200);
    const on = await receiverInventory();
    for (const item of [...on.skills.filter((item) => item.name === "alpha"), ...on.plugins.filter((item) => item.name === "kit"), ...on.mcpServers.filter((item) => item.name === "docs")]) {
      for (const decision of Object.values(item.activation ?? {})) assert.equal(decision?.enabled, true);
    }
    await choose("skill", "alpha", "pi", true);
    await choose("skill", "alpha", "claude", false);
    await choose("plugin", "kit", "claude", false);
    await choose("mcp", "docs", "claude", false);
    await choose("mcp", "docs", "kiro", true);
    await assertChoices();

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
    await stopDevNode(children[1]); // Receiver misses the update and must catch up on reconnect.
    await write(repository, "skills/alpha/SKILL.md", alpha("v2"));
    await write(repository, "plugins/kit/commands/go.md", "Go v2\n");
    await write(repository, ".mcp.json", JSON.stringify({ mcpServers: { docs: { type: "http", url: "https://docs.example.invalid/v2/mcp" } } }));
    git(repository, "commit", "--quiet", "-am", "v2");
    const checked = await api<{ source: SourceBody & { updateAvailable: boolean } }>(a, sa, "POST", `/resources/git/${id}/check`, {});
    assert.equal(checked.body.source.updateAvailable, true);
    const updated = await api<{ result: { installed: string[]; commit: string } }>(a, sa, "POST", `/resources/git/${id}/update`, {});
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.deepEqual(updated.body.result.installed.sort(), ["alpha", "docs", "kit"]);
    assert.equal(await readFile(skillFile(ea), "utf8"), alpha("v2"));
    children[1] = await startDevNode(eb, b);
    sb = await signIn(eb, b);
    await waitForAssertion(async () => assert.equal(await readFile(skillFile(eb), "utf8"), alpha("v2")), 30_000);
    await assert.rejects(lstat(gammaFile), { code: "ENOENT" }, "the dismissed skill stays dismissed after an update");
    await waitForAssertion(async () => assert.equal(await readFile(path.join(resources(eb), "claude/plugins/kit/commands/go.md"), "utf8"), "Go v2\n"));
    assert.equal(JSON.parse(await readFile(path.join(resources(eb), "mcp/config.json"), "utf8")).mcpServers.docs.url, "https://docs.example.invalid/v2/mcp");
    await assertChoices();
    // Default changes after reconnect never erase explicit choices.
    assert.equal((await api(b, sb, "PUT", "/resources/activation", { autoActivateSharedSkills: false })).status, 200);
    const afterDefaultChange = await receiverInventory();
    assert.equal(afterDefaultChange.skills.find((item) => item.name === "alpha")?.activation?.pi?.enabled, true);
    assert.equal(afterDefaultChange.mcpServers.find((item) => item.name === "docs")?.activation?.kiro?.enabled, true);
    assert.equal((await api(b, sb, "PUT", "/resources/activation", { autoActivateSharedSkills: true })).status, 200);
    await assertChoices();

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
