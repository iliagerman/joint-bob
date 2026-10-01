import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeAgentResourceArgs } from "../src/agent-resources.js";
import { scopedSkillDirectory, scopedSkillParent, scopedSkillsRoot, writeScopedSkillIndex } from "../src/scoped-skills.js";
import { getScopedResourcePaths } from "../src/settings.js";

test("scoped skills load only in the granted project or conversation", async () => {
  const resources = await mkdtemp(path.join(os.tmpdir(), "scoped-skill-resources-"));
  try {
    for (const name of ["workspace-skill", "conversation-skill"]) {
      await mkdir(scopedSkillDirectory(name), { recursive: true });
      await writeFile(path.join(scopedSkillDirectory(name), "SKILL.md"), `---\nname: ${name}\ndescription: Scoped fixture\n---\n`);
    }
    writeScopedSkillIndex([
      { name: "workspace-skill", projectIds: ["project-a"], conversations: [] },
      { name: "conversation-skill", projectIds: [], conversations: [{ projectId: "project-a", conversationId: "conversation-1" }] },
    ]);
    const skills = (projectId?: string, conversationId?: string) => getScopedResourcePaths(projectId, conversationId).project.skills;
    assert.deepEqual(skills("project-a", "conversation-1"), [scopedSkillParent("workspace-skill"), scopedSkillParent("conversation-skill")]);
    assert.deepEqual(skills("project-a", "conversation-2"), [scopedSkillParent("workspace-skill")]);
    assert.deepEqual(skills("project-b", "conversation-1"), [], "a conversation ID only counts inside its own project");
    assert.deepEqual(skills(), []);

    const args = claudeAgentResourceArgs(resources, getScopedResourcePaths("project-a", "conversation-1"));
    const plugins = args.flatMap((arg, index) => args[index - 1] === "--plugin-dir" ? [arg] : []);
    assert.ok(plugins.some((plugin) => existsSync(path.join(plugin, "skills/conversation-skill/SKILL.md"))), "Claude receives the conversation's scoped skill");
    const other = claudeAgentResourceArgs(resources, getScopedResourcePaths("project-a", "conversation-2"));
    const otherPlugins = other.flatMap((arg, index) => other[index - 1] === "--plugin-dir" ? [arg] : []);
    assert.ok(!otherPlugins.some((plugin) => existsSync(path.join(plugin, "skills/conversation-skill"))), "another conversation does not");
  } finally {
    writeScopedSkillIndex([]);
    await rm(scopedSkillsRoot(), { recursive: true, force: true });
    await rm(resources, { recursive: true, force: true });
  }
});
