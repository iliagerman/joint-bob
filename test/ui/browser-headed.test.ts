import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { BrowserRuntime } from "../../src/browser-runtime.js";

const agent = { kind: "agent" as const };
const human = { kind: "human" as const, id: "synthetic-headed-test-human" };

test("native browser launch mode and persistent profile survive reopening", { timeout: 120_000 }, async t => {
  const mode = process.env.JOINT_BOB_BROWSER_MODE ?? "headless";
  assert.ok(mode === "headless" || mode === "virtual", `unsupported browser mode: ${mode}`);
  if (mode === "virtual") assert.ok(process.env.DISPLAY?.trim(), "DISPLAY must be supplied by Xvfb");

  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>Headed fixture</title><input id='fixture'>");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  const runtime = new BrowserRuntime();
  t.after(() => runtime.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/`;
  const start = {
    projectId: `synthetic-project-${randomUUID()}`,
    conversationId: randomUUID(),
    appNodeId: randomUUID(),
    engine: "pi" as const,
    profileName: `Synthetic headed ${randomUUID()}`,
    url,
  };

  const first = await runtime.create(start);
  assert.ok(first.profileId);
  const browser = await runtime.execute(first.id, { action: "evaluate", expression: "({ userAgent: navigator.userAgent, webdriver: navigator.webdriver })" }, agent) as { userAgent: string; webdriver: boolean };
  if (mode === "virtual") assert.doesNotMatch(browser.userAgent, /HeadlessChrome/);
  else assert.match(browser.userAgent, /HeadlessChrome/);
  assert.equal(browser.webdriver, true);

  const screenshot = await runtime.execute(first.id, { action: "screenshot" }, agent) as { mimeType: string; data: string };
  assert.equal(screenshot.mimeType, "image/png");
  assert.deepEqual(Buffer.from(screenshot.data, "base64").subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  await runtime.execute(first.id, { action: "evaluate", expression: "document.cookie = 'headed_fixture=persistent; Max-Age=3600; SameSite=Lax'; localStorage.setItem('headed-fixture', 'persistent')" }, agent);
  await runtime.execute(first.id, { action: "takeControl" }, human);
  await assert.rejects(runtime.execute(first.id, { action: "fill", selector: "#fixture", text: "blocked" }, agent), /human control/i);
  await assert.rejects(runtime.execute(first.id, { action: "evaluate", expression: "document.title" }, agent), /human control/i);
  await runtime.execute(first.id, { action: "resumeAgent" }, human);
  assert.equal(await runtime.execute(first.id, { action: "evaluate", expression: "document.title" }, agent), "Headed fixture");
  await runtime.execute(first.id, { action: "close" }, agent);

  const reopened = await runtime.create({ ...start, profileName: undefined, profileId: first.profileId });
  const storage = await runtime.execute(reopened.id, { action: "evaluate", expression: "({ cookie: document.cookie, local: localStorage.getItem('headed-fixture') })" }, agent) as { cookie: string; local: string };
  assert.match(storage.cookie, /(?:^|; )headed_fixture=persistent(?:;|$)/);
  assert.equal(storage.local, "persistent");
  await runtime.execute(reopened.id, { action: "close" }, agent);
});
