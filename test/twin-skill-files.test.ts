import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyTwinSkillVersion, assertTwinInitializationSnapshot, scanTwinSkills, previewTwinInitialization, recoverTwinSkillApplies, type TwinSkillContext } from "../src/server/twin-skill-files.js";
import { buildSkillBundle, ensureSkillSharingSchema } from "../src/skill-sharing.js";
import { markReceived } from "../src/skill-sharing-files.js";
import { ensureTwinSkillSyncSchema, nextSkillVersion, twinSkillVersions } from "../src/twin-skill-sync.js";
const A = "00000000-0000-4000-8000-000000000001";
async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "twin-files-")), root = path.join(dataDir, "skills");
  await mkdir(root); const db = new DatabaseSync(":memory:"); ensureTwinSkillSyncSchema(db);
  const context: TwinSkillContext = { db, root, dataDir, localNodeId: A, relationshipId: "pair", sourceNodeId: A, authorize: () => {} };
  const skill = async (name: string, text = name) => { await mkdir(path.join(root, name), { recursive: true }); await writeFile(path.join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: Fixture\n---\n${text}`); };
  return { context, skill, close: async () => { db.close(); await rm(dataDir, { recursive: true, force: true }); } };
}
test("complete scans protect relay/received copies and refuse missing or symlink roots", async () => {
 const f = await fixture(); try {
  await f.skill("owned"); await f.skill("relay"); await f.skill("received");
  await markReceived(f.context.root, "relay", "relay:fixture", f.context.dataDir);
  await markReceived(f.context.root, "received", "someone-else", f.context.dataDir);
  const scan = await scanTwinSkills(f.context);
  assert.deepEqual(scan.skills.map(s => s.name), ["owned"]);
  assert.deepEqual(scan.protected, ["received", "relay"]);
  await assert.rejects(scanTwinSkills({ ...f.context, root: path.join(f.context.root, "missing") }));
  await symlink(f.context.root, path.join(f.context.dataDir, "alias"));
  await assert.rejects(scanTwinSkills({ ...f.context, root: path.join(f.context.dataDir, "alias") }), /real directory/);
 } finally { await f.close(); }
});
test("authoritative preview removes extras, replaces differences and preserves protected names", async () => {
 const a = await fixture(), b = await fixture(); try {
  await a.skill("common", "new"); await a.skill("added"); await a.skill("relay");
  await b.skill("common", "old"); await b.skill("extra"); await b.skill("relay");
  await markReceived(b.context.root, "relay", "relay:fixture", b.context.dataDir);
  const plan = previewTwinInitialization(await scanTwinSkills(a.context), await scanTwinSkills(b.context));
  assert.deepEqual(plan.add, ["added"]); assert.deepEqual(plan.replace, ["common"]); assert.deepEqual(plan.remove, ["extra"]); assert.deepEqual(plan.protected, ["relay"]);
 } finally { await a.close(); await b.close(); }
});
test("journal recovers interrupted replacement, backs up old content, and applies deletion idempotently", async () => {
 const f = await fixture(), source = await fixture(); try {
  await f.skill("owned", "old"); await source.skill("owned", "new");
  const built = await buildSkillBundle(path.join(source.context.root, "owned"), "owned");
  const v = nextSkillVersion(undefined, A, built.digest, "owned");
  await assert.rejects(applyTwinSkillVersion({ ...f.context, crash: phase => { if (phase === "installed") throw new Error("fixture crash"); } }, v, built.bundle), /fixture crash/);
  await recoverTwinSkillApplies(f.context);
  assert.equal(twinSkillVersions(f.context.db, "pair")[0].digest, built.digest);
  assert.match(await readFile(path.join(f.context.root, "owned/SKILL.md"), "utf8"), /new$/);
  assert.equal(f.context.db.prepare("SELECT count(*) n FROM twin_skill_pending_apply").get()!.n, 0);
  const del = nextSkillVersion(v, A, null);
  await applyTwinSkillVersion(f.context, del); await applyTwinSkillVersion(f.context, del);
  await assert.rejects(readFile(path.join(f.context.root, "owned/SKILL.md")), { code: "ENOENT" });
  assert.equal(twinSkillVersions(f.context.db, "pair")[0].digest, null);
 } finally { await f.close(); await source.close(); }
});
test("resumed initialization fences extra names and changed grants across the complete snapshot",async()=>{
 const f=await fixture();try{
  await f.skill("owned");const baseline=await scanTwinSkills(f.context);
  assertTwinInitializationSnapshot(baseline,baseline,[]);
  await f.skill("new-unconfirmed");await assert.rejects(async()=>assertTwinInitializationSnapshot(baseline,await scanTwinSkills(f.context),[]),/changed/);
  await rm(path.join(f.context.root,"new-unconfirmed"),{recursive:true});
  f.context.db.prepare("INSERT INTO skill_node_shares VALUES(?,?,?,?,?)").run("owned",A,"fixture",1,1);
  await assert.rejects(async()=>assertTwinInitializationSnapshot(baseline,await scanTwinSkills(f.context),[]),/changed/);
 }finally{await f.close();}
});

test("post-crash edits and deletions become local changes instead of wedging or resurrecting", async () => {
 for (const phase of ["prepared","backed-up","installed"] as const) for (const deleted of [false,true]) {
  const f=await fixture(),source=await fixture();try {
   await f.skill("owned","old");await source.skill("owned","incoming");
   const built=await buildSkillBundle(path.join(source.context.root,"owned"),"owned"),v=nextSkillVersion(undefined,A,built.digest,"owned");
   await assert.rejects(applyTwinSkillVersion({...f.context,crash:p=>{if(p===phase)throw new Error("crash");}},v,built.bundle));
   if(deleted)await rm(path.join(f.context.root,"owned"),{recursive:true});else await f.skill("owned","post-crash edit");
   await recoverTwinSkillApplies(f.context);
   const recovered=twinSkillVersions(f.context.db,"pair")[0];
   assert.equal(recovered.clock[A],2);
   assert.equal(f.context.db.prepare("SELECT count(*) n FROM twin_skill_pending_apply").get()!.n,0);
   if(deleted){assert.equal(recovered.digest,null);await assert.rejects(readFile(path.join(f.context.root,"owned/SKILL.md")),{code:"ENOENT"});}
   else assert.match(await readFile(path.join(f.context.root,"owned/SKILL.md"),"utf8"),/post-crash edit$/);
  }finally{await f.close();await source.close();}
 }
});
test("scoped-grant takeover fences both direct application and recovery",async()=>{
 const f=await fixture();try{
  await f.skill("owned");ensureSkillSharingSchema(f.context.db);
  const v=nextSkillVersion(undefined,A,null,"owned");
  f.context.db.prepare("INSERT INTO skill_scope_shares VALUES(?,?,?,?)").run("owned","project","fixture","");
  await assert.rejects(applyTwinSkillVersion(f.context,v),/protected/i);
  assert.match(await readFile(path.join(f.context.root,"owned/SKILL.md"),"utf8"),/owned/);
 }finally{await f.close();}
});

test("digest mismatch and relay takeover cannot modify content", async () => {
 const f = await fixture(); try {
  await f.skill("owned"); const built = await buildSkillBundle(path.join(f.context.root,"owned"), "owned");
  await assert.rejects(applyTwinSkillVersion(f.context, nextSkillVersion(undefined,A,"f".repeat(64),"owned"), built.bundle), /digest/);
  await markReceived(f.context.root,"owned","relay:late",f.context.dataDir);
  await assert.rejects(applyTwinSkillVersion(f.context,nextSkillVersion(undefined,A,null,"owned")), /protected/i);
  assert.match(await readFile(path.join(f.context.root,"owned/SKILL.md"),"utf8"), /owned/);
 } finally { await f.close(); }
});
