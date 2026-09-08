import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function skill(root: string, name: string, description: string): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);
  return directory;
}

test("publishes complete validated local skill directories with replacement backups", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "skill-publish-"));
  const source = path.join(fixture, "source");
  const managed = path.join(fixture, "managed");
  const dataDir = path.join(fixture, "data");
  try {
    const alpha = await skill(source, "alpha", "first");
    await skill(source, "beta", "second");
    await writeFile(path.join(alpha, "run.sh"), "#!/bin/sh\n");
    await chmod(path.join(alpha, "run.sh"), 0o755);
    await writeFile(path.join(alpha, ".env"), "SECRET=x\n");
    await mkdir(path.join(alpha, "node_modules"));
    await writeFile(path.join(alpha, "node_modules/x"), "x");
    const { syncLocalSkills, agentResourcePaths } = await import("../src/agent-resources.js") as typeof import("../src/agent-resources.js") & { syncLocalSkills: (roots: string[], options?: { root?: string; dataDir?: string }) => Promise<{ published: string[]; unchanged: string[]; backupPath: string | null }> };
    const first = await syncLocalSkills([source], { root: managed, dataDir });
    assert.deepEqual(first.published, ["alpha", "beta"]);
    const shared = agentResourcePaths(managed).sharedSkills;
    assert.equal((await (await import("node:fs/promises")).stat(path.join(shared, "alpha/run.sh"))).mode & 0o111, 0o111);
    await assert.rejects(readFile(path.join(shared, "alpha/.env")));
    await assert.rejects(readFile(path.join(shared, "alpha/node_modules/x")));
    await writeFile(path.join(alpha, "helper.txt"), "old");
    await syncLocalSkills([source], { root: managed, dataDir });
    await writeFile(path.join(alpha, "SKILL.md"), "---\nname: alpha\ndescription: changed\n---\n");
    await rm(path.join(alpha, "helper.txt"));
    const replaced = await syncLocalSkills([source], { root: managed, dataDir });
    assert.ok(replaced.backupPath);
    assert.equal(await readFile(path.join(replaced.backupPath!, "alpha/helper.txt"), "utf8"), "old");
    assert.deepEqual((await syncLocalSkills([source], { root: managed, dataDir })).unchanged, ["alpha", "beta"]);
    assert.match(await readFile(path.join(alpha, "SKILL.md"), "utf8"), /changed/);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("republishes mode-only changes and preserves backup modes", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "skill-publish-mode-"));
  try {
    const source = await skill(path.join(fixture, "source"), "runner", "Runs scripts");
    const script = path.join(source, "run.sh");
    const managed = path.join(fixture, "managed");
    const dataDir = path.join(fixture, "data");
    await writeFile(script, "#!/bin/sh\n");
    await chmod(script, 0o644);
    const { agentResourcePaths, syncLocalSkills } = await import("../src/agent-resources.js");
    await syncLocalSkills([source], { root: managed, dataDir });
    await chmod(script, 0o755);
    const changed = await syncLocalSkills([source], { root: managed, dataDir });
    const publishedScript = path.join(agentResourcePaths(managed).sharedSkills, "runner/run.sh");
    assert.deepEqual(changed.published, ["runner"]);
    assert.equal((await stat(publishedScript)).mode & 0o111, 0o111);
    assert.equal((await stat(path.join(changed.backupPath!, "runner/run.sh"))).mode & 0o111, 0);
    assert.deepEqual((await syncLocalSkills([source], { root: managed, dataDir })).unchanged, ["runner"]);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("uses SDK metadata parsing and rejects unusable descriptions", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "skill-publish-metadata-"));
  try {
    const source = path.join(fixture, "source");
    const manifest = path.join(source, "SKILL.md");
    await mkdir(source, { recursive: true });
    const { agentResourcePaths, syncLocalSkills } = await import("../src/agent-resources.js");
    for (const description of ["\"\"", "null", "[invalid"]) {
      await writeFile(manifest, `---\nname: rejected\ndescription: ${description}\n---\n`);
      await assert.rejects(syncLocalSkills([manifest], { root: path.join(fixture, "managed") }), /Invalid skill metadata/);
    }
    await writeFile(manifest, "---\nname: \"quoted-skill\" # accepted comment\ndescription: Valid description\n---\n");
    const result = await syncLocalSkills([manifest], { root: path.join(fixture, "managed") });
    assert.deepEqual(result.published, ["quoted-skill"]);
    assert.match(await readFile(path.join(agentResourcePaths(path.join(fixture, "managed")).sharedSkills, "quoted-skill/SKILL.md"), "utf8"), /Valid description/);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});

test("resolves root links and rejects unsafe or conflicting inputs before publishing", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "skill-publish-validation-"));
  try {
    const source = path.join(fixture, "source");
    await skill(source, "safe", "safe");
    const link = path.join(fixture, "linked");
    await symlink(source, link, "dir");
    const module = await import("../src/agent-resources.js") as typeof import("../src/agent-resources.js") & { syncLocalSkills: (roots: string[], options?: { root?: string }) => Promise<unknown> };
    await module.syncLocalSkills([link], { root: path.join(fixture, "managed") });
    await assert.rejects(module.syncLocalSkills([], { root: path.join(fixture, "other") }), /between 1 and 20/i);
    await assert.rejects(module.syncLocalSkills(["relative"], { root: path.join(fixture, "other") }), /absolute/i);
    await assert.rejects(module.syncLocalSkills([path.join(fixture, "missing")], { root: path.join(fixture, "other") }), /missing|ENOENT/i);
    const external = path.join(fixture, "secret"); await writeFile(external, "secret");
    await symlink(external, path.join(source, "safe/secret-link"));
    await assert.rejects(module.syncLocalSkills([source], { root: path.join(fixture, "blocked") }), /symbolic link/i);
    await assert.rejects(readFile(path.join(fixture, "blocked/shared/skills/safe/SKILL.md")));
    await rm(path.join(source, "safe/secret-link"));
    const duplicate = path.join(fixture, "duplicate"); await skill(duplicate, "safe", "other");
    await assert.rejects(module.syncLocalSkills([source, duplicate], { root: path.join(fixture, "conflict") }), /conflict|duplicate/i);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
