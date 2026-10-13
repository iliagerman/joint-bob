import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import { createPerformanceDiagnostics } from "../src/server/performance-diagnostics.js";

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test("slow requests and stages log route templates, never private inputs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-perf-"));
  const diagnostics = createPerformanceDiagnostics(root, { slowMs: 0 });
  const app = express();
  app.use(diagnostics.middleware);
  app.get("/projects/:projectId", async (_request, response) => {
    await diagnostics.measure("sessions.transcript_catalog", () => pause(5));
    response.json({ value: "private-response" });
  });
  const server = createServer(app);
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await diagnostics.stop(); await rm(root, { recursive: true, force: true }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const result = await fetch(`http://127.0.0.1:${address.port}/projects/private-id?token=private-query`, { headers: { Authorization: "Bearer private-header" } });
  await result.text();
  await diagnostics.flush();
  const text = await readFile(path.join(root, "performance.jsonl"), "utf8");
  assert.doesNotMatch(text, /private-/);
  const events = text.trim().split("\n").map(line => JSON.parse(line));
  const request = events.find(event => event.event === "slow_request");
  const operation = events.find(event => event.event === "slow_operation");
  assert.equal(request.route, "/projects/:projectId");
  assert.equal(request.status, 200);
  assert.equal(request.aborted, false);
  assert.equal(operation.requestId, request.requestId);
  assert.equal(operation.operation, "sessions.transcript_catalog");
  assert.ok(operation.durationMs >= 4);
  assert.equal((await stat(path.join(root, "performance.jsonl"))).mode & 0o777, 0o600);
});

test("diagnostics rotate bounded logs and preserve operation errors", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-perf-rotate-"));
  const diagnostics = createPerformanceDiagnostics(root, { slowMs: 0, maxBytes: 800 });
  t.after(async () => { await diagnostics.stop(); await rm(root, { recursive: true, force: true }); });
  for (let index = 0; index < 30; index++) await diagnostics.measure("test.stage", () => index);
  const failure = new Error("private-failure");
  await assert.rejects(diagnostics.measure("test.failure", () => { throw failure; }), error => error === failure);
  await diagnostics.flush();
  for (const file of ["performance.jsonl", "performance.jsonl.1"]) {
    assert.ok((await stat(path.join(root, file))).size <= 800);
    assert.doesNotMatch(await readFile(path.join(root, file), "utf8"), /private-failure/);
  }
});

test("runtime diagnostics include event-loop, CPU and memory and stop cleanly", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-perf-runtime-"));
  const diagnostics = createPerformanceDiagnostics(root, { intervalMs: 10 });
  t.after(async () => { await diagnostics.stop(); await rm(root, { recursive: true, force: true }); });
  diagnostics.start();
  await pause(45);
  await diagnostics.stop();
  const filename = path.join(root, "performance.jsonl");
  const before = await readFile(filename, "utf8");
  const events = before.trim().split("\n").map(line => JSON.parse(line));
  const runtime = events.find(event => event.event === "runtime");
  for (const key of ["cpuPercent", "loopDelayMaxMs", "loopDelayP99Ms", "eventLoopUtilization", "rssMb", "heapMb", "activeRequests"]) assert.equal(typeof runtime[key], "number", key);
  await pause(25);
  assert.equal(await readFile(filename, "utf8"), before);
});

test("WebSocket stages share a private trace ID and report a pending operation before it completes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-perf-socket-"));
  const diagnostics = createPerformanceDiagnostics(root, { slowMs: 0, waitingMs: 5 });
  let release!: (value: number) => void;
  const gate = new Promise<number>(resolve => { release = resolve; });
  const work = diagnostics.trace("chat.connect", () => diagnostics.measure("chat.open.runtime", () => gate));
  t.after(async () => { release(42); await work; await diagnostics.stop(); await rm(root, { recursive: true, force: true }); });
  await pause(20);
  await diagnostics.flush();
  const filename = path.join(root, "performance.jsonl");
  const pending = (await readFile(filename, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(pending.map(event => event.operation).sort(), ["chat.connect", "chat.open.runtime"]);
  assert.ok(pending.every(event => event.event === "operation_waiting"));
  assert.notEqual(pending[0].requestId, "background");
  assert.equal(pending[0].requestId, pending[1].requestId);
  release(42);
  assert.equal(await work, 42);
  const failure = new Error("private-socket-failure");
  await assert.rejects(diagnostics.trace("chat.failure", () => { throw failure; }), error => error === failure);
  await pause(20);
  await diagnostics.flush();
  const text = await readFile(filename, "utf8");
  assert.doesNotMatch(text, /private-socket-failure/);
  const events = text.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.event === "operation_waiting").length, 2, "completion and rejection clear waiting timers");
  const completed = events.filter(event => event.event === "slow_operation" && event.operation !== "chat.failure");
  assert.equal(completed.length, 2);
  assert.ok(completed.every(event => event.requestId === pending[0].requestId));
  assert.notEqual(events.find(event => event.operation === "chat.failure").requestId, pending[0].requestId);
});

