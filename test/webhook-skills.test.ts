import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { createWebhook, webhookInputSchema } from "../src/webhooks.js";
import { resolveWebhookResources, snapshotWebhookResources } from "../src/webhook-resources.js";
import { discoverWebhookGitSkills, importExistingWebhookSkill, importWebhookGitSkill, listSelectableWebhookSkills, removeWebhookSkill, uploadWebhookSkill } from "../src/webhook-skills.js";
import type { SkillRoots } from "../src/skills.js";
import { getSettings, updateSettings } from "../src/settings.js";

const input = webhookInputSchema.parse({ name: "Issues", target: { kind: "project", projectId: "p1" } });

test("a local skill folder is copied into webhook-private storage with its references", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "webhook-skills-"));
  const db = new DatabaseSync(path.join(root, "node.db"));
  try {
    const { webhook } = createWebhook(db, input);
    const skill = await uploadWebhookSkill(db, webhook.id, [
      { relativePath: "SKILL.md", data: Buffer.from("---\nname: csv-review\ndescription: Review uploaded CSVs.\n---\nUse tools.") },
      { relativePath: "references/format.md", data: Buffer.from("Reference") },
    ], { root });
    assert.equal(skill.name, "csv-review");
    assert.equal(await readFile(path.join(skill.path, "references/format.md"), "utf8"), "Reference");
    assert.match(skill.path, /webhook-resources/);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Git skills are discovered and imported at the selected commit without global installation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "webhook-git-skills-"));
  const repo = path.join(root, "repo");
  const db = new DatabaseSync(path.join(root, "node.db"));
  try {
    await import("node:fs/promises").then(fs => fs.mkdir(path.join(repo, "skills", "csv-review"), { recursive: true }));
    execFileSync("git", ["init", "--initial-branch=main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "Webhook Test"]);
    await import("node:fs/promises").then(fs => fs.writeFile(path.join(repo, "skills", "csv-review", "SKILL.md"), "---\nname: csv-review\ndescription: Review CSVs.\n---\n"));
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-m", "add skill"]);
    const commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const { webhook } = createWebhook(db, input);
    const gitUrl = pathToFileURL(repo).href;
    const found = await discoverWebhookGitSkills(gitUrl, null, { root });
    assert.equal(found.commit, commit);
    assert.deepEqual(found.skills.map(skill => skill.key), ["skill:skills/csv-review"]);
    const imported = await importWebhookGitSkill(db, webhook.id, gitUrl, null, commit, "skill:skills/csv-review", { root });
    assert.equal(imported.source, "git");
    assert.match(await readFile(path.join(imported.path, "SKILL.md"), "utf8"), /Review CSVs/);
    await import("node:fs/promises").then(fs => fs.writeFile(path.join(repo, "skills", "csv-review", "SKILL.md"), "---\nname: csv-review\ndescription: Review updated CSVs.\n---\n"));
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", ["-C", repo, "commit", "-m", "update skill"]);
    const updatedCommit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const updated = await importWebhookGitSkill(db, webhook.id, gitUrl, null, updatedCommit, "skill:skills/csv-review", { root }, imported.id);
    assert.equal(updated.id, imported.id);
    assert.notEqual(updated.versionId, imported.versionId);
    assert.match(await readFile(path.join(updated.path, "SKILL.md"), "utf8"), /Review updated CSVs/);
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='git_resources'").get(), undefined);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("existing webhook skill choices exclude machine defaults", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "webhook-skill-scope-"));
  const project = path.join(root, "project"), user = path.join(root, "machine-skills"), shared = path.join(root, "managed-skills");
  const strictResourceIsolation = getSettings().strictResourceIsolation;
  updateSettings({ syncthing: { endpoint: "" }, strictResourceIsolation: false });
  try {
    for (const [folder, name] of [[path.join(project, ".agents", "skills", "project-review"), "project-review"], [path.join(user, "machine-review"), "machine-review"], [path.join(shared, "managed-review"), "managed-review"]]) {
      await import("node:fs/promises").then(fs => fs.mkdir(folder, { recursive: true }));
      await import("node:fs/promises").then(fs => fs.writeFile(path.join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill.\n---\n`));
    }
    const roots: SkillRoots = { shared, user: { pi: user }, piUser: user, global: [], project: [] };
    const names = (await listSelectableWebhookSkills(project, undefined, roots)).map(skill => skill.name);
    assert.ok(names.includes("project-review"));
    assert.ok(names.includes("managed-review"));
    assert.equal(names.includes("machine-review"), false);
    const db = new DatabaseSync(":memory:");
    try {
      const { webhook } = createWebhook(db, input);
      const machineInventoryId = createHash("sha256").update(`pi\0machine-review\0${path.resolve(user, "machine-review")}`).digest("hex");
      await assert.rejects(importExistingWebhookSkill(db, webhook.id, project, machineInventoryId, { root }, roots), /no longer available/i);
    } finally { db.close(); }
  } finally {
    updateSettings({ syncthing: { endpoint: "" }, strictResourceIsolation });
    await rm(root, { recursive: true, force: true });
  }
});

test("existing skills can be snapshotted privately without changing their source folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "webhook-existing-skill-"));
  const project = path.join(root, "project");
  const folder = path.join(project, ".agents", "skills", "local-review");
  const db = new DatabaseSync(path.join(root, "node.db"));
  try {
    await import("node:fs/promises").then(fs => fs.mkdir(folder, { recursive: true }));
    const original = "---\nname: local-review\ndescription: Local review skill.\n---\nKeep this source.";
    await import("node:fs/promises").then(fs => fs.writeFile(path.join(folder, "SKILL.md"), original));
    const available = await listSelectableWebhookSkills(project);
    assert.equal(JSON.stringify(available).includes(project), false, "the browser inventory does not expose local paths");
    const selected = available.find(skill => skill.name === "local-review");
    assert.ok(selected);
    const { webhook } = createWebhook(db, input);
    const copied = await importExistingWebhookSkill(db, webhook.id, project, selected.inventoryId, { root });
    assert.equal(copied.source, "existing");
    assert.equal(await readFile(path.join(copied.path, "SKILL.md"), "utf8"), original);
    assert.equal(await readFile(path.join(folder, "SKILL.md"), "utf8"), original);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("removing a skill prevents future snapshots but retains an accepted version", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "webhook-skill-remove-"));
  const db = new DatabaseSync(path.join(root, "node.db"));
  try {
    const { webhook } = createWebhook(db, input);
    const skill = await uploadWebhookSkill(db, webhook.id, [{ relativePath: "SKILL.md", data: Buffer.from("---\nname: review\ndescription: Review.\n---\n") }], { root });
    const snapshot = snapshotWebhookResources(db, webhook.id, "node-a");
    await removeWebhookSkill(db, webhook.id, skill.id);
    assert.deepEqual(snapshotWebhookResources(db, webhook.id, "node-a").skillVersionIds, []);
    const resolved = await resolveWebhookResources(db, snapshot, { root });
    assert.equal(resolved.skillRoots.length, 1);
    assert.match(await readFile(path.join(resolved.skillRoots[0], "SKILL.md"), "utf8"), /name: review/);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("local skill uploads reject traversal, duplicate paths and missing SKILL.md", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "webhook-skills-invalid-"));
  const db = new DatabaseSync(path.join(root, "node.db"));
  try {
    const { webhook } = createWebhook(db, input);
    await assert.rejects(uploadWebhookSkill(db, webhook.id, [{ relativePath: "../outside", data: Buffer.from("x") }], { root }), /path/i);
    await assert.rejects(uploadWebhookSkill(db, webhook.id, [{ relativePath: "readme.md", data: Buffer.from("x") }], { root }), /SKILL.md/i);
    await assert.rejects(uploadWebhookSkill(db, webhook.id, [
      { relativePath: "SKILL.md", data: Buffer.from("---\nname: one\ndescription: d\n---") },
      { relativePath: "SKILL.md", data: Buffer.from("---\nname: one\ndescription: d\n---") },
    ], { root }), /duplicate/i);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
