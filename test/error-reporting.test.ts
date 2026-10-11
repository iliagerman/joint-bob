import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { MAX_REPORTS_PER_WINDOW, REPORT_WINDOW_MS, errorDestination, getErrorReportingSettings, reportError, updateErrorReportingSettings, type ErrorReportingSettings } from "../src/error-reporting.js";
import { addNtfyService, deleteNtfyService, listNtfyServices } from "../src/ntfy.js";

type Published = { authorization?: string; body: { topic: string; title: string; message: string; tags: string[] } };
let ntfy: Server;
let ntfyUrl: string;
const published: Published[] = [];

before(async () => {
  ntfy = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (part) => { raw += part; });
    request.on("end", () => { published.push({ authorization: request.headers.authorization, body: JSON.parse(raw) }); response.end("{}"); });
  });
  await new Promise<void>((resolve) => ntfy.listen(0, "127.0.0.1", resolve));
  const address = ntfy.address();
  if (!address || typeof address === "string") throw new Error("ntfy fixture address missing");
  ntfyUrl = `http://127.0.0.1:${address.port}`;
});
after(() => new Promise<void>((resolve) => ntfy.close(() => resolve())));
beforeEach(() => {
  published.length = 0;
  for (const service of listNtfyServices()) deleteNtfyService(service.id);
  updateErrorReportingSettings({ enabled: false, sameDestination: true, client: { enabled: true, serviceId: null, topic: "" }, backend: { enabled: true, serviceId: null, topic: "" } });
});

function settings(serviceId: string, overrides: Partial<ErrorReportingSettings> = {}): ErrorReportingSettings {
  return {
    enabled: true,
    sameDestination: false,
    client: { enabled: true, serviceId, topic: "ui-errors" },
    backend: { enabled: true, serviceId, topic: "backend-errors" },
    ...overrides,
  };
}

async function waitForPublished(count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (published.length < count) {
    if (Date.now() > deadline) throw new Error(`expected ${count} ntfy message(s), got ${published.length}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("error reporting is off until enabled, and each channel resolves its own or the shared destination", () => {
  const service = addNtfyService("Errors", ntfyUrl, "token");
  assert.equal(getErrorReportingSettings().enabled, false);
  assert.equal(errorDestination("client"), null);
  assert.equal(errorDestination("backend"), null);

  const separate = settings(service.id);
  assert.deepEqual(errorDestination("client", separate), { serviceId: service.id, topic: "ui-errors" });
  assert.deepEqual(errorDestination("backend", separate), { serviceId: service.id, topic: "backend-errors" });
  const shared = settings(service.id, { sameDestination: true });
  assert.deepEqual(errorDestination("backend", shared), { serviceId: service.id, topic: "ui-errors" }, "backend uses the client topic when shared");
  const backendOnly = settings(service.id, { sameDestination: true, client: { enabled: false, serviceId: null, topic: "" } });
  assert.equal(errorDestination("client", backendOnly), null);
  assert.deepEqual(errorDestination("backend", backendOnly), { serviceId: service.id, topic: "backend-errors" }, "with the client channel off, sharing falls back to the backend's own topic");
  const clientOnly = settings(service.id, { backend: { enabled: false, serviceId: null, topic: "" } });
  assert.deepEqual(errorDestination("client", clientOnly), { serviceId: service.id, topic: "ui-errors" });
  assert.equal(errorDestination("backend", clientOnly), null);
});

test("saving rejects an enabled channel without a saved server or a valid topic, and needs at least one channel", () => {
  const service = addNtfyService("Errors", ntfyUrl, "");
  assert.throws(() => updateErrorReportingSettings(settings(service.id, { client: { enabled: false, serviceId: null, topic: "" }, backend: { enabled: false, serviceId: null, topic: "" } })), /client errors, backend errors, or both/);
  assert.throws(() => updateErrorReportingSettings(settings("00000000-0000-4000-8000-000000000009")), /Client errors need a saved ntfy server/);
  assert.throws(() => updateErrorReportingSettings(settings(service.id, { backend: { enabled: true, serviceId: service.id, topic: "bad/topic" } })), /Backend errors need a topic/);
  assert.throws(() => updateErrorReportingSettings({ ...settings(service.id), extra: true }), /Unrecognized key/);
  const saved = updateErrorReportingSettings(settings(service.id, { sameDestination: true, backend: { enabled: true, serviceId: null, topic: "" } }));
  assert.equal(saved.sameDestination, true, "a shared backend needs no server or topic of its own");
  assert.deepEqual(getErrorReportingSettings(), saved);
});

test("a reported error reaches its channel's topic with the stack, once per window, with withheld repeats counted", async () => {
  const service = addNtfyService("Errors", ntfyUrl, "secret-token");
  updateErrorReportingSettings(settings(service.id));
  const now = Date.now();
  assert.equal(await reportError("backend", { summary: "Hub pull failed for 3f6c2a10-1b2c-4d5e-8f90-123456789abc", detail: "Error: boom\n    at pull (hubs.ts:10:5)" }, now), true);
  await waitForPublished(1);
  const [first] = published;
  assert.equal(first.authorization, "Bearer secret-token");
  assert.equal(first.body.topic, "backend-errors");
  assert.equal(first.body.title, "Joint Bob backend error");
  assert.deepEqual(first.body.tags, ["rotating_light"]);
  assert.match(first.body.message, /^Hub pull failed/);
  assert.match(first.body.message, /at pull \(hubs\.ts:10:5\)/, "the stack is forwarded");

  assert.equal(await reportError("backend", { summary: "Hub pull failed for 9a8b7c6d-1b2c-4d5e-8f90-123456789abc" }, now + 1_000), false, "the same error with another id is withheld");
  assert.equal(await reportError("backend", { summary: "Database is locked" }, now + 2_000), true);
  await waitForPublished(2);
  assert.match(published[1].body.message, /1 repeated or excess error was not sent since the last report/);

  assert.equal(await reportError("client", { summary: "TypeError: x is undefined", source: "/#chat" }, now + 3_000), true, "channels throttle independently");
  await waitForPublished(3);
  assert.equal(published[2].body.topic, "ui-errors");
  assert.equal(published[2].body.title, "Joint Bob UI error");
  assert.match(published[2].body.message, /Source: \/#chat/);

  assert.equal(await reportError("backend", { summary: "Hub pull failed for 3f6c2a10-1b2c-4d5e-8f90-123456789abc" }, now + REPORT_WINDOW_MS + 1), true, "the same error is sent again after the window");
});

test("a channel sends at most its per-window limit, then reports how many it held back", async () => {
  const service = addNtfyService("Errors", ntfyUrl, "");
  updateErrorReportingSettings(settings(service.id));
  const now = Date.now();
  for (let index = 0; index < MAX_REPORTS_PER_WINDOW; index += 1) assert.equal(await reportError("backend", { summary: `Distinct failure ${String.fromCharCode(97 + index)}` }, now + index), true);
  assert.equal(await reportError("backend", { summary: "One too many" }, now + 100), false);
  assert.equal(await reportError("backend", { summary: "Next window" }, now + REPORT_WINDOW_MS), true);
  await waitForPublished(MAX_REPORTS_PER_WINDOW + 1);
  assert.match(published.at(-1)!.body.message, /1 repeated or excess error was not sent/);
});

test("a disabled channel, a removed server, or a failing ntfy never throws to the caller", async () => {
  const service = addNtfyService("Errors", ntfyUrl, "");
  updateErrorReportingSettings(settings(service.id, { backend: { enabled: false, serviceId: null, topic: "" } }));
  assert.equal(await reportError("backend", { summary: "ignored" }), false);
  deleteNtfyService(service.id);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => { warnings.push(message); };
  try { assert.equal(await reportError("client", { summary: "orphaned" }), false); } finally { console.warn = warn; }
  assert.match(warnings.join("\n"), /Could not forward a client error to ntfy: ntfy service not found/);
  assert.equal(published.length, 0);
});

test("a rejected async route reaches the Express error handler instead of hanging", async () => {
  const { forwardAsyncRouteErrors } = await import("../src/server/error-capture.js");
  forwardAsyncRouteErrors();
  const app = express();
  app.get("/async", async () => { await Promise.resolve(); throw new Error("async route failed"); });
  const seen: string[] = [];
  app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => { seen.push(error.message); response.status(500).json({ error: error.message }); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("address missing");
    const response = await fetch(`http://127.0.0.1:${address.port}/async`, { signal: AbortSignal.timeout(5_000) });
    assert.equal(response.status, 500);
    assert.deepEqual(seen, ["async route failed"]);
  } finally {
    server.close();
  }
});

