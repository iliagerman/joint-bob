import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { cp, lstat, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { buildSkillBundle, ensureSkillSharingSchema, installSkillBundle, skillBundleDigest, validateSkillName, type SkillBundle } from "../skill-sharing.js";
import { allowSkillImport, markReceived, receivedOwner, skillSuppressed, suppressSkill, unlinkSkillAliases, withSkillMutation } from "../skill-sharing-files.js";
import { ensureTwinSkillSyncSchema, saveTwinSkillVersion, nextSkillVersion, validateTwinSkillVersion, type TwinSkillVersion } from "../twin-skill-sync.js";

export interface TwinSkillContext {
  db: DatabaseSync; root: string; dataDir: string; localNodeId: string; relationshipId: string; sourceNodeId: string;
  authorize: () => void | Promise<void>; aliasRoots?: string[]; revokeGrants?: (name: string) => void;
  crash?: (phase: "prepared" | "backed-up" | "installed") => void;
  expectedVersion?: string | null;
  expectedDigest?: string | null;
  expectedGrants?: string[];
}
export interface TwinSkillScan { skills: Array<{ name: string; digest: string; grants: string[] }>; protected: string[]; digest: string }
export interface TwinSkillInitializationPlan {
  sourceDigest: string; destinationDigest: string; add: string[]; replace: string[]; remove: string[]; protected: string[];
  grantWithdrawals: Array<{ name: string; grants: string[] }>;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function exists(file: string): Promise<boolean> { try { await lstat(file); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; } }
export async function cacheTwinBundle(db: DatabaseSync, bundle: SkillBundle, expected?: string): Promise<string> {
  const actual = skillBundleDigest(bundle);
  if (expected && actual !== expected) throw new Error("Skill digest mismatch");
  db.prepare("INSERT OR IGNORE INTO twin_skill_bundles VALUES(?,?)").run(actual, JSON.stringify(bundle));
  return actual;
}
export function cachedTwinBundle(db: DatabaseSync, hash: string): SkillBundle {
  const row = db.prepare("SELECT bundle FROM twin_skill_bundles WHERE digest=?").get(hash) as { bundle: string } | undefined;
  if (!row) throw new Error("Skill bundle unavailable");
  const bundle = JSON.parse(row.bundle) as SkillBundle;
  if (skillBundleDigest(bundle) !== hash) throw new Error("Cached skill digest mismatch");
  return bundle;
}
function skillGrants(db:DatabaseSync,name:string):string[]{
  return [
    ...(db.prepare("SELECT cluster_id id FROM skill_shares WHERE name=?").all(name) as Array<{id:string}>).map(x=>`cluster:${x.id}`),
    ...(db.prepare("SELECT node_id id FROM skill_node_shares WHERE name=?").all(name) as Array<{id:string}>).map(x=>`node:${x.id}`),
    ...(db.prepare("SELECT kind,target_id id FROM skill_scope_shares WHERE name=?").all(name) as Array<{kind:string;id:string}>).map(x=>`${x.kind}:${x.id}`),
  ].sort();
}
export async function scanTwinSkills(context: TwinSkillContext): Promise<TwinSkillScan> {
  await context.authorize();
  const { root, db } = context;
  ensureTwinSkillSyncSchema(db); ensureSkillSharingSchema(db);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Skill root must be a real directory");
  const skills: TwinSkillScan["skills"] = [], protectedNames: string[] = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith(".")) continue;
    validateSkillName(entry.name);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Unsafe skill directory: ${entry.name}`);
    const owner = await receivedOwner(root, entry.name, context.dataDir);
    const scoped = db.prepare("SELECT 1 FROM skill_scope_shares WHERE name=?").get(entry.name);
    if (scoped || owner && owner !== `twin:${context.relationshipId}`) { protectedNames.push(entry.name); continue; }
    if (await skillSuppressed(root,entry.name,context.dataDir)) continue;
    // A directory disappearing or losing its manifest during a scan is an error,
    // not evidence that every other skill should be deleted.
    const built = await buildSkillBundle(path.join(root,entry.name),entry.name);
    await cacheTwinBundle(db,built.bundle,built.digest);
    const grants = skillGrants(db,entry.name);
    skills.push({name:entry.name,digest:built.digest,grants});
    if (skills.length + protectedNames.length > 512) throw new Error("Twin skill inventory exceeds 512 skills");
  }
  const result = {skills,protected:protectedNames};
  await context.authorize();
  return {...result,digest:digest(result)};
}
export function previewTwinInitialization(source: TwinSkillScan,destination: TwinSkillScan): TwinSkillInitializationPlan {
  const protectedNames = [...new Set([...source.protected,...destination.protected])].sort();
  const usable = (name:string) => !protectedNames.includes(name);
  const from = new Map(source.skills.filter(s=>usable(s.name)).map(s=>[s.name,s]));
  const to = new Map(destination.skills.filter(s=>usable(s.name)).map(s=>[s.name,s]));
  return {sourceDigest:source.digest,destinationDigest:destination.digest,
    add:[...from.keys()].filter(n=>!to.has(n)).sort(),replace:[...from.keys()].filter(n=>to.has(n)&&to.get(n)!.digest!==from.get(n)!.digest).sort(),
    remove:[...to.keys()].filter(n=>!from.has(n)).sort(),protected:protectedNames,
    grantWithdrawals:[...to.values()].filter(s=>s.grants.length).map(({name,grants})=>({name,grants})).sort((a,b)=>a.name.localeCompare(b.name))};
}
export function assertTwinInitializationSnapshot(destination:TwinSkillScan,actual:TwinSkillScan,applied:TwinSkillVersion[]):void{
  const expected=new Map(destination.skills.map(s=>[s.name,{...s,grants:[...s.grants]}]));
  for(const v of applied){if(v.digest===null)expected.delete(v.name);else expected.set(v.name,{name:v.name,digest:v.digest,grants:[]});}
  const value={skills:[...expected.values()].sort((a,b)=>a.name.localeCompare(b.name)),protected:destination.protected};
  if(digest(value)!==actual.digest)throw new Error("Destination inventory or grants changed during initialization. Cancel and generate a new preview.");
}
interface ApplyOperation { version: TwinSkillVersion; backup: string; expected: string | null; replica: boolean; phase: "prepared" | "backed-up" | "installing" | "installed"; expectedGrants?:string[] }
async function protectedSkill(c: TwinSkillContext,name:string):Promise<boolean>{
  ensureSkillSharingSchema(c.db);
  const owner=await receivedOwner(c.root,name,c.dataDir);
  return Boolean(owner&&owner!==`twin:${c.relationshipId}`||c.db.prepare("SELECT 1 FROM skill_scope_shares WHERE name=?").get(name));
}
function journalPhase(c:TwinSkillContext,op:ApplyOperation,phase:ApplyOperation["phase"]):void{
  op.phase=phase;c.db.prepare("UPDATE twin_skill_pending_apply SET operation=? WHERE relationship_id=? AND name=?").run(JSON.stringify(op),c.relationshipId,op.version.name);
}
async function retainPostCrashChange(c:TwinSkillContext,op:ApplyOperation,actual:string|null):Promise<void>{
  const v=nextSkillVersion(op.version,c.localNodeId,actual);
  if(op.version.digest)c.db.prepare("INSERT OR IGNORE INTO twin_skill_conflicts(relationship_id,name,digest,version) VALUES(?,?,?,?)").run(c.relationshipId,v.name,op.version.digest,JSON.stringify(op.version));
  if(actual===null){await suppressSkill(c.root,v.name,c.dataDir);await unlinkSkillAliases(path.join(c.root,v.name),c.aliasRoots??[]);}
  else if(op.replica)await markReceived(c.root,v.name,`twin:${c.relationshipId}`,c.dataDir);
  c.db.exec("SAVEPOINT twin_skill_recovery");
  try{saveTwinSkillVersion(c.db,c.relationshipId,v);c.db.prepare("DELETE FROM twin_skill_pending_apply WHERE relationship_id=? AND name=?").run(c.relationshipId,v.name);c.db.exec("RELEASE twin_skill_recovery");}
  catch(e){c.db.exec("ROLLBACK TO twin_skill_recovery; RELEASE twin_skill_recovery");throw e;}
}
async function finishApply(c: TwinSkillContext,op: ApplyOperation,recovery: boolean): Promise<void> {
  const {version:v} = op, file = path.join(c.root,v.name);
  await c.authorize();
  if (await protectedSkill(c,v.name)) {
    if(recovery){c.db.prepare("DELETE FROM twin_skill_pending_apply WHERE relationship_id=? AND name=?").run(c.relationshipId,v.name);return;}
    throw new Error(`Protected skill: ${v.name}`);
  }
  if(op.expectedGrants!==undefined&&digest(skillGrants(c.db,v.name))!==digest(op.expectedGrants))throw new Error("Sharing grants changed during interrupted initialization. Cancel and preview again.");
  let actual: string | null = null;
  if (await exists(file)) {const built=await buildSkillBundle(file,v.name);actual=built.digest;await cacheTwinBundle(c.db,built.bundle,built.digest);}
  const externalChange=actual!==v.digest&&actual!==op.expected
    || recovery&&actual===null&&v.digest!==null&&(op.phase==="installing"||op.phase==="installed");
  if(recovery&&externalChange){await retainPostCrashChange(c,op,actual);return;}
  if(externalChange)throw new Error(`Skill changed while applying: ${v.name}`);
  if (actual !== v.digest && actual !== null && !await exists(op.backup)) {
    await mkdir(path.dirname(op.backup),{recursive:true}); await cp(file,op.backup,{recursive:true,errorOnExist:true,force:false});
  }
  journalPhase(c,op,"backed-up");
  c.crash?.("backed-up");
  await c.authorize();
  if(await protectedSkill(c,v.name))throw new Error(`Protected skill: ${v.name}`);
  journalPhase(c,op,"installing");
  if (op.replica || v.digest === null) c.revokeGrants?.(v.name);
  if (v.digest !== null) {
    if (actual !== v.digest) await installSkillBundle(cachedTwinBundle(c.db,v.digest),v.name,file,path.join(c.dataDir,"twin-skill-staging"));
    await allowSkillImport(c.root,v.name,c.dataDir);
    if (op.replica) await markReceived(c.root,v.name,`twin:${c.relationshipId}`,c.dataDir);
  } else {
    // Move to a durable backup before unlinking. Never recursively delete a user path.
    if (actual !== null) {
      const { rename } = await import("node:fs/promises");
      await mkdir(path.dirname(op.backup),{recursive:true});
      await rename(file,`${op.backup}-removed`);
    }
    await suppressSkill(c.root,v.name,c.dataDir);
    await unlinkSkillAliases(file,c.aliasRoots ?? []);
  }
  journalPhase(c,op,"installed");
  c.crash?.("installed");
  await c.authorize();
  if(await protectedSkill(c,v.name))throw new Error(`Protected skill: ${v.name}`);
  c.db.exec("SAVEPOINT twin_skill_apply");
  try {
    saveTwinSkillVersion(c.db,c.relationshipId,v);
    c.db.prepare("DELETE FROM twin_skill_pending_apply WHERE relationship_id=? AND name=?").run(c.relationshipId,v.name);
    c.db.exec("RELEASE twin_skill_apply");
  } catch(e) { c.db.exec("ROLLBACK TO twin_skill_apply; RELEASE twin_skill_apply"); throw e; }
}
export async function applyTwinSkillVersion(c: TwinSkillContext,v: TwinSkillVersion,bundle?: SkillBundle): Promise<void> {
  validateTwinSkillVersion(v); ensureTwinSkillSyncSchema(c.db);
  if (bundle) await cacheTwinBundle(c.db,bundle,v.digest ?? undefined);
  if(v.digest!==null) cachedTwinBundle(c.db,v.digest);
  await withSkillMutation(async()=>{
    await c.authorize();
    const rootInfo = await lstat(c.root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Skill root must be a real directory");
    if (c.expectedVersion !== undefined) {
      const row = c.db.prepare("SELECT version FROM twin_skill_versions WHERE relationship_id=? AND name=?").get(c.relationshipId,v.name) as {version:string}|undefined;
      if ((row?.version ?? null) !== c.expectedVersion) throw new Error("Skill version changed during exchange");
    }
    if(await protectedSkill(c,v.name))throw new Error(`Protected skill: ${v.name}`);
    if(c.expectedGrants!==undefined&&digest(skillGrants(c.db,v.name))!==digest(c.expectedGrants))throw new Error("Sharing grants changed after confirmation");
    if(c.db.prepare("SELECT 1 FROM twin_skill_pending_apply WHERE relationship_id=? AND name=?").get(c.relationshipId,v.name)) throw new Error("Pending skill application needs recovery");
    const file=path.join(c.root,v.name),old=await exists(file)?await buildSkillBundle(file,v.name):null,expected=old?.digest??null;
    if(old)await cacheTwinBundle(c.db,old.bundle,old.digest);
    if (c.expectedDigest !== undefined && expected !== c.expectedDigest) throw new Error(`Skill changed during exchange: ${v.name}`);
    const op:ApplyOperation={version:v,expected,phase:"prepared",expectedGrants:c.expectedGrants,replica:c.localNodeId!==c.sourceNodeId,backup:path.join(c.dataDir,"removed-skills",randomUUID(),v.name)};
    c.db.prepare("INSERT INTO twin_skill_pending_apply VALUES(?,?,?)").run(c.relationshipId,v.name,JSON.stringify(op));
    c.crash?.("prepared");
    await finishApply(c,op,false);
  });
}
export async function recoverTwinSkillApplies(c:TwinSkillContext):Promise<void>{
  ensureTwinSkillSyncSchema(c.db);
  await withSkillMutation(async()=>{
    const rows=c.db.prepare("SELECT operation FROM twin_skill_pending_apply WHERE relationship_id=? ORDER BY name").all(c.relationshipId) as Array<{operation:string}>;
    for(const row of rows) await finishApply(c,JSON.parse(row.operation),true);
  });
}
