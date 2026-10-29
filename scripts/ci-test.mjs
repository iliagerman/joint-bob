#!/usr/bin/env node
// Runs selected files once, then reruns only the files whose tests failed, one at a time.
// Repeating the whole suite to get past one timing-sensitive test cost a full pass each time.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";

const CONCURRENCY = Number(process.env.TEST_CONCURRENCY || 4);
// More failing files than this is a real breakage, not a flaky test; rerunning them only delays the report.
const MAX_RERUN_FILES = 8;

function shardSettings() {
  const index = process.env.TEST_SHARD_INDEX;
  const count = process.env.TEST_SHARD_COUNT;
  if (index === undefined && count === undefined) return { index: 1, count: 1 };
  if (index === undefined || count === undefined) throw new Error("TEST_SHARD_INDEX and TEST_SHARD_COUNT must both be set");
  const shardIndex = Number(index);
  const shardCount = Number(count);
  if (!Number.isInteger(shardIndex) || !Number.isInteger(shardCount) || shardIndex < 1 || shardIndex > shardCount) {
    throw new Error("TEST_SHARD_INDEX and TEST_SHARD_COUNT must be integers with 1 <= index <= count");
  }
  return { index: shardIndex, count: shardCount };
}

function selectShard(files) {
  const { index, count } = shardSettings();
  return files.filter((_, fileIndex) => fileIndex % count === index - 1);
}

function runTests(files, concurrency) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import", "./test/setup.mjs", "--import", "tsx", "--test",
      `--test-concurrency=${concurrency}`, "--test-reporter=tap", ...files,
    ], { stdio: ["ignore", "pipe", "inherit"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; process.stdout.write(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, output }));
  });
}

/** Test files with a failing test: each failure records where its test was defined. */
function failedFiles(output) {
  const files = new Set();
  for (const match of output.matchAll(/^\s*location: '(?:.*\/)?(test\/[^/':]+\.test\.ts):\d+:\d+'/gm)) files.add(match[1]);
  // A file that cannot even load is reported as a failing test named after its path.
  for (const match of output.matchAll(/^not ok \d+ - (?:.*\/)?(test\/[^/\s]+\.test\.ts)$/gm)) files.add(match[1]);
  return [...files];
}

const args = process.argv.slice(2);
const listOnly = args[0] === "--list";
const requested = listOnly ? args.slice(1) : args;
const all = requested.length ? requested : readdirSync("test").filter((file) => file.endsWith(".test.ts")).sort().map((file) => `test/${file}`);
let selected;
try {
  selected = selectShard(all);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
if (listOnly) {
  console.log(selected.join("\n"));
  process.exit(0);
}
if (!selected.length) {
  console.log("No test files assigned to this shard.");
  process.exit(0);
}
const first = await runTests(selected, CONCURRENCY);
if (first.code === 0) process.exit(0);

const failed = failedFiles(first.output);
if (!failed.length) {
  console.error("\nThe suite failed without a failing test to rerun.");
  process.exit(1);
}
if (failed.length > MAX_RERUN_FILES) {
  console.error(`\n${failed.length} test files failed; not rerunning:\n${failed.join("\n")}`);
  process.exit(1);
}
console.error(`\nRerunning ${failed.length} failed test file(s) one at a time:\n${failed.join("\n")}\n`);
const retry = await runTests(failed, 1);
process.exit(retry.code === 0 ? 0 : 1);
