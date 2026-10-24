import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse as parseYaml } from "yaml";
import { saveSkillDraft, skillDraftSchema } from "../src/skill-draft.js";

const draft = { name: "cert-renewal", description: 'Use for certificates: "renewal"', instructions: "Check expiration, renew staging first, then verify the new certificate." };

test("saving a reviewed skill preserves edited fields and never overwrites an existing skill", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-draft-"));
  try {
    const saved = await saveSkillDraft(root, [".agents", "skills"], draft);
    const content = await readFile(saved, "utf8");
    const [, metadata, instructions] = content.split("---\n");
    assert.deepEqual(parseYaml(metadata), { name: draft.name, description: draft.description });
    assert.equal(instructions.trim(), draft.instructions);
    await assert.rejects(saveSkillDraft(root, [".agents", "skills"], { ...draft, instructions: "Different instructions that must not overwrite the original." }), { code: "EEXIST" });
    assert.equal(await readFile(saved, "utf8"), content);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("skill save rejects traversal names and symlink destinations", async () => {
  assert.equal(skillDraftSchema.safeParse({ ...draft, name: "../escape" }).success, false);
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-draft-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "skill-outside-"));
  try {
    await symlink(outside, path.join(root, ".agents"));
    await assert.rejects(saveSkillDraft(root, [".agents", "skills"], draft), /real directory/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});
