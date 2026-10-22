import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ensureTwinSkillSyncSchema, beginTwinSkillInitialization, twinSkillSession, mergeTwinSkillVersions, nextSkillVersion, saveTwinSkillVersion, twinSkillVersions, type TwinSkillVersion } from "../src/twin-skill-sync.js";
const A = "00000000-0000-4000-8000-000000000001", B = "00000000-0000-4000-8000-000000000002";
const version = (digest: string | null, clock = { [A]: 1 }, authorNodeId = A): TwinSkillVersion => ({ name: "fixture", digest, clock, authorNodeId });
const x = "a".repeat(64), y = "b".repeat(64);
test("causal edits, deletion, replay and explicit reimport", () => {
  const old = version(x), deleted = nextSkillVersion(old, A, null);
  assert.equal(mergeTwinSkillVersions(old, deleted).active.digest, null);
  assert.deepEqual(mergeTwinSkillVersions(deleted, old).active, deleted);
  assert.deepEqual(mergeTwinSkillVersions(old, old), { active: old, conflicts: [] });
  const restored = nextSkillVersion(deleted, B, y);
  assert.equal(mergeTwinSkillVersions(deleted, restored).active.digest, y);
});
test("concurrent edits converge, retain alternatives, and absorb repeat conflicts", () => {
  const a = version(x), b = version(y, { [B]: 1 }, B);
  const left = mergeTwinSkillVersions(a, b), right = mergeTwinSkillVersions(b, a);
  assert.deepEqual(left.active, right.active);
  assert.equal(left.conflicts.length, 1);
  assert.deepEqual(left.conflicts, right.conflicts);
  assert.equal(mergeTwinSkillVersions(left.active, a).conflicts.length, 0);
  assert.equal(mergeTwinSkillVersions(left.active, b).conflicts.length, 0);
});
test("concurrent deletion wins while retaining edited content", () => {
  const a = version(x), b = version(null, { [B]: 1 }, B);
  const merged = mergeTwinSkillVersions(a, b);
  assert.equal(merged.active.digest, null);
  assert.equal(merged.conflicts[0].digest, x);
  assert.deepEqual(merged, mergeTwinSkillVersions(b, a));
});
test("invalid clocks, conflicting equal clocks and overflow are rejected", () => {
  for (const count of [0, -1, 1.1, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => mergeTwinSkillVersions(version(x, { [A]: count }), version(y)));
  assert.throws(() => mergeTwinSkillVersions(version(x, { bad: 1 }), version(y)));
  assert.throws(() => mergeTwinSkillVersions(version(x), version(y)), /clock/i);
  assert.throws(() => nextSkillVersion(version(x, { [A]: Number.MAX_SAFE_INTEGER }), A, y), /overflow/i);
});
test("initialization session and baseline are atomic on a failed baseline write",()=>{
 const db=new DatabaseSync(":memory:");try{
  ensureTwinSkillSyncSchema(db);
  db.exec("CREATE TRIGGER reject_baseline BEFORE INSERT ON twin_skill_versions WHEN NEW.name='second' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  const session={relationshipId:"pair",peerNodeId:B,sourceNodeId:A,state:"initializing" as const,paused:false,lastSuccess:null,error:null,initialization:"fixture"};
  assert.throws(()=>beginTwinSkillInitialization(db,session,[version(x),{...version(y),name:"second"}]),/fixture failure/);
  assert.equal(twinSkillSession(db),undefined);assert.deepEqual(twinSkillVersions(db,"pair"),[]);
 }finally{db.close();}
});
test("schema and durable tombstones survive opening another connection", () => {
  const db = new DatabaseSync(":memory:");
  try {
    ensureTwinSkillSyncSchema(db);
    ensureTwinSkillSyncSchema(db);
    const deleted = version(null);
    saveTwinSkillVersion(db, "pair", deleted);
    assert.deepEqual(twinSkillVersions(db, "pair"), [deleted]);
    assert.equal(mergeTwinSkillVersions(twinSkillVersions(db, "pair")[0], version(x, { [B]: 1 }, B)).active.digest, null);
  } finally { db.close(); }
});
