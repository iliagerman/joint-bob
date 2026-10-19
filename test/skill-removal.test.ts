import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { backupRemovedSkill, unlinkSkillAliases } from "../src/skill-sharing-files.js";
import { activeSkillRoot } from "../src/resource-activation.js";

test("removal cleans chained and renamed aliases after backup, preserving original skills", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-removal-"));
  try {
    const managed = path.join(root, "managed/ask-pi");
    const agents = path.join(root, "agents");
    const claude = path.join(root, "claude");
    const pi = path.join(root, "pi");
    for (const directory of [managed, agents, claude, pi]) await mkdir(directory, { recursive: true });
    await writeFile(path.join(managed, "SKILL.md"), "original skill");
    await symlink("../managed/ask-pi", path.join(agents, "ask-pi"));
    await symlink("../agents/ask-pi", path.join(claude, "ask-pi"));
    await symlink("../claude/ask-pi", path.join(pi, "renamed"));
    await mkdir(path.join(pi, "ask-pi"));
    await writeFile(path.join(pi, "ask-pi/SKILL.md"), "independent original");
    await symlink("../pi/ask-pi", path.join(claude, "unrelated"));
    await symlink("cycle-b", path.join(agents, "cycle-a"));
    await symlink("cycle-a", path.join(agents, "cycle-b"));
    const backup = await backupRemovedSkill(managed, path.join(root, "data"));
    await unlinkSkillAliases(managed, [agents, claude, pi, path.join(root, "missing")]);
    for (const alias of [path.join(agents, "ask-pi"), path.join(claude, "ask-pi"), path.join(pi, "renamed")]) {
      await assert.rejects(lstat(alias), { code: "ENOENT" }, `leftover alias: ${alias}`);
    }
    assert.equal(await readFile(path.join(backup, "SKILL.md"), "utf8"), "original skill");
    assert.equal(await readFile(path.join(pi, "ask-pi/SKILL.md"), "utf8"), "independent original");
    assert.ok((await lstat(path.join(claude, "unrelated"))).isSymbolicLink());
    assert.ok((await lstat(path.join(agents, "cycle-a"))).isSymbolicLink());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("cleanup handles a missing managed parent without leaving dangling aliases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-missing-parent-"));
  try {
    const destination = path.join(root, "missing/ask-pi");
    const alias = path.join(root, "ask-pi");
    await symlink(destination, alias);
    await unlinkSkillAliases(destination, [root]);
    await assert.rejects(lstat(alias), { code: "ENOENT" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("backing up a skill symlink never moves or deletes its original target", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-link-removal-"));
  try {
    const original = path.join(root, "original");
    await mkdir(original);
    await writeFile(path.join(original, "SKILL.md"), "keep me");
    const link = path.join(root, "ask-pi");
    await symlink(original, link);
    const backup = await backupRemovedSkill(link, path.join(root, "data"));
    assert.ok((await lstat(backup)).isSymbolicLink());
    await assert.rejects(lstat(link), { code: "ENOENT" });
    assert.equal(await readFile(path.join(original, "SKILL.md"), "utf8"), "keep me");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("skill activation skips dangling links without hiding valid skills", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-dangling-"));
  try {
    await symlink(path.join(root, "deleted"), path.join(root, "ask-pi"));
    await mkdir(path.join(root, "valid"));
    await writeFile(path.join(root, "valid/SKILL.md"), "---\nname: valid\n---\nKeep loading");
    assert.equal(activeSkillRoot("pi", root), root);
  } finally { await rm(root, { recursive: true, force: true }); }
});
