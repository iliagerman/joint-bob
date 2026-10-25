import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { listSettingsRecords, saveSettingsRecord } from "../src/file-sync/control.js";
import { importSyncthingUserRules, type SyncthingRuleSource } from "../src/file-sync/stignore-import.js";
import { EMPTY_RULE_SETTINGS } from "../src/file-sync/types.js";

const MAC = "11111111-1111-4111-8111-111111111111";
const HOME = "22222222-2222-4222-8222-222222222222";
const folders = (id: string) => [`joint-bob-${id}`, `joint-bob-tickets-${id}`, `joint-bob-worktrees-${id}`];

function source(lines: Record<string, string[]>, options: { silent?: boolean } = {}): SyncthingRuleSource & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async folders() { if (options.silent) throw new TypeError("fetch failed"); return new Set(Object.keys(lines)); },
    async lines(folderId) { reads.push(folderId); return lines[folderId] ?? []; },
  };
}

const rules = (db: DatabaseSync, id: string) => listSettingsRecords(db).find((record) => record.key === `project:${id}`)?.value;

test("a node's own ignore lines become the project's rules, managed lines left out", async () => {
  const db = new DatabaseSync(":memory:");
  const result = await importSyncthingUserRules(db, MAC, ["p1"], folders, source({
    "joint-bob-p1": ["(?d)node_modules/", ".env", ".skill_data", ".tmp_*", ".skill_data"],
    "joint-bob-worktrees-p1": ["(?d)vendor", "scratch/"],
  }));
  assert.deepEqual(result, { imported: ["p1"], unreachable: false });
  assert.deepEqual(rules(db, "p1"), { ...EMPTY_RULE_SETTINGS, userRules: [".skill_data", ".tmp_*", "scratch/"], importedFrom: [MAC] });
});

test("a project already imported by this node is not read again", async () => {
  const db = new DatabaseSync(":memory:");
  await importSyncthingUserRules(db, MAC, ["p1"], folders, source({ "joint-bob-p1": [".skill_data"] }));
  const again = source({ "joint-bob-p1": [".skill_data", "later"] });
  assert.deepEqual(await importSyncthingUserRules(db, MAC, ["p1"], folders, again), { imported: [], unreachable: false });
  assert.deepEqual(again.reads, [], "no folder was read");
  assert.deepEqual(rules(db, "p1")?.userRules, [".skill_data"]);
});

test("two nodes' lines end as the union, also after one node's record replaced the other's", async () => {
  const db = new DatabaseSync(":memory:");
  await importSyncthingUserRules(db, MAC, ["p1"], folders, source({ "joint-bob-p1": [".skill_data"] }), new Date("2026-10-25T06:00:00Z"));
  // The homeserver imported concurrently and its later record won: the Mac is no longer listed.
  assert.ok(saveSettingsRecord(db, { key: "project:p1", value: { ...EMPTY_RULE_SETTINGS, userRules: ["(?i)/local_bucket/**.mp3"], importedFrom: [HOME] }, updatedAt: "2026-10-25T06:00:01Z", origin: HOME }));
  const result = await importSyncthingUserRules(db, MAC, ["p1"], folders, source({ "joint-bob-p1": [".skill_data"] }), new Date("2026-10-25T06:00:02Z"));
  assert.deepEqual(result.imported, ["p1"]);
  assert.deepEqual(rules(db, "p1"), { ...EMPTY_RULE_SETTINGS, userRules: ["(?i)/local_bucket/**.mp3", ".skill_data"], importedFrom: [MAC, HOME].sort() });
});

test("a Syncthing that does not answer marks nothing, so the next start reads it", async () => {
  const db = new DatabaseSync(":memory:");
  assert.deepEqual(await importSyncthingUserRules(db, MAC, ["p1"], folders, source({}, { silent: true })), { imported: [], unreachable: true });
  assert.equal(rules(db, "p1"), undefined);
});

test("a node with no lines of its own writes no record", async () => {
  const db = new DatabaseSync(":memory:");
  assert.deepEqual(await importSyncthingUserRules(db, MAC, ["p1"], folders, source({ "joint-bob-p1": ["(?d)node_modules/", ".env"] })), { imported: [], unreachable: false });
  assert.deepEqual(listSettingsRecords(db), []);
});

test("importing keeps the record's other settings", async () => {
  const db = new DatabaseSync(":memory:");
  assert.ok(saveSettingsRecord(db, { key: "project:p1", value: { ...EMPTY_RULE_SETTINGS, disabledBuiltins: ["dist/"], gitignore: true, importedFrom: [HOME] }, updatedAt: "2026-10-25T06:00:00Z", origin: HOME }));
  await importSyncthingUserRules(db, MAC, ["p1"], folders, source({ "joint-bob-tickets-p1": ["drafts/"] }), new Date("2026-10-25T06:00:05Z"));
  assert.deepEqual(rules(db, "p1"), { ...EMPTY_RULE_SETTINGS, disabledBuiltins: ["dist/"], gitignore: true, userRules: ["drafts/"], importedFrom: [MAC, HOME].sort() });
});
