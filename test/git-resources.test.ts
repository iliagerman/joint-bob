import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentResourcePaths } from "../src/agent-resources.js";
import { addGitSource, applyGitOffers, applyGitSelection, checkGitSource, discoverGitItems, gitOffersFor, gitSourceView, listGitSources, normalizeGitUrl, removeGitSource, setGitSourceOptions, updateGitSource } from "../src/git-resources.js";
import { activationDecision, markReceivedResource, receivedResource } from "../src/resource-activation.js";
import { save, settingsDatabase } from "../src/settings-store.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

async function write(root: string, relative: string, contents: string): Promise<void> {
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), contents);
}

/** A repository with two skills, a plugin holding a skill and an MCP server of its own, a marketplace plugin, and root MCP servers. */
async function fixtureRepository(directory: string): Promise<string> {
  await mkdir(directory, { recursive: true });
  git(directory, "init", "--quiet", "--initial-branch=main");
  await write(directory, "skills/alpha/SKILL.md", "---\nname: alpha\ndescription: First skill\n---\nAlpha v1\n");
  await write(directory, "skills/alpha/scripts/run.sh", "#!/bin/sh\necho alpha\n");
  await write(directory, "skills/alpha/.env", "SECRET=1\n");
  await write(directory, ".claude/skills/beta/SKILL.md", "---\nname: beta\ndescription: Second skill\n---\nBeta\n");
  await write(directory, "skills/broken/SKILL.md", "---\nname: broken\n---\nNo description\n");
  await write(directory, "plugins/review/.claude-plugin/plugin.json", JSON.stringify({ name: "review-kit", description: "Review commands" }));
  await write(directory, "plugins/review/commands/review.md", "Review it\n");
  await write(directory, "plugins/review/skills/inner/SKILL.md", "---\nname: inner\ndescription: Plugin skill\n---\nInner\n");
  await write(directory, "plugins/review/.mcp.json", JSON.stringify({ mcpServers: { "plugin-only": { command: "plugin-server" } } }));
  await write(directory, "marketplace/formatter/commands/format.md", "Format it\n");
  await write(directory, ".claude-plugin/marketplace.json", JSON.stringify({ name: "market", plugins: [{ name: "formatter", source: "./marketplace/formatter", description: "Formats" }, { name: "everything", source: "./" }] }));
  await write(directory, ".mcp.json", JSON.stringify({ mcpServers: { github: { type: "http", url: "https://api.example.invalid/mcp" }, local: { command: "./bin/server", args: ["--stdio"] } } }));
  git(directory, "add", "-A");
  git(directory, "commit", "--quiet", "-m", "initial");
  return git(directory, "rev-parse", "HEAD");
}

test("retained edited Git plugins and MCP servers stay received and disabled after unsharing", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "git-retained-activation-"));
  const options = { dataDir: path.join(fixture, "data"), root: path.join(fixture, "resources") };
  const paths = agentResourcePaths(options.root);
  save(settingsDatabase(), "autoActivateSharedSkills", "false");
  try {
    const repository = path.join(fixture, "repo");
    const commit = await fixtureRepository(repository);
    const owner = "fixture-owner";
    const applied = await applyGitOffers(owner, [{ id: "fixture-source", url: `file://${repository}`, ref: "main", commit,
      keys: ["plugin:plugins/review", "mcp:.mcp.json#github"] }], options);
    assert.deepEqual(applied.errors, []);
    await writeFile(path.join(paths.claudePlugins, "review-kit/commands/review.md"), "Local edit\n");
    await writeFile(paths.mcpConfig, JSON.stringify({ mcpServers: { github: { url: "https://edited.invalid/mcp" } } }));
    // Also cover an older installation whose provenance exists only in the source inventory.
    markReceivedResource("plugin", "review-kit", false);
    markReceivedResource("mcp", "github", false);
    assert.deepEqual((await applyGitOffers(owner, [], options)).errors, []);
    for (const [kind, name] of [["plugin", "review-kit"], ["mcp", "github"]] as const) {
      assert.equal(receivedResource(kind, name), true, "retained resource keeps received provenance after its source is removed");
      assert.equal(activationDecision(kind, name, "claude", receivedResource(kind, name)).enabled, false);
    }
    assert.equal(await readFile(path.join(paths.claudePlugins, "review-kit/commands/review.md"), "utf8"), "Local edit\n");
  } finally {
    markReceivedResource("plugin", "review-kit", false);
    markReceivedResource("mcp", "github", false);
    save(settingsDatabase(), "autoActivateSharedSkills", "true");
    await rm(fixture, { recursive: true, force: true });
  }
});

