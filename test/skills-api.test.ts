import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function writeSkill(root: string, name: string, contents: string): Promise<void> {
  await mkdir(path.join(root, name), { recursive: true });
  await writeFile(path.join(root, name, "SKILL.md"), contents, "utf8");
}

test("skills are discovered per harness with project scope shadowing the user scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-skills-"));
  const { listSkills } = await import("../src/skills.js");

  try {
    const piUser = path.join(root, "pi-user");
    const claudeUser = path.join(root, "claude-user");
    const project = path.join(root, "project");

    await writeSkill(piUser, "debugging", "---\nname: debugging\ndescription: Structured debugging guidelines.\n---\n\n# Debugging\n");
    await writeSkill(claudeUser, "caveman", "---\nname: caveman\ndescription: Terse caveman replies.\n---\n");
    await writeSkill(claudeUser, "push-code", "---\nname: push-code\ndescription: User-level version.\n---\n");
    await writeSkill(path.join(project, ".claude", "skills"), "push-code", "---\nname: push-code\ndescription: Project-level version.\n---\n");

    const skills = await listSkills(project, { piUser, claudeUser });

    const pi = skills.filter((skill) => skill.harness === "pi");
    assert.deepEqual(pi.map((skill) => skill.name), ["debugging"]);
    assert.equal(pi[0].description, "Structured debugging guidelines.");
    assert.equal(pi[0].scope, "user");

    const claude = skills.filter((skill) => skill.harness === "claude");
    // Sorted by name, and the project copy of push-code wins over the user copy.
    assert.deepEqual(claude.map((skill) => skill.name), ["caveman", "push-code"]);
    const pushCode = claude.find((skill) => skill.name === "push-code");
    assert.equal(pushCode?.description, "Project-level version.");
    assert.equal(pushCode?.scope, "project");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("symlinked skill directories are discovered for both harnesses", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-skills-symlink-"));
  const { listSkills } = await import("../src/skills.js");

  try {
    const piUser = path.join(root, "pi-user");
    const claudeUser = path.join(root, "claude-user");
    const targets = path.join(root, "targets");
    await mkdir(piUser, { recursive: true });
    await mkdir(claudeUser, { recursive: true });
    await writeSkill(targets, "pi-develop", "---\nname: pi-develop\ndescription: Develop Pi.\n---\n");
    await writeSkill(targets, "claude-develop", "---\nname: claude-develop\ndescription: Develop Claude.\n---\n");
    await symlink(path.join(targets, "pi-develop"), path.join(piUser, "pi-develop"), "dir");
    await symlink(path.join(targets, "claude-develop"), path.join(claudeUser, "claude-develop"), "dir");

    const skills = await listSkills(path.join(root, "project"), { piUser, claudeUser });

    assert.deepEqual(skills.map((skill) => `${skill.harness}:${skill.name}`), [
      "claude:claude-develop",
      "pi:pi-develop",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a missing skills directory yields no skills instead of throwing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-skills-empty-"));
  const { listSkills } = await import("../src/skills.js");

  try {
    const skills = await listSkills(path.join(root, "no-such-project"), {
      piUser: path.join(root, "absent-pi"),
      claudeUser: path.join(root, "absent-claude"),
    });
    assert.deepEqual(skills, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("block-scalar frontmatter descriptions parse instead of leaking YAML markers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-skills-block-"));
  const { listSkills } = await import("../src/skills.js");

  try {
    const claudeUser = path.join(root, "claude-user");
    await writeSkill(claudeUser, "folded", "---\nname: folded\ndescription: >\n  Runs the AI-DLC workflow.\n  Use it for lifecycle stages.\n---\n");
    await writeSkill(claudeUser, "chomped", "---\nname: chomped\ndescription: >-\n  One folded line.\n---\n");
    await writeSkill(claudeUser, "literal", "---\nname: literal\ndescription: |\n  Line one.\n  Line two.\n---\n");

    const skills = await listSkills(path.join(root, "project"), { piUser: path.join(root, "absent"), claudeUser });
    const byName = new Map(skills.map((skill) => [skill.name, skill.description]));

    assert.equal(byName.get("folded"), "Runs the AI-DLC workflow. Use it for lifecycle stages.");
    assert.equal(byName.get("chomped"), "One folded line.");
    assert.equal(byName.get("literal"), "Line one.\nLine two.");
    assert.ok([...byName.values()].every((description) => !/^[>|]$/.test(description)), `Raw YAML markers leaked: ${JSON.stringify([...byName.values()])}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a skill without frontmatter still lists under its directory name", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-skills-bare-"));
  const { listSkills } = await import("../src/skills.js");

  try {
    const claudeUser = path.join(root, "claude-user");
    await writeSkill(claudeUser, "bare-skill", "# Just a heading, no frontmatter\n");

    const skills = await listSkills(path.join(root, "project"), { piUser: path.join(root, "absent"), claudeUser });
    assert.deepEqual(skills.map((skill) => skill.name), ["bare-skill"]);
    assert.equal(skills[0].description, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the skills dialog is searchable and inserts the harness-specific invocation", async () => {
  const [html, app, styles] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
  ]);

  assert.match(html, /<dialog id="skillsDialog" data-testid="skills-dialog">/);
  assert.match(html, /id="skillsDialogSearchInput"[\s\S]*?data-testid="skills-dialog-search-input"/);
  assert.match(html, /id="skillsDialogList"/);

  // The /skill chip opens the browser instead of typing a bare prefix the user has to complete.
  assert.match(app, /function openSkillsDialog\(\)/);
  assert.match(app, /function renderSkillsDialog\(\)/);
  assert.match(app, /\/skills`/);
  // Pi takes the /skill:<name> form; Claude takes a bare slash command.
  assert.match(app, /`\/skill:\$\{skill\.name\} `/);
  assert.match(app, /`\/\$\{skill\.name\} `/);

  assert.match(styles, /\.skills-dialog-list \{/);
  assert.match(styles, /\.skill-option-description \{/);
});
