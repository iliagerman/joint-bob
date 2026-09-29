import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createSharingCluster, addSharingMember, removeSharingMember, ensureClusterSharingPolicySchema } from "../src/cluster-sharing-policy.js";
import { authorizedSkillClusters, setSkillShares } from "../src/skill-sharing.js";

const temporaryRoots: string[] = [];
async function temporary(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}
after(async () => { await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true }))); });
import {
  buildSkillBundle,
  installSkillBundle,
  validateSkillBundle,
} from "../src/skill-sharing.js";

async function skill(files: Record<string, string>): Promise<string> {
  const root = await temporary("skill-sharing-");
  for (const [name, contents] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), contents);
  }
  return root;
}

const manifest = "---\nname: portable\ndescription: A portable test skill\n---\nInstructions\n";

test("buildSkillBundle transfers one file without a sparse entry", async () => {
  const root = await skill({ "SKILL.md": manifest });
  const { bundle } = await buildSkillBundle(root, "portable");
  assert.deepEqual(bundle.files.map((file) => file.path), ["SKILL.md"]);
  assert.equal(Buffer.from(bundle.files[0].content, "base64").toString(), manifest);
});

test("buildSkillBundle transfers manifest, scripts, and modes", async () => {
  const root = await skill({ "SKILL.md": manifest, "scripts/run.sh": "#!/bin/sh\necho ok\n" });
  const { bundle } = await buildSkillBundle(root, "portable");
  assert.deepEqual(bundle.files.map((file) => file.path), ["scripts/run.sh", "SKILL.md"]);
  assert.equal(Buffer.from(bundle.files.find((file) => file.path === "scripts/run.sh")!.content, "base64").toString(), "#!/bin/sh\necho ok\n");
});

test("bundle validation rejects nonportable and case-colliding paths", () => {
  const encoded = Buffer.from("x").toString("base64");
  for (const badPath of ["../x", "C:/x", "a\\b", "a\0b", "dist/output.js", "service-account-prod.json"]) {
    assert.throws(() => validateSkillBundle({ files: [{ path: "SKILL.md", content: Buffer.from(manifest).toString("base64"), executable: false }, { path: badPath, content: encoded, executable: false }] }));
  }
  assert.throws(() => validateSkillBundle({ files: [
    { path: "SKILL.md", content: Buffer.from(manifest).toString("base64"), executable: false },
    { path: "Readme", content: encoded, executable: false },
    { path: "README", content: encoded, executable: false },
  ] }));
});

test("build rejects a symbolic-link root", async () => {
  const root = await skill({ "SKILL.md": manifest });
  const parent = await temporary("skill-link-");
  const link = path.join(parent, "portable");
  await symlink(root, link, "dir");
  await assert.rejects(buildSkillBundle(link, "portable"), /symbolic link/i);
});

test("install validates digestable content before replacing destination", async () => {
  const root = await skill({ "SKILL.md": manifest, "asset.txt": "new" });
  const built = await buildSkillBundle(root, "portable");
  const parent = await temporary("skill-install-");
  const destination = path.join(parent, "managed", "portable");
  const staging = path.join(parent, "staging");
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, "old.txt"), "old");
  assert.equal(await installSkillBundle(built.bundle, "portable", destination, staging), built.digest);
  assert.equal(await readFile(path.join(destination, "asset.txt"), "utf8"), "new");
});

test("overlapping grants survive one unshare and owner readmission never revives old grants", () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensureClusterSharingPolicySchema(db);
    const manager = randomUUID(), owner = randomUUID(), peer = randomUUID(), x = randomUUID(), y = randomUUID();
    for (const id of [x, y]) {
      createSharingCluster(db, { id, name: id }, manager);
      addSharingMember(db, id, manager, owner, 1);
      addSharingMember(db, id, manager, peer, 1);
    }
    assert.deepEqual(authorizedSkillClusters(db, owner, peer, "portable"), []);
    setSkillShares(db, owner, "portable", [x, y]);
    assert.equal(authorizedSkillClusters(db, owner, peer, "portable").length, 2);
    setSkillShares(db, owner, "portable", [y]);
    assert.deepEqual(authorizedSkillClusters(db, owner, peer, "portable"), [y]);
    removeSharingMember(db, y, manager, owner);
    addSharingMember(db, y, manager, owner, 1);
    assert.deepEqual(authorizedSkillClusters(db, owner, peer, "portable"), []);
  } finally { db.close(); }
});

test("bundle validation rejects invalid base64, duplicates, file collisions, and oversize input", () => {
  const base = { path: "SKILL.md", content: Buffer.from(manifest).toString("base64"), executable: false };
  for (const extra of [
    { path: "script", content: "abc!", executable: false },
    { ...base },
    { path: "SKILL.md/nested", content: "", executable: false },
    { path: "huge", content: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"), executable: false },
  ]) assert.throws(() => validateSkillBundle({ files: [base, extra] }));
});
