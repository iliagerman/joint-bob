#!/usr/bin/env node
// Runs the full suite once, then reruns only the files whose tests failed, one at a time.
// Repeating the whole suite to get past one timing-sensitive test cost a full pass each time.
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";

const CONCURRENCY = Number(process.env.TEST_CONCURRENCY || 4);
// More failing files than this is a real breakage, not a flaky test; rerunning them only delays the report.
const MAX_RERUN_FILES = 8;

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

const requested = process.argv.slice(2);
const all = requested.length ? requested : readdirSync("test").filter((file) => file.endsWith(".test.ts")).sort().map((file) => `test/${file}`);
const first = await runTests(all, CONCURRENCY);
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
