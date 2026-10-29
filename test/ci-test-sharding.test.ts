import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const runner = path.resolve("scripts/ci-test.mjs");

function listShard(index?: string, count?: string): string[] {
  const env = { ...process.env };
  delete env.TEST_SHARD_INDEX;
  delete env.TEST_SHARD_COUNT;
  if (index !== undefined) env.TEST_SHARD_INDEX = index;
  if (count !== undefined) env.TEST_SHARD_COUNT = count;
  return execFileSync(process.execPath, [runner, "--list"], { encoding: "utf8", env }).trim().split("\n");
}

test("test shards deterministically cover every file exactly once", () => {
  const all = listShard();
  const shards = Array.from({ length: 4 }, (_, index) => listShard(String(index + 1), "4"));
  assert.ok(shards.every((files) => files.length > 0));
  assert.equal(new Set(shards.flat()).size, all.length);
  assert.deepEqual(shards.flat().sort(), all);
  assert.deepEqual(shards, Array.from({ length: 4 }, (_, index) => listShard(String(index + 1), "4")));
});

test("test sharding rejects incomplete and out-of-range settings", () => {
  for (const [index, count] of [["1", undefined], [undefined, "4"], ["0", "4"], ["5", "4"], ["x", "4"]]) {
    const env = { ...process.env, ...(index === undefined ? {} : { TEST_SHARD_INDEX: index }), ...(count === undefined ? {} : { TEST_SHARD_COUNT: count }) };
    if (index === undefined) delete env.TEST_SHARD_INDEX;
    if (count === undefined) delete env.TEST_SHARD_COUNT;
    const result = spawnSync(process.execPath, [runner, "--list"], { encoding: "utf8", env });
    assert.notEqual(result.status, 0, `accepted shard index ${index} of ${count}`);
    assert.match(result.stderr, /TEST_SHARD_INDEX and TEST_SHARD_COUNT/);
  }
});
