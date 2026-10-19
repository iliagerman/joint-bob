import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ensureSkillSharingSchema, setSkillShares, skillScopeGrants } from "../src/skill-sharing.js";
import { ensureClusterSharingPolicySchema } from "../src/cluster-sharing-policy.js";
import { settingsDatabase } from "../src/settings-store.js";
import { activeSkillRoot } from "../src/resource-activation.js";
import { existsSync } from "node:fs";
import { agentResourcePaths, claudeAgentResourceArgs, piAgentResourcePaths } from "../src/agent-resources.js";
import { getScopedResourcePaths, getSettings } from "../src/settings.js";
import { kiroAgentProfile } from "../src/harnesses/kiro/resources.js";

test("project grant migration preserves old scopes and validates projects", () => {
  const db = new DatabaseSync(":memory:");
  ensureClusterSharingPolicySchema(db);
  try {
    db.exec("CREATE TABLE skill_scope_shares(name TEXT,kind TEXT CHECK(kind IN ('workspace','conversation')),target_id TEXT,project_id TEXT DEFAULT '',PRIMARY KEY(name,kind,target_id,project_id)); INSERT INTO skill_scope_shares VALUES('portable','workspace','personal',''); CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES('p'); CREATE TABLE workspaces(id TEXT PRIMARY KEY); INSERT INTO workspaces VALUES('personal');");
    ensureSkillSharingSchema(db);
    assert.deepEqual(skillScopeGrants(db, "portable"), { workspaceIds: ["personal"], projectIds: [], conversations: [] });
    setSkillShares(db, randomUUID(), "portable", [], [], { workspaceIds: [], projectIds: ["p"], conversations: [] });
    assert.deepEqual(skillScopeGrants(db, "portable").projectIds, ["p"]);
    assert.throws(() => setSkillShares(db, randomUUID(), "portable", [], [], { workspaceIds: [], projectIds: ["missing"], conversations: [] }), /project/i);
    ensureSkillSharingSchema(db);
    assert.deepEqual(skillScopeGrants(db, "portable").projectIds, ["p"]);
  } finally { db.close(); }
});

test("owner runtime filters narrow scopes through shared, configured and native aliases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "local-scope-"));
  const db = settingsDatabase();
  ensureSkillSharingSchema(db);
  try {
    await mkdir(path.join(root, "skills/portable"), { recursive: true });
    await mkdir(path.join(root, "aliases"));
    await writeFile(path.join(root, "skills/portable/SKILL.md"), "---\nname: portable\ndescription: Test\n---\n");
    await symlink(path.join(root, "skills/portable"), path.join(root, "aliases/renamed"));
    db.prepare("INSERT INTO skill_scope_shares VALUES(?,?,?,?)").run("portable", "project", "p", "");
    for (const folder of ["skills", "aliases"]) {
      const source = path.join(root, folder);
      assert.notEqual(activeSkillRoot("pi", source), source, "node-wide runtime must not load scoped skill");
      assert.equal(activeSkillRoot("pi", source, { projectId: "p" }), source);
      const denied = activeSkillRoot("pi", source, { projectId: "other" });
      assert.equal(existsSync(path.join(denied, folder === "skills" ? "portable/SKILL.md" : "renamed/SKILL.md")), false);
    }
    db.prepare("INSERT INTO revoked_scoped_skills VALUES(?)").run("portable");
    assert.notEqual(activeSkillRoot("pi", path.join(root, "aliases"), { projectId: "p" }), path.join(root, "aliases"), "receiver revocation blocks aliases even in the former scope");
    db.prepare("DELETE FROM revoked_scoped_skills WHERE name=?").run("portable");
    db.prepare("DELETE FROM skill_scope_shares WHERE name=?").run("portable");
    assert.equal(activeSkillRoot("pi", path.join(root, "skills")), path.join(root, "skills"), "clearing grants restores existing local availability");
  } finally {
    db.prepare("DELETE FROM skill_scope_shares WHERE name=?").run("portable");
    db.prepare("DELETE FROM revoked_scoped_skills WHERE name=?").run("portable");
    await rm(root, { recursive: true, force: true });
  }
});


test("Pi, Claude and Kiro runtime inputs honor conversation scope and reject native bypasses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scope-adapters-"));
  const db = settingsDatabase();
  ensureSkillSharingSchema(db);
  const resources = agentResourcePaths(path.join(root, "resources"));
  const source = path.join(resources.sharedSkills, "portable");
  const cwd = path.join(root, "project");
  const config = (conversationId: string) => getScopedResourcePaths("p", conversationId);
  try {
    await mkdir(source, { recursive: true });
    await mkdir(path.join(cwd, ".kiro/skills"), { recursive: true });
    await writeFile(path.join(source, "SKILL.md"), "---\nname: portable\ndescription: Scoped adapter fixture\n---\n");
    await symlink(source, path.join(cwd, ".kiro/skills/alias"));
    db.prepare("INSERT INTO skill_scope_shares VALUES(?,?,?,?)").run("portable", "conversation", "c", "p");
    assert.equal(piAgentResourcePaths(resources.root, config("c")).skills[0], resources.sharedSkills);
    assert.notEqual(piAgentResourcePaths(resources.root, config("other")).skills[0], resources.sharedSkills);
    const claudeHasSkill = (conversationId: string) => {
      const args = claudeAgentResourceArgs(resources.root, config(conversationId), undefined, cwd);
      return args.some((arg, index) => args[index - 1] === "--plugin-dir" && existsSync(path.join(arg, "skills/portable/SKILL.md")));
    };
    assert.equal(claudeHasSkill("c"), true);
    assert.equal(claudeHasSkill("other"), false);
    for (const conversationId of ["c", "other"]) {
      const profile = await kiroAgentProfile({ cwd, projectId: "p", conversationId, sessionId: `scope-${conversationId}` }, "");
      const content = JSON.parse(await readFile(path.join(getSettings().runtimes.kiro.configPath, "agents", `${profile}.json`), "utf8"));
      assert.equal(content.resources.some((file: string) => file.startsWith("skill://") && existsSync(path.join(file.slice("skill://".length).replace(/\/\*\*\/SKILL\.md$/, ""), "alias/SKILL.md"))), conversationId === "c");
    }
    await mkdir(path.join(root, ".claude/skills"), { recursive: true });
    await symlink(source, path.join(root, ".claude/skills/renamed"));
    assert.throws(() => claudeHasSkill("other"), /Cannot safely suppress blocked native/);
    assert.equal(claudeHasSkill("c"), true);
  } finally {
    db.prepare("DELETE FROM skill_scope_shares WHERE name=?").run("portable");
    await rm(root, { recursive: true, force: true });
  }
});
