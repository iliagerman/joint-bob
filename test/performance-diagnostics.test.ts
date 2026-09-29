import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

test("fast operations do not generate noisy logs", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-perf-fast-"));
  const diagnostics = createPerformanceDiagnostics(root, { slowMs: 10_000 });
  t.after(async () => { await diagnostics.stop(); await rm(root, { recursive: true, force: true }); });
  assert.equal(await diagnostics.measure("test.fast", () => 42), 42);
  await diagnostics.flush();
  await assert.rejects(stat(path.join(root, "performance.jsonl")), { code: "ENOENT" });
});