test("failed Git plugin removal keeps received provenance after the source is dropped", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "git-failed-removal-"));
  const options = { dataDir: path.join(fixture, "data"), root: path.join(fixture, "resources") };
  save(settingsDatabase(), "autoActivateSharedSkills", "false");
  try {
    const repository = path.join(fixture, "repo");
    const commit = await fixtureRepository(repository);
    assert.deepEqual((await applyGitOffers("fixture-owner", [{ id: "fixture-source", url: `file://${repository}`, ref: "main", commit, keys: ["plugin:plugins/review"] }], options)).errors, []);
    markReceivedResource("plugin", "review-kit", false); // Legacy source-only provenance.
    await writeFile(path.join(options.dataDir, "removed-plugins"), "blocks backup directory creation");
    const result = await applyGitOffers("fixture-owner", [], options);
    assert.equal(result.errors.length, 1);
    assert.equal((await lstat(path.join(agentResourcePaths(options.root).claudePlugins, "review-kit"))).isDirectory(), true);
    assert.equal(receivedResource("plugin", "review-kit"), true);
    assert.equal(activationDecision("plugin", "review-kit", "claude", true).enabled, false);
  } finally {
    markReceivedResource("plugin", "review-kit", false);
    save(settingsDatabase(), "autoActivateSharedSkills", "true");
    await rm(fixture, { recursive: true, force: true });
  }
});

test("git URLs accept GitHub shorthand and refuse embedded credentials", () => {
  assert.equal(normalizeGitUrl("anthropics/skills"), "https://github.com/anthropics/skills.git");
  assert.equal(normalizeGitUrl("git@github.com:owner/repo.git"), "git@github.com:owner/repo.git");
  assert.throws(() => normalizeGitUrl("https://user:token@github.com/owner/repo.git"), /credentials/);
  assert.throws(() => normalizeGitUrl("--upload-pack=touch /tmp/x"), /git repository URL/);
  assert.throws(() => normalizeGitUrl("ext::sh -c touch% /tmp/x"), /git repository URL|https, ssh or file/);
});