test("console.error is mirrored to the backend topic with its stack", async () => {
  const service = addNtfyService("Errors", ntfyUrl, "");
  updateErrorReportingSettings(settings(service.id));
  const { installBackendErrorCapture } = await import("../src/server/error-capture.js");
  const write = console.error;
  console.error = () => undefined;
  installBackendErrorCapture();
  console.error("Scheduled task recovery failed", new Error("kaboom"));
  console.error = write;
  await waitForPublished(1);
  assert.equal(published[0].body.topic, "backend-errors");
  assert.match(published[0].body.message, /^Scheduled task recovery failed Error: kaboom/);
  assert.match(published[0].body.message, /\n {4}at /, "the stack trace is part of the report");
});

test("an unhandled rejection is logged and reported without stopping the node, and an uncaught exception exits after reporting", { timeout: 60_000 }, async () => {
  const service = addNtfyService("Errors", ntfyUrl, "");
  updateErrorReportingSettings(settings(service.id));
  const root = await mkdtemp(path.join(os.tmpdir(), "jb-error-capture-"));
  try {
    const capture = pathToFileURL(fileURLToPath(new URL("../src/server/error-capture.ts", import.meta.url))).href;
    const script = path.join(root, "capture.mjs");
    await writeFile(script, `
      const { installBackendErrorCapture } = await import(${JSON.stringify(capture)});
      installBackendErrorCapture();
      Promise.reject(new Error("lost promise"));
      setTimeout(() => { console.log("still running"); setTimeout(() => { throw new Error("fatal crash"); }, 50); }, 500);
    `);
    const child = spawn(process.execPath, ["--import", "tsx", script], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (part) => { output += part; });
    child.stderr.on("data", (part) => { output += part; });
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    assert.match(output, /Unhandled promise rejection Error: lost promise\n\s+at /, output);
    assert.match(output, /still running/, "an unhandled rejection does not stop the node");
    assert.match(output, /Uncaught exception; the node is exiting Error: fatal crash/, output);
    assert.equal(code, 1, "an uncaught exception still exits the node");
    await waitForPublished(2);
    const messages = published.map((entry) => entry.body.message);
    assert.ok(messages.some((message) => message.startsWith("Unhandled promise rejection Error: lost promise")), messages.join("\n---\n"));
    assert.ok(messages.some((message) => message.startsWith("Uncaught exception; the node is exiting Error: fatal crash")), messages.join("\n---\n"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
