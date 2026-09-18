import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { BrowserRuntime } from "../../src/browser-runtime.js";
import { chromeExecutable } from "./launch-chrome.js";
import { waitForAssertion } from "../async-assertion.js";

const capability = async () => ({ supported: true, available: true, executable: await chromeExecutable(), reason: null });
const agent = (credentialOrigins: string[] = []) => ({ kind: "agent" as const, credentialOrigins });
const human = { kind: "human" as const, id: "native-login-owner" };

function start(engine: string, url: string, profileName: string) {
  return { projectId: randomUUID(), engine, conversationId: randomUUID(), appNodeId: randomUUID(), url, profileName };
}

async function pending(_t: test.TestContext, runtime: BrowserRuntime, id: string) {
  return waitForAssertion(async () => {
    const view = await runtime.get(id);
    assert.ok(view.loginRequest);
    return view;
  }, 15_000);
}

async function listen(server: http.Server, host = "127.0.0.1") {
  server.listen(0, host); await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

function close(server: http.Server) { server.closeAllConnections(); server.close(); }

for (const engine of ["pi", "claude", "kiro"]) {
  test(`${engine} hands a password login to a human without attached secrets`, { timeout: 30_000 }, async t => {
    const server = http.createServer((request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(request.url?.startsWith("/ready") ? "<h1>Account ready</h1>" : '<form action="/ready"><input name="email"><input name="password" type="password"><button>Sign in</button></form>');
    });
    const port = await listen(server); const origin = `http://127.0.0.1:${port}`;
    const runtime = new BrowserRuntime({ capability }); t.after(async () => { await runtime.close(); close(server); });
    const session = await runtime.create(start(engine, origin, `${engine}-no-secret`), []);
    const paused = await pending(t, runtime, session.id);
    assert.equal(paused.loginRequest!.automatic, true);
    await assert.rejects(runtime.execute(session.id, { action: "snapshot" }, agent()), /login required|paused/i);
    await runtime.execute(session.id, { action: "takeControl", loginRequestId: paused.loginRequest!.id }, human);
    await runtime.execute(session.id, { action: "clickElement", selector: "text=Sign in" }, human);
    const ready = await waitForAssertion(async () => { const view = await runtime.get(session.id); assert.match(view.tabs.find(tab => tab.id === view.activePageId)!.url, /\/ready(?:\?|$)/); return view; }, 15_000);
    const done = await runtime.execute(session.id, { action: "completeLogin", requestId: paused.loginRequest!.id, expectedPageId: ready.activePageId! }, human) as Awaited<ReturnType<BrowserRuntime["get"]>>;
    assert.equal(done.owner, "agent"); assert.equal(done.loginRequest, null);
  });
}

test("matching-secret MFA remains human-only and generic Done rejects an empty page", { timeout: 30_000 }, async t => {
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    if (request.url === "/empty") response.end('<body style="height:100vh"></body>');
    else response.end('<main><input id="otp" autocomplete="one-time-code"><button onclick="otp.remove();this.remove();document.querySelector(\'main\').textContent=\'Account ready\'">Finish challenge</button></main>');
  });
  const port = await listen(server); const origin = `http://127.0.0.1:${port}`;
  const runtime = new BrowserRuntime({ capability }); t.after(async () => { await runtime.close(); close(server); });
  const actor = agent([origin]);
  const session = await runtime.create(start("pi", `${origin}/mfa`, "matching-mfa"), [origin]);
  const paused = await pending(t, runtime, session.id);
  await assert.rejects(runtime.execute(session.id, { action: "fill", selector: "#otp", text: "123456", expectedOrigin: origin }, actor), /login required|paused/i);
  await runtime.execute(session.id, { action: "takeControl", loginRequestId: paused.loginRequest!.id }, human);
  const done = () => runtime.execute(session.id, { action: "completeLogin", requestId: paused.loginRequest!.id, expectedPageId: session.activePageId! }, human);
  await assert.rejects(done(), /could not be verified/i);
  await runtime.execute(session.id, { action: "navigate", url: `${origin}/empty` }, human);
  await assert.rejects(done(), /could not be verified/i);
  await runtime.execute(session.id, { action: "navigate", url: `${origin}/mfa` }, human);
  await runtime.execute(session.id, { action: "clickElement", selector: "text=Finish challenge" }, human);
  const completed = await done() as Awaited<ReturnType<BrowserRuntime["get"]>>;
  assert.equal(completed.loginRequest, null); assert.equal(completed.owner, "agent");
  assert.equal(await runtime.execute(session.id, { action: "evaluate", expression: "document.querySelector('main').textContent" }, actor), "Account ready");
});

for (const action of ["navigate", "newTab"] as const) {
  test(`SSO completion after ${action} is bounded to identity and application origins`, { timeout: 30_000 }, async t => {
    let port = 0;
    const sso = http.createServer((request, response) => {
      if (request.url === "/sso") { response.writeHead(302, { location: `http://localhost:${port}/login` }); response.end(); return; }
      response.setHeader("content-type", "text/html");
      response.end(request.url === "/ready" ? "<h1>Authenticated application</h1>" : '<form><input type="email"><input type="password"><button>Sign in</button></form>');
    });
    port = await listen(sso); const appOrigin = `http://127.0.0.1:${port}`; const identityOrigin = `http://localhost:${port}`;
    const unrelated = http.createServer((_request, response) => { response.setHeader("content-type", "text/html"); response.end("<h1>Authenticated application</h1>"); });
    const unrelatedPort = await listen(unrelated); const unrelatedOrigin = `http://127.0.0.1:${unrelatedPort}`;
    const runtime = new BrowserRuntime({ capability }); t.after(async () => { await runtime.close(); close(sso); close(unrelated); });
    const session = await runtime.create(start("pi", unrelatedOrigin, `sso-bounds-${action}`));
    await runtime.execute(session.id, { action, url: `${appOrigin}/sso` }, agent());
    const paused = await pending(t, runtime, session.id);
    assert.equal(paused.loginRequest!.expectedOrigin, identityOrigin);
    assert.equal(paused.loginRequest!.returnOrigin, appOrigin);
    assert.notEqual(paused.loginRequest!.returnOrigin, unrelatedOrigin);
    await runtime.execute(session.id, { action: "takeControl", loginRequestId: paused.loginRequest!.id }, human);
    await runtime.execute(session.id, { action: "navigate", url: unrelatedOrigin }, human);
    assert.equal(await runtime.execute(session.id, { action: "evaluate", expression: "document.body.innerText" }, human), "Authenticated application");
    const done = () => runtime.execute(session.id, { action: "completeLogin", requestId: paused.loginRequest!.id, expectedPageId: paused.activePageId! }, human);
    await assert.rejects(done(), /could not be verified/i);
    await runtime.execute(session.id, { action: "navigate", url: `${appOrigin}/ready` }, human);
    const completed = await done() as Awaited<ReturnType<BrowserRuntime["get"]>>;
    assert.equal(completed.loginRequest, null); assert.equal(completed.owner, "agent");
  });
}