test("GitLab credential references stay out of resource views and sharing offers", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "git-resource-credential-"));
  const dataDir = path.join(fixture, "data");
  const id = "9a560e1a-2456-4a64-80ac-e122d0fe2e10";
  try {
    const directory = path.join(dataDir, "git-resources");
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "sources.json"), JSON.stringify({ version: 1, sources: [{
      id, url: "https://gitlab.example.test/group/repo.git", ref: null, gitlabAccountId: "local-secret-account-id", commit: "a".repeat(40),
      ownerNodeId: null, autoUpdate: false, recipients: ["peer"], deliveries: {}, latestCommit: null, checkedAt: null,
      checkError: null, installed: [], lastError: null, addedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }] }));

    const [source] = await listGitSources({ dataDir });
    assert.equal(source.usesGitLabCredential, true);
    assert.equal("gitlabAccountId" in source, false);
    assert.deepEqual(await gitOffersFor("peer", { dataDir }), [{
      id, url: "https://gitlab.example.test/group/repo.git", ref: null, commit: "a".repeat(40), keys: [],
    }]);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("discovers skills, plugins and MCP servers; a plugin's own MCP servers travel with it", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "git-resources-discover-"));
  try {
    const repository = path.join(fixture, "repo");
    await fixtureRepository(repository);
    const items = await discoverGitItems(repository);
    const byKey = new Map(items.map((item) => [item.key, item]));
    assert.deepEqual(items.map((item) => item.key).sort(), [
      "mcp:.mcp.json#github", "mcp:.mcp.json#local",
      "plugin:marketplace/formatter", "plugin:plugins/review",
      "skill:.claude/skills/beta", "skill:plugins/review/skills/inner", "skill:skills/alpha", "skill:skills/broken",
    ]);
    assert.equal(byKey.get("plugin:plugins/review")?.name, "review-kit");
    assert.equal(byKey.get("skill:plugins/review/skills/inner")?.plugin, "review-kit");
    assert.match(byKey.get("skill:skills/broken")?.error ?? "", /no description/);
    assert.equal(byKey.get("mcp:.mcp.json#github")?.description, "http · https://api.example.invalid");
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("imports part of a repository, follows its updates, keeps local edits, and uninstalls cleanly", { timeout: 60_000 }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "git-resources-flow-"));
  const options = { dataDir: path.join(fixture, "data"), root: path.join(fixture, "resources") };
  const paths = agentResourcePaths(options.root);
  try {
    const repository = path.join(fixture, "repo");
    const first = await fixtureRepository(repository);
    const url = `file://${repository}`;
    const added = await addGitSource({ url, ref: "main" }, options);
    assert.equal(added.commit, first);
    assert.ok(added.items.every((item) => item.status === "available"));
    await assert.rejects(addGitSource({ url, ref: "main" }, options), /already added/);

    const picked = ["skill:skills/alpha", "plugin:plugins/review", "plugin:marketplace/formatter", "mcp:.mcp.json#github", "mcp:.mcp.json#local"];
    const applied = await applyGitSelection(added.id, picked, options);
    assert.deepEqual(applied.errors, []);
    assert.deepEqual(applied.installed.sort(), ["alpha", "formatter", "github", "local", "review-kit"]);
    assert.equal(await readFile(path.join(paths.sharedSkills, "alpha/SKILL.md"), "utf8"), "---\nname: alpha\ndescription: First skill\n---\nAlpha v1\n");
    await assert.rejects(lstat(path.join(paths.sharedSkills, "alpha/.env")), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(paths.sharedSkills, "beta")), { code: "ENOENT" });
    assert.equal(JSON.parse(await readFile(path.join(paths.claudePlugins, "review-kit/.claude-plugin/plugin.json"), "utf8")).name, "review-kit");
    // A marketplace entry without its own manifest gets one, so Claude can load it as a plugin folder.
    assert.equal(JSON.parse(await readFile(path.join(paths.claudePlugins, "formatter/.claude-plugin/plugin.json"), "utf8")).name, "formatter");
    const mcp = JSON.parse(await readFile(paths.mcpConfig, "utf8"));
    assert.deepEqual(mcp.mcpServers.github, { type: "http", url: "https://api.example.invalid/mcp" });
    assert.ok(path.isAbsolute(mcp.mcpServers.local.command), "a command relative to the MCP file runs from the clone");

    // Re-applying the same selection changes nothing.
    const again = await applyGitSelection(added.id, picked, options);
    assert.deepEqual(again.installed, []);
    assert.equal(again.unchanged.length, 5);

    await write(repository, "skills/alpha/SKILL.md", "---\nname: alpha\ndescription: First skill\n---\nAlpha v2\n");
    await write(repository, "plugins/review/commands/review.md", "Review it twice\n");
    git(repository, "commit", "--quiet", "-am", "second");
    const second = git(repository, "rev-parse", "HEAD");
    const checked = await checkGitSource(added.id, options);
    assert.equal(checked.latestCommit, second);
    assert.equal(checked.updateAvailable, true);
    assert.equal(await readFile(path.join(paths.sharedSkills, "alpha/SKILL.md"), "utf8"), "---\nname: alpha\ndescription: First skill\n---\nAlpha v1\n", "a check installs nothing");

    // Edit the installed plugin here: a plain re-apply keeps the edit.
    await writeFile(path.join(paths.claudePlugins, "formatter/commands/format.md"), "Local edit\n");
    const kept = await applyGitSelection(added.id, picked, options);
    assert.ok(kept.kept.some((entry) => entry.startsWith("formatter")));
    assert.equal((await gitSourceView(added.id, null, options)).items.find((item) => item.name === "formatter")?.status, "edited");

    const updated = await updateGitSource(added.id, options);
    assert.equal(updated.commit, second);
    assert.equal(updated.previousCommit, first);
    assert.deepEqual(updated.installed.sort(), ["alpha", "review-kit"]);
    assert.equal(updated.skillsChanged, true);
    assert.equal(await readFile(path.join(paths.sharedSkills, "alpha/SKILL.md"), "utf8"), "---\nname: alpha\ndescription: First skill\n---\nAlpha v2\n");
    assert.equal(await readFile(path.join(paths.claudePlugins, "review-kit/commands/review.md"), "utf8"), "Review it twice\n");
    assert.equal(await readFile(path.join(paths.claudePlugins, "formatter/commands/format.md"), "utf8"), "Local edit\n", "unchanged upstream, so the local edit stays");
    assert.equal((await listGitSources(options))[0].updateAvailable, false);

    // Deselecting removes only what came from the repository.
    const narrowed = await applyGitSelection(added.id, ["skill:skills/alpha", "plugin:marketplace/formatter"], options);
    assert.deepEqual(narrowed.removed.sort(), ["github", "local", "review-kit"]);
    assert.deepEqual(JSON.parse(await readFile(paths.mcpConfig, "utf8")).mcpServers, {});
    await assert.rejects(lstat(path.join(paths.claudePlugins, "review-kit")), { code: "ENOENT" });

    const shared = await setGitSourceOptions(added.id, { recipients: ["node-b"], autoUpdate: true }, options);
    assert.equal(shared.source.autoUpdate, true);
    assert.deepEqual(await gitOffersFor("node-b", options), [{ id: added.id, url, ref: "main", commit: second, keys: ["plugin:marketplace/formatter", "skill:skills/alpha"] }]);
    assert.deepEqual(await gitOffersFor("node-c", options), []);

    await writeFile(path.join(paths.sharedSkills, "alpha/SKILL.md"), "---\nname: alpha\ndescription: Local edit\n---\n");
    const removed = await removeGitSource(added.id, null, options);
    assert.equal(removed.complete, true);
    assert.deepEqual(removed.removed.sort(), ["alpha", "formatter"]);
    assert.deepEqual(removed.kept, [], "explicit repository removal cleans up edited copies too");
    await assert.rejects(lstat(path.join(paths.claudePlugins, "formatter")), { code: "ENOENT" });
    assert.ok(removed.backups.some((entry) => entry.includes("formatter")), "edited plugin remains recoverable in a backup");
    assert.ok(removed.backups.some((entry) => entry.includes("alpha")), "edited skill remains recoverable in a backup");
    assert.deepEqual(removed.recipients, ["node-b"]);
    await assert.rejects(lstat(path.join(paths.sharedSkills, "alpha")), { code: "ENOENT" });
    assert.deepEqual(await listGitSources(options), []);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("failed repository removal keeps the source and retries the remaining assets", { timeout: 60_000 }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "git-remove-retry-"));
  const options = { dataDir: path.join(fixture, "data"), root: path.join(fixture, "resources") };
  const paths = agentResourcePaths(options.root);
  try {
    const repository = path.join(fixture, "repo");
    await fixtureRepository(repository);
    const source = await addGitSource({ url: `file://${repository}`, ref: "main" }, options);
    assert.deepEqual((await applyGitSelection(source.id, ["skill:skills/alpha", "plugin:plugins/review", "mcp:.mcp.json#github"], options)).errors, []);
    await writeFile(path.join(paths.claudePlugins, "review-kit/commands/review.md"), "Local edit\n");
    await writeFile(paths.mcpConfig, JSON.stringify({ mcpServers: { github: { url: "https://edited.invalid/mcp" }, unrelated: { command: "unrelated" } } }));
    const blocked = path.join(options.dataDir, "removed-plugins");
    await mkdir(path.dirname(blocked), { recursive: true });
    await writeFile(blocked, "blocks plugin backup");
    const partial = await removeGitSource(source.id, null, options);
    assert.equal(partial.complete, false);
    assert.equal(partial.errors.length, 1);
    assert.deepEqual(partial.removed.sort(), ["alpha", "github"]);
    assert.deepEqual((await listGitSources(options))[0].installed.map((item) => item.name), ["review-kit"]);
    await assert.rejects(lstat(path.join(paths.sharedSkills, "alpha")), { code: "ENOENT" });
    assert.deepEqual(Object.keys(JSON.parse(await readFile(paths.mcpConfig, "utf8")).mcpServers), ["unrelated"]);
    assert.ok(partial.backups.some((entry) => entry.endsWith("server.json")));
    await rm(blocked);
    const finished = await removeGitSource(source.id, null, options);
    assert.equal(finished.complete, true);
    assert.deepEqual(finished.removed, ["review-kit"]);
    assert.deepEqual(await listGitSources(options), []);
    await assert.rejects(lstat(path.join(paths.claudePlugins, "review-kit")), { code: "ENOENT" });
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("a recipient runs the owner's commit and selection, and drops what the owner stops sharing", { timeout: 60_000 }, async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "git-resources-offers-"));
  const options = { dataDir: path.join(fixture, "data"), root: path.join(fixture, "resources") };
  const paths = agentResourcePaths(options.root);
  const owner = "0b7a8f5e-2b8f-4f53-9d5e-0a8b8b9c1d01";
  try {
    const repository = path.join(fixture, "repo");
    const first = await fixtureRepository(repository);
    await write(repository, "skills/alpha/SKILL.md", "---\nname: alpha\ndescription: First skill\n---\nAlpha v2\n");
    git(repository, "commit", "--quiet", "-am", "second");
    const url = `file://${repository}`;
    // The owner still runs the first commit; the recipient must run it too, not the branch tip.
    const offer = { id: "6f1d1a52-8c7e-4c1e-9b45-3f2d3c4b5a60", url, ref: "main", commit: first, keys: ["skill:skills/alpha", "mcp:.mcp.json#github"] };
    const applied = await applyGitOffers(owner, [offer], options);
    assert.deepEqual(applied.errors, []);
    assert.equal(applied.skillsChanged, true);
    assert.equal(await readFile(path.join(paths.sharedSkills, "alpha/SKILL.md"), "utf8"), "---\nname: alpha\ndescription: First skill\n---\nAlpha v1\n");
    const view = await gitSourceView(offer.id, owner, options);
    assert.equal(view.ownerNodeId, owner);
    assert.equal(view.commit, first);

    const second = git(repository, "rev-parse", "HEAD");
    await applyGitOffers(owner, [{ ...offer, commit: second }], options);
    assert.equal(await readFile(path.join(paths.sharedSkills, "alpha/SKILL.md"), "utf8"), "---\nname: alpha\ndescription: First skill\n---\nAlpha v2\n");

    await applyGitOffers(owner, [], options);
    await assert.rejects(lstat(path.join(paths.sharedSkills, "alpha")), { code: "ENOENT" });
    assert.deepEqual(JSON.parse(await readFile(paths.mcpConfig, "utf8")).mcpServers, {});
    assert.deepEqual(await listGitSources(options), []);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
