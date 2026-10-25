#!/usr/bin/env node
// Summarises a node's performance log (~/.joint-bob/logs/performance.jsonl) for one window,
// so the same numbers can be read before and after a change.
//
//   node scripts/perf-report.mjs                      last 10 minutes on this machine
//   node scripts/perf-report.mjs --minutes 30
//   node scripts/perf-report.mjs --since 2026-10-13T04:00Z --until 2026-10-13T04:10Z
//   ssh homeserver 'cat ~/.joint-bob/logs/performance.jsonl' | node scripts/perf-report.mjs -
//   node scripts/perf-report.mjs --json > before.json
//
// "All requests" rows come from the once-a-minute totals and count every request. "Slow" rows
// only see requests that took half a second or more, so a route that became fast leaves them.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const flags = new Set(["--minutes", "--since", "--until", "--top"]);
const files = args.filter((value, index) => !value.startsWith("--") && !flags.has(args[index - 1]));
const top = Number(option("--top") ?? 12);

function read(file) {
  try { return readFileSync(file === "-" ? 0 : file, "utf8"); } catch (error) { if (file === "-" || error.code !== "ENOENT") throw error; return ""; }
}
const logs = path.join(process.env.JOINT_BOB_DATA_DIR ?? path.join(os.homedir(), ".joint-bob"), "logs");
const text = (files.length ? files : [path.join(logs, "performance.jsonl.1"), path.join(logs, "performance.jsonl")]).map(read).join("\n");
const events = [];
for (const line of text.split("\n")) {
  if (!line) continue;
  try { const event = JSON.parse(line); event.time = Date.parse(event.at); if (Number.isFinite(event.time)) events.push(event); } catch { /* a line cut by rotation */ }
}
if (!events.length) { console.error("No performance events found."); process.exit(1); }
events.sort((a, b) => a.time - b.time);

const until = option("--until") ? Date.parse(option("--until")) : events.at(-1).time;
const since = option("--since") ? Date.parse(option("--since")) : until - Number(option("--minutes") ?? 10) * 60_000;
const windowed = events.filter((event) => event.time > since && event.time <= until);
const minutes = (until - since) / 60_000;

const sorted = (values) => [...values].sort((a, b) => a - b);
const percentile = (values, share) => { const list = sorted(values); return list.length ? list[Math.min(list.length - 1, Math.floor(list.length * share))] : 0; };
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const round = (value, digits = 0) => Math.round(value * 10 ** digits) / 10 ** digits;

function grouped(event, label) {
  const groups = new Map();
  for (const entry of windowed) {
    if (entry.event !== event) continue;
    const key = label(entry);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return groups;
}

function totals(event, label) {
  return [...grouped(event, label)].map(([name, entries]) => {
    const count = entries.reduce((sum, entry) => sum + entry.count, 0), totalMs = entries.reduce((sum, entry) => sum + entry.totalMs, 0);
    return { name, count, perMinute: round(count / minutes, 1), meanMs: round(totalMs / count), maxMs: Math.max(...entries.map((entry) => entry.maxMs)), totalSeconds: round(totalMs / 1000, 1) };
  }).sort((a, b) => b.totalSeconds - a.totalSeconds);
}

function slow(event, label) {
  return [...grouped(event, label)].map(([name, entries]) => {
    const durations = entries.map((entry) => entry.durationMs);
    return { name, count: entries.length, medianMs: percentile(durations, 0.5), p90Ms: percentile(durations, 0.9), maxMs: Math.max(...durations), totalSeconds: round(durations.reduce((sum, value) => sum + value, 0) / 1000, 1) };
  }).sort((a, b) => b.totalSeconds - a.totalSeconds);
}

const runtime = windowed.filter((event) => event.event === "runtime");
// Present only while the file sync worker runs; its CPU is also inside the process-wide cpuPercent.
const worker = runtime.filter((event) => typeof event.workerHeapMb === "number");
const present = (key) => worker.map((event) => event[key]).filter((value) => typeof value === "number");
const report = {
  window: { since: new Date(since).toISOString(), until: new Date(until).toISOString(), minutes: round(minutes, 1), restarts: windowed.filter((event) => event.event === "started").length },
  runtime: {
    samples: runtime.length,
    busyPercent: round(mean(runtime.map((event) => event.eventLoopUtilization)) * 100),
    cpuPercent: round(mean(runtime.map((event) => event.cpuPercent))),
    stallMedianMs: percentile(runtime.map((event) => event.loopDelayMaxMs), 0.5),
    stallMaxMs: Math.max(0, ...runtime.map((event) => event.loopDelayMaxMs)),
    rssMb: round(mean(runtime.map((event) => event.rssMb))),
  },
  worker: {
    samples: worker.length,
    busyPercent: round(mean(present("workerUtilization")) * 100),
    cpuPercent: round(mean(present("workerCpuPercent"))),
    heapMb: round(mean(present("workerHeapMb"))),
  },
  allRequests: totals("route_total", (event) => `${event.method} ${event.route}`),
  allStages: totals("operation_total", (event) => event.operation),
  slowRequests: slow("slow_request", (event) => `${event.method} ${event.route}`),
  slowStages: slow("slow_operation", (event) => event.operation),
};

if (args.includes("--json")) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

function table(title, rows, columns) {
  console.log(`\n${title}`);
  if (!rows.length) { console.log("  (none in this window)"); return; }
  const shown = rows.slice(0, top);
  const width = Math.max(...shown.map((row) => row.name.length), 4);
  console.log(`  ${"".padEnd(width)}  ${columns.map(([heading]) => heading.padStart(9)).join(" ")}`);
  for (const row of shown) console.log(`  ${row.name.padEnd(width)}  ${columns.map(([, key]) => String(row[key]).padStart(9)).join(" ")}`);
  if (rows.length > shown.length) console.log(`  … ${rows.length - shown.length} more (--top N)`);
}

console.log(`Window ${report.window.since} → ${report.window.until} (${report.window.minutes} min${report.window.restarts ? `, ${report.window.restarts} restart(s)` : ""})`);
console.log(`Event loop busy ${report.runtime.busyPercent}%   CPU ${report.runtime.cpuPercent}%   stall median ${report.runtime.stallMedianMs} ms, longest ${report.runtime.stallMaxMs} ms   memory ${report.runtime.rssMb} MB   (${report.runtime.samples} samples)`);
if (report.worker.samples) console.log(`File sync worker busy ${report.worker.busyPercent}%   CPU ${report.worker.cpuPercent}%   heap ${report.worker.heapMb} MB   (${report.worker.samples} samples)`);
const totalColumns = [["count", "count"], ["per min", "perMinute"], ["mean ms", "meanMs"], ["max ms", "maxMs"], ["total s", "totalSeconds"]];
const slowColumns = [["count", "count"], ["median ms", "medianMs"], ["p90 ms", "p90Ms"], ["max ms", "maxMs"], ["total s", "totalSeconds"]];
table("All requests, by time spent", report.allRequests, totalColumns);
table("All stages, by time spent", report.allStages, totalColumns);
table("Slow requests (0.5 s or more)", report.slowRequests, slowColumns);
table("Slow stages (0.5 s or more)", report.slowStages, slowColumns);
