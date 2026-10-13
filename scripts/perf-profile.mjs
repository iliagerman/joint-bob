#!/usr/bin/env node
// Summarises a CPU profile of the server (~/.joint-bob/logs/cpu-profile.cpuprofile): where its
// busy time goes, by the function of this application nearest to each sample.
//
//   node scripts/perf-profile.mjs                      this machine's latest profile
//   ssh homeserver 'cat ~/.joint-bob/logs/cpu-profile.cpuprofile' | node scripts/perf-profile.mjs -
//   node scripts/perf-profile.mjs --top 60 --depth 2   more rows, with each function's caller
//
// A profile is taken by the server itself when it has been busy for a minute, or on request:
//   echo 30 > ~/.joint-bob/logs/cpu-profile.request    (seconds; picked up within ten seconds)
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : Number(args[index + 1]); };
const top = option("--top", 40), depth = option("--depth", 1);
const file = args.find((value, index) => !value.startsWith("--") && !["--top", "--depth"].includes(args[index - 1]))
  ?? path.join(process.env.JOINT_BOB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob"), "logs", "cpu-profile.cpuprofile");
const profile = JSON.parse(readFileSync(file === "-" ? 0 : file, "utf8"));

const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
const self = new Map();
let total = 0;
profile.samples.forEach((id, index) => { const time = profile.timeDeltas[index] ?? 0; self.set(id, (self.get(id) ?? 0) + time); total += time; });

const short = (url) => url.replace(/^file:\/\/.*\/dist\//, "").replace(/^file:\/\/.*node_modules\//, "node_modules/");
const label = (node) => `${node.callFrame.functionName || "(anonymous)"} ${short(node.callFrame.url)}:${node.callFrame.lineNumber + 1}`;
const named = (id) => nodes.get(id).callFrame.functionName;
// The wrappers every query and stage passes through say nothing about who is busy.
const ours = (node) => node.callFrame.url.includes("/dist/") && !/sqlite-statements|performance-diagnostics/.test(node.callFrame.url);

let busy = 0;
const byFunction = new Map(), byNative = new Map();
for (const [id, time] of self) {
  if (named(id) === "(idle)") continue;
  busy += time;
  const frames = [];
  for (let at = id; at !== undefined && frames.length < depth; at = parent.get(at)) if (ours(nodes.get(at))) frames.push(label(nodes.get(at)));
  const key = frames.length ? frames.join("  <  ") : `[outside the application] ${label(nodes.get(id))}`;
  byFunction.set(key, (byFunction.get(key) ?? 0) + time);
  if (!nodes.get(id).callFrame.url) byNative.set(named(id), (byNative.get(named(id)) ?? 0) + time);
}
const share = (time) => `${(time / busy * 100).toFixed(1).padStart(5)}%`;
const seconds = (time) => (time / 1e6).toFixed(1);
console.log(`Profile of ${seconds(total)} s: busy ${seconds(busy)} s (${Math.round(busy / total * 100)}%)`);
console.log("\nBusy time by the nearest application function:");
for (const [key, time] of [...byFunction].sort((a, b) => b[1] - a[1]).slice(0, top)) console.log(`  ${share(time)}  ${key}`);
console.log("\nBusy time inside the runtime itself (database calls show as get, all, run, exec):");
for (const [key, time] of [...byNative].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${share(time)}  ${key}`);