test("every request and stage is counted, fast ones included, so a change can be measured", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-perf-totals-"));
  const diagnostics = createPerformanceDiagnostics(root, { slowMs: 10_000, intervalMs: 10, totalsMs: 60 });
  const app = express();
  app.use(diagnostics.middleware);
  app.get("/projects/:projectId", async (_request, response) => {
    // Longer than the floor below which a minute's sum is left out, whichever window it lands in.
    await diagnostics.measure("sessions.transcript_catalog", () => pause(70));
    response.json({});
  });
  app.get("/cheap", (_request, response) => { response.json({}); });
  const server = createServer(app);
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await diagnostics.stop(); await rm(root, { recursive: true, force: true }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  diagnostics.start();
  for (const id of ["private-a", "private-b"]) await (await fetch(`http://127.0.0.1:${address.port}/projects/${id}`)).text();
  await (await fetch(`http://127.0.0.1:${address.port}/cheap`)).text();
  await pause(150);
  await diagnostics.stop();
  const text = await readFile(path.join(root, "performance.jsonl"), "utf8");
  assert.doesNotMatch(text, /private-/);
  const events = text.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.some(event => event.event === "slow_request" || event.event === "slow_operation"), false, "nothing here was slow");
  const routes = events.filter(event => event.event === "route_total");
  const listed = routes.filter(event => event.route === "/projects/:projectId");
  assert.equal(listed.reduce((sum, event) => sum + event.count, 0), 2);
  assert.ok(listed.reduce((sum, event) => sum + event.totalMs, 0) >= 130);
  assert.ok(listed.every(event => event.method === "GET" && event.maxMs >= 65 && event.intervalMs > 0));
  assert.equal(routes.some(event => event.route === "/cheap"), false, "a route that cost almost nothing is left out");
  const stages = events.filter(event => event.event === "operation_total");
  assert.equal(stages.filter(event => event.operation === "sessions.transcript_catalog").reduce((sum, event) => sum + event.count, 0), 2);
});

test("fast operations do not generate noisy logs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-perf-fast-"));
  const diagnostics = createPerformanceDiagnostics(root, { slowMs: 10_000 });
  t.after(async () => { await diagnostics.stop(); await rm(root, { recursive: true, force: true }); });
  assert.equal(await diagnostics.measure("test.fast", () => 42), 42);
  await diagnostics.flush();
  await assert.rejects(stat(path.join(root, "performance.jsonl")), { code: "ENOENT" });
});

test("a CPU profile is taken on request and when the server stays busy, never while it is merely starting", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-perf-profile-"));
  const profile = path.join(root, "cpu-profile.cpuprofile"), request = path.join(root, "cpu-profile.request");
  const taken = async (): Promise<Array<{ reason: string; seconds: number }>> => (await readFile(path.join(root, "performance.jsonl"), "utf8").catch(() => ""))
    .split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(event => event.event === "cpu_profile");
  const until = async (check: () => Promise<boolean>): Promise<void> => { for (let tries = 0; tries < 200 && !await check(); tries++) await pause(20); assert.equal(await check(), true); };
  const spin = (): NodeJS.Timeout => setInterval(() => { const end = Date.now() + 8; while (Date.now() < end) { /* keeps the event loop busy */ } }, 1);

  // Busy from the first sample, but still inside its warm-up: only the request is honoured.
  const starting = createPerformanceDiagnostics(root, { intervalMs: 10, profile: { busy: 0.5, samples: 3, seconds: 0.05, warmupMs: 60_000 } });
  let busy = spin();
  t.after(async () => { clearInterval(busy); await starting.stop(); await settled.stop(); await rm(root, { recursive: true, force: true }); });
  starting.start();
  await pause(150);
  assert.deepEqual(await taken(), []);
  await writeFile(request, "0.05");
  await until(async () => (await taken()).length === 1);
  clearInterval(busy);
  await starting.stop();
  assert.deepEqual((await taken()).map(event => event.reason), ["requested"]);
  await assert.rejects(stat(request), { code: "ENOENT" }, "the request is consumed");
  assert.equal((await stat(profile)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(profile, "utf8"));
  assert.ok(Array.isArray(saved.nodes) && saved.nodes.length > 0 && Array.isArray(saved.samples));

  // Past its warm-up and busy for several samples in a row: one profile, then the cooldown holds.
  const settled = createPerformanceDiagnostics(root, { intervalMs: 10, profile: { busy: 0.5, samples: 3, seconds: 0.05, warmupMs: 0, cooldownMs: 60_000 } });
  busy = spin();
  settled.start();
  await until(async () => (await taken()).length === 2);
  await pause(250);
  clearInterval(busy);
  await settled.stop();
  assert.deepEqual((await taken()).map(event => event.reason), ["requested", "busy"]);
});
