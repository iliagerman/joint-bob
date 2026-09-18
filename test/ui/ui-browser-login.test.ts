import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { WebSocketRoute } from "playwright-core";
import { signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const ownerNodeId = "22222222-2222-4222-8222-222222222222";
const pageId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const backgroundProjectId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const backgroundConversationId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const backgroundAppNodeId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function replaceExactly(source: string, marker: string, replacement: string, expected = 1) {
  assert.equal(source.split(marker).length - 1, expected, `fault marker drifted: ${marker}`);
  return source.split(marker).join(replacement);
}

test("pending browser login popup preserves ownership through failure, dismissal, reopen, and stale responses", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const errors: string[] = [], commands: any[] = [], discoveries: URL[] = [], sockets: URL[] = [], inputs: any[] = [];
  const liveSockets = new Set<WebSocketRoute>();
  page.on("pageerror", error => errors.push(error.message));
  await page.clock.install();

  const fault = process.env.LOGIN_UI_FAULT;
  if (fault) {
    assert.ok(["dismiss", "stale", "premature"].includes(fault), `unsupported LOGIN_UI_FAULT: ${fault}`);
    for (const file of ["browser-login.js", "browser-viewer.js"]) {
      let source = await readFile(`public/app/${file}`, "utf8");
      if (fault === "dismiss" && file === "browser-login.js") source = replaceExactly(source, "  current.viewer?.dispose();", "  if (markDismissed) void api('/api/browser/sessions/'+encodeURIComponent(current.sessionId)+'/command?nodeId='+encodeURIComponent(current.nodeId),{method:'POST',body:JSON.stringify({action:'resumeAgent'})}).catch(()=>{});\n  current.viewer?.dispose();");
      if (fault === "stale" && file === "browser-viewer.js") {
        const count = source.split("isCurrent()").length - 1;
        assert.ok(count > 0, "fault marker drifted: viewer isCurrent() invocations");
        source = source.split("isCurrent()").join("true");
      }
      if (fault === "stale" && file === "browser-login.js") source = replaceExactly(source, "      if (identityKey(identity()) !== current.identityKey) { removePopup(current, false); return; }\n", "");
      if (fault === "premature" && file === "browser-viewer.js") source = replaceExactly(source, "return command({ action: \"completeLogin\", requestId: target.requestId, expectedPageId: target.expectedPageId });", "const pending = command({ action: \"completeLogin\", requestId: target.requestId, expectedPageId: target.expectedPageId }); onClose?.(); return pending;");
      if ((fault === "dismiss" && file === "browser-login.js") || fault === "stale" || (fault === "premature" && file === "browser-viewer.js")) {
        await page.route(`**/app/${file}`, route => route.fulfill({ contentType: "text/javascript", body: source }));
      }
    }
  }

  const frame = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 1200; canvas.height = 800;
    const context = canvas.getContext("2d")!; context.fillStyle = "#eef4ff"; context.fillRect(0, 0, 1200, 800);
    context.fillStyle = "#17345c"; context.font = "48px sans-serif"; context.fillText("Synthetic sign-in", 80, 140);
    return canvas.toDataURL("image/jpeg", .85).split(",")[1];
  });
  await page.addInitScript(() => {
    const target = window as any; target.__loginHttpCommands = []; target.__loginWsCommands = [];
    const nativeFetch = window.fetch;
    window.fetch = function(input: RequestInfo | URL, init?: RequestInit) {
      const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, location.href);
      if (/^\/api\/browser\/sessions\/[^/]+\/command$/.test(url.pathname) && init?.body && typeof init.body === "string") target.__loginHttpCommands.push(JSON.parse(init.body));
      return nativeFetch.call(this, input, init);
    };
    const nativeSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      if (typeof data === "string") { try { const message = JSON.parse(data); if (message.type === "browserCommand") target.__loginWsCommands.push(message.command); } catch {} }
      return nativeSend.call(this, data);
    };
  });

  const backgroundIdentity = { projectId: backgroundProjectId, engine: "kiro", conversationId: backgroundConversationId, appNodeId: backgroundAppNodeId };
  let verified = false;
  let receivedInput: ((command: any) => void) | undefined;
  let inputReceived = new Promise<any>(resolve => { receivedInput = resolve; });
  let holdExact = false, releaseExact: (() => void) | undefined, enteredExact: (() => void) | undefined;
  let exactRelease = Promise.resolve(), exactEntered = Promise.resolve();
  const session: any = {
    id: sessionId, nodeId: ownerNodeId, state: "running", owner: "agent", canControl: true,
    profileId: "55555555-5555-4555-8555-555555555555", profileLabel: "Synthetic login",
    activePageId: pageId, tabs: [{ id: pageId, title: "Sign in", url: "https://accounts.example.test/login" }], downloads: [],
    loginRequest: { id: requestId, expectedOrigin: "https://accounts.example.test", readySelector: "body", loginSelector: "input", label: "Synthetic login", automatic: true },
    ...backgroundIdentity,
  };
  const snapshot = () => ({ ...session });
  const broadcast = () => { for (const ws of liveSockets) ws.send(JSON.stringify({ type: "browserState", session: snapshot() })); };
  await page.route("**/api/browser/**", async route => {
    const request = route.request(), url = new URL(request.url());
    let result: any = {};
    if (url.pathname === "/api/browser/sessions" && request.method() === "GET") {
      discoveries.push(url);
      const unfiltered = !url.search;
      const scopedToSession = url.searchParams.get("projectId") === session.projectId
        && url.searchParams.get("engine") === session.engine
        && url.searchParams.get("conversationId") === session.conversationId;
      result = { sessions: unfiltered || scopedToSession ? [snapshot()] : [] };
    } else if (url.pathname === `/api/browser/sessions/${sessionId}`) {
      assert.equal(url.searchParams.get("nodeId"), ownerNodeId);
      result = { session: snapshot() };
      if (holdExact) { enteredExact?.(); await exactRelease; }
    } else if (url.pathname.endsWith("/command")) {
      assert.equal(url.searchParams.get("nodeId"), ownerNodeId);
      const command = request.postDataJSON(); commands.push(command);
      if (command.action === "takeControl") {
        if (command.loginRequestId) assert.equal(command.loginRequestId, session.loginRequest?.id, "takeControl must bind the current login request");
        if (session.owner === "human" && session.canControl === false && command.force !== true) return void await route.fulfill({ status: 409, json: { error: "Another human controls this browser" } });
        session.owner = "human"; session.canControl = true;
      }
      if (command.action === "completeLogin") {
        assert.equal(command.requestId, session.loginRequest?.id); assert.equal(command.expectedPageId, pageId);
        if (!verified) return void await route.fulfill({ status: 409, json: { error: "Login could not be verified; browser remains paused" } });
        session.loginRequest = null; session.owner = "agent"; session.canControl = true;
      }
      result = { session: snapshot() }; broadcast();
    } else if (url.pathname === "/api/browser/status") result = { config: { executorNodeId: node.nodeId }, nodes: [{ id: ownerNodeId, name: "Owner", available: true, reachable: true, runningCount: 1 }] };
    else if (url.pathname === "/api/browser/preferences") result = { nodeId: null, effectiveNodeId: ownerNodeId };
    else if (url.pathname === "/api/browser/profiles") result = { profiles: [] };
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket(/\/ws\?mode=browser/, ws => {
    const url = new URL(ws.url()); assert.equal(url.searchParams.get("browserSessionId"), sessionId); assert.equal(url.searchParams.get("nodeId"), ownerNodeId);
    sockets.push(url); liveSockets.add(ws);
    ws.onClose(() => liveSockets.delete(ws));
    ws.onMessage(message => { const envelope = JSON.parse(String(message)); if (envelope.type === "browserCommand") { inputs.push(envelope.command); receivedInput?.(envelope.command); } });
    ws.send(JSON.stringify({ type: "browserState", session: snapshot() }));
    ws.send(JSON.stringify({ type: "browserFrame", pageId, width: 1200, height: 800, data: frame }));
  });

  const login = await signIn(environment, node);
  await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
  let staleObserverInstalled = false;
  try {
    await page.goto(node.url);
    session.loginRequest = { ...session.loginRequest, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" };
    const dialog = page.getByTestId("browser-login-panel");
    await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged")));
    await dialog.waitFor();
    await dialog.getByTestId("browser-login-context").filter({ hasText: `Synthetic login · ${backgroundProjectId} · kiro · ${backgroundConversationId}` }).waitFor();
    await dialog.getByText("The agent checks the signed-in page next.", { exact: false }).waitFor();
    // Native-feeling sign-in: the live page fills the panel and browsing chrome stays out of the way.
    await dialog.getByTestId("browser-screen").waitFor();
    await dialog.getByTestId("browser-reload").waitFor();
    for (const hidden of ["browser-url", "browser-go", "browser-new-tab", "browser-forward", "browser-downloads-details", "browser-end"])
      await dialog.getByTestId(hidden).waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => import("/app/state.js").then(({ state }) => [state.activeProjectId, state.activeConversationId, state.activeSessionId])), [null, null, null], "background discovery must not select a conversation");
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });

    session.loginRequest = { ...session.loginRequest, id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" };
    await page.evaluate(() => { document.body.classList.add("view-board"); document.dispatchEvent(new Event("browserSessionsChanged")); });
    await dialog.waitFor();
    await dialog.getByTestId("browser-login-context").filter({ hasText: "kiro" }).waitFor();
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
    session.loginRequest = { ...session.loginRequest, id: "ffffffff-ffff-4fff-8fff-ffffffffffff" };
    await page.evaluate(() => { document.body.classList.remove("view-board"); document.body.classList.add("view-canvas"); document.dispatchEvent(new Event("browserSessionsChanged")); });
    await dialog.waitFor();
    await dialog.getByTestId("browser-login-context").filter({ hasText: backgroundConversationId }).waitFor();
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
    await page.evaluate(() => document.body.classList.remove("view-canvas"));

    await page.locator("#projectList").getByText("Internal Assistant", { exact: true }).click();
    await page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Short one" }) }).first().click();
    await page.locator("#sessionTitle").filter({ hasText: "Short one" }).waitFor();
    const activeIdentity = await page.evaluate(async () => { const { state } = await import("/app/state.js"); return { projectId: state.activeProjectId, engine: state.engine, conversationId: state.activeConversationId || state.activeSessionId, appNodeId: state.conversationLock?.nodeId || state.activeNodeId }; });
    assert.notEqual(activeIdentity.projectId, backgroundIdentity.projectId);
    assert.notEqual(activeIdentity.conversationId, backgroundIdentity.conversationId);
    session.loginRequest = { ...session.loginRequest, id: "12121212-1212-4121-8121-121212121212" }; session.owner = "agent"; session.canControl = true;
    await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged")));
    await dialog.waitFor();
    await dialog.getByTestId("browser-login-context").filter({ hasText: `Synthetic login · ${backgroundProjectId} · kiro · ${backgroundConversationId}` }).waitFor();
    assert.deepEqual(await page.evaluate(() => import("/app/state.js").then(({ state }) => [state.activeProjectId, state.activeConversationId || state.activeSessionId])), [activeIdentity.projectId, activeIdentity.conversationId], "background popup must not change the selected conversation");
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });

    Object.assign(session, activeIdentity);
    session.loginRequest = { id: requestId, expectedOrigin: "https://accounts.example.test", readySelector: "[data-authenticated]", loginSelector: "input", label: "Synthetic login", automatic: false };
    session.owner = "agent"; session.canControl = true;
    await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged")));
    await dialog.waitFor();
    await dialog.getByTestId("browser-login-context").filter({ hasText: `Synthetic login · ${activeIdentity.projectId} · ${activeIdentity.engine} · ${activeIdentity.conversationId}` }).waitFor();
    await dialog.getByTestId("browser-screen").waitFor({ state: "visible" });
    await dialog.getByTestId("browser-control-status").filter({ hasText: "Human control" }).waitFor();
    assert.deepEqual(commands.filter(command => command.action === "takeControl" && command.loginRequestId === requestId), [{ action: "takeControl", loginRequestId: requestId }]);
    broadcast(); broadcast();
    await dialog.getByTestId("browser-control-status").filter({ hasText: "Human control" }).waitFor();
    assert.equal(commands.filter(command => command.action === "takeControl" && command.loginRequestId === requestId).length, 1, "repeated pending state must not retake control");
    await page.waitForFunction(element => !(element as HTMLButtonElement).disabled, await dialog.getByTestId("browser-login-done").elementHandle());
    await dialog.getByTestId("browser-screen").focus();
    await dialog.getByTestId("browser-screen").evaluate(element => element.dispatchEvent(new KeyboardEvent("keydown", { key: "A", bubbles: true, cancelable: true })));
    assert.deepEqual(await inputReceived, { action: "key", key: "A", expectedPageId: pageId });
    assert.deepEqual(inputs.find(command => command.action === "key"), { action: "key", key: "A", expectedPageId: pageId });
    assert.equal(await page.getByTestId("chat-message-input").inputValue(), "", "remote keyboard input must not type into or send app chat");

    await dialog.getByTestId("browser-login-done").click();
    assert.equal(await dialog.count(), 1, "failed verification must keep the login dialog open");
    await dialog.getByTestId("browser-error").filter({ hasText: "Login could not be verified; browser remains paused" }).waitFor();
    assert.equal(session.loginRequest.id, requestId); assert.equal(session.owner, "human");
    assert.equal(commands.some(command => command.action === "resumeAgent"), false);

    const checkGeometry = async () => {
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const geometry = await dialog.evaluate(element => { const rect = element.getBoundingClientRect(); return { width: rect.width, height: rect.height, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth }; });
      assert.ok(geometry.width > 0 && geometry.height > 0 && geometry.left >= 0 && geometry.top >= 0 && geometry.right <= geometry.viewportWidth && geometry.bottom <= geometry.viewportHeight, `login dialog must fit viewport: ${JSON.stringify(geometry)}`);
      assert.equal(geometry.overflow, false, "login dialog must not overflow horizontally");
      await dialog.getByTestId("browser-login-done").waitFor({ state: "visible" }); await dialog.getByTestId("browser-close-viewer").waitFor({ state: "visible" });
    };
    await page.setViewportSize({ width: 1440, height: 900 }); await checkGeometry(); await page.screenshot({ path: path.resolve("tmp/login-popup-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 }); await checkGeometry(); await page.screenshot({ path: path.resolve("tmp/login-popup-mobile.png") });
    await page.setViewportSize({ width: 1440, height: 900 });

    await dialog.getByTestId("browser-screen").focus(); await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });
    const capturedAfterEscape = await page.evaluate(() => ({ http: (window as any).__loginHttpCommands, ws: (window as any).__loginWsCommands }));
    assert.equal(capturedAfterEscape.ws.some((command: any) => command.action === "key" && command.key === "Escape"), false, "Escape must not be sent to the remote browser");
    assert.equal(capturedAfterEscape.http.some((command: any) => command.action === "resumeAgent"), false, "dismissing login must not resume the agent");
    assert.equal(capturedAfterEscape.http.some((command: any) => command.action === "close"), false, "dismissing login must not close the browser");
    assert.equal(session.loginRequest.id, requestId); assert.equal(session.owner, "human");
    const dismissedDiscovery = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/browser/sessions");
    await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged"))); await (await dismissedDiscovery).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await dialog.count(), 0, "dismissed request must not reopen");

    if (await page.getByTestId("chat-more-button").isVisible()) await page.getByTestId("chat-more-button").click();
    await page.getByTestId("chat-open-browser-button").click();
    const panel = page.locator("#browserPanel"); await panel.getByTestId("browser-screen").waitFor({ state: "visible" }); await panel.getByTestId("browser-login-done").waitFor();
    verified = true; await panel.getByTestId("browser-login-done").click(); await panel.getByTestId("browser-login-notice").waitFor({ state: "hidden" }); await panel.getByTestId("browser-control-status").filter({ hasText: "Agent control" }).waitFor();
    assert.deepEqual(commands.findLast(command => command.action === "completeLogin"), { action: "completeLogin", requestId, expectedPageId: pageId });
    await panel.getByTestId("browser-close-viewer").click(); await panel.waitFor({ state: "detached" });

    const secondRequestId = "66666666-6666-4666-8666-666666666666";
    session.loginRequest = { id: secondRequestId, expectedOrigin: "https://accounts.example.test", label: "Second login" }; session.owner = "agent"; session.canControl = true; verified = false;
    await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged"))); await dialog.waitFor(); await dialog.getByTestId("browser-screen").waitFor({ state: "visible" });
    await dialog.getByTestId("browser-control-status").filter({ hasText: "Human control" }).waitFor();
    assert.equal(commands.filter(command => command.action === "takeControl" && command.loginRequestId === secondRequestId).length, 1);
    await dialog.getByTestId("browser-close-viewer").click(); await dialog.waitFor({ state: "detached" });
    assert.equal(session.loginRequest.id, secondRequestId); assert.equal(commands.some(command => command.action === "close" || command.action === "resumeAgent"), false);

    const otherHumanRequestId = "77777777-7777-4777-8777-777777777777";
    session.loginRequest = { id: otherHumanRequestId, expectedOrigin: "https://accounts.example.test", label: "Other viewer login" }; session.owner = "human"; session.canControl = false;
    await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged"))); await dialog.waitFor(); await dialog.getByTestId("browser-connection-status").filter({ hasText: "Live" }).waitFor();
    await dialog.getByTestId("browser-take-control").filter({ hasText: "Take over control" }).waitFor();
    assert.equal(await dialog.getByTestId("browser-login-done").isDisabled(), true);
    const beforeOtherDismiss = await page.evaluate(() => (window as any).__loginHttpCommands.slice());
    assert.equal(beforeOtherDismiss.some((command: any) => command.action === "takeControl" && command.loginRequestId === otherHumanRequestId), false, "another human's request must not be taken automatically");
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "detached" });

    await page.clock.pauseAt(new Date(Date.now() + 60_000));
    const staleRequestId = "88888888-8888-4888-8888-888888888888";
    session.loginRequest = { id: staleRequestId, expectedOrigin: "https://accounts.example.test", label: "Late exact response" }; session.owner = "agent"; session.canControl = true;
    holdExact = true; exactEntered = new Promise(resolve => { enteredExact = resolve; }); exactRelease = new Promise(resolve => { releaseExact = resolve; });
    const staleResponse = page.waitForResponse(response => new URL(response.url()).pathname === `/api/browser/sessions/${sessionId}`);
    await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged"))); await exactEntered;
    await page.evaluate(() => import("/app/state.js").then(({ state }) => { state.activeConversationId = "99999999-9999-4999-8999-999999999999"; }));
    await page.evaluate(() => {
      const dialog = document.querySelector('[data-testid="browser-login-panel"]')!;
      (window as any).__staleOutcome = new Promise(resolve => {
        const observer = new MutationObserver(() => {
          const outcome = !dialog.isConnected ? "closed" : dialog.querySelector('[data-testid="browser-control-status"]')?.textContent?.includes("Human control") ? "takeover" : null;
          if (outcome) { observer.disconnect(); (window as any).__staleObserver = null; resolve(outcome); }
        });
        (window as any).__staleObserver = observer;
        const outcome = !dialog.isConnected ? "closed" : dialog.querySelector('[data-testid="browser-control-status"]')?.textContent?.includes("Human control") ? "takeover" : null;
        if (outcome) resolve(outcome); else observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
      });
    });
    staleObserverInstalled = true; releaseExact(); releaseExact = undefined;
    await (await staleResponse).finished();
    const staleOutcome = await page.evaluate(() => (window as any).__staleOutcome);
    assert.equal(staleOutcome, "closed", "late exact-session response for the previous identity must close the popup before takeover");
    const finalCaptured = await page.evaluate(() => (window as any).__loginHttpCommands);
    assert.equal(finalCaptured.some((command: any) => command.action === "takeControl" && command.loginRequestId === staleRequestId), false, "late exact-session response must not take control");
    assert.ok(discoveries.some(url => !url.search), "coordinator discovery must be unfiltered");
    assert.ok(discoveries.some(url => url.searchParams.get("projectId") === backgroundIdentity.projectId && url.searchParams.get("engine") === "kiro" && url.searchParams.get("conversationId") === backgroundIdentity.conversationId), "viewer discovery must use the pending session identity");
    assert.ok(discoveries.every(url => !url.search || [backgroundIdentity.conversationId, activeIdentity.conversationId].includes(url.searchParams.get("conversationId") || "")), "scoped discovery must bind a viewer's session identity");
    assert.ok(sockets.length > 0); assert.deepEqual(errors, []);
  } finally {
    releaseExact?.();
    if (staleObserverInstalled) await page.evaluate(() => { (window as any).__staleObserver?.disconnect(); (window as any).__staleObserver = null; }).catch(() => {});
    await page.clock.resume().catch(() => {});
  }
});

test("signing out during global browser discovery cannot mount or control a late popup", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const login = await signIn(environment, node);
  await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
  await page.goto(node.url);
  await page.getByText("Internal Assistant", { exact: true }).waitFor();

  let releaseDiscovery!: () => void;
  let discoveryEntered!: () => void;
  const held = new Promise<void>(resolve => { releaseDiscovery = resolve; });
  const entered = new Promise<void>(resolve => { discoveryEntered = resolve; });
  let takeControlRequests = 0;
  await page.route("**/api/browser/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/browser/sessions" && request.method() === "GET") {
      discoveryEntered();
      await held;
      await route.fulfill({ json: { sessions: [{
        id: sessionId, nodeId: ownerNodeId, state: "running", owner: "agent", canControl: true,
        projectId: backgroundProjectId, engine: "kiro", conversationId: backgroundConversationId, appNodeId: backgroundAppNodeId,
        activePageId: pageId, tabs: [{ id: pageId, title: "Sign in", url: "https://accounts.example.test/login" }], downloads: [],
        loginRequest: { id: requestId, expectedOrigin: "https://accounts.example.test", readySelector: "body", automatic: true },
      }] } });
      return;
    }
    if (url.pathname.endsWith("/command") && request.postDataJSON()?.action === "takeControl") takeControlRequests++;
    await route.fallback();
  });

  const response = page.waitForResponse(response => response.request().method() === "GET" && new URL(response.url()).pathname === "/api/browser/sessions");
  await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged")));
  await entered;
  await page.evaluate(() => import("/app/auth.js").then(({ showSignedOut }) => showSignedOut()));
  releaseDiscovery();
  await (await response).finished();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.getByTestId("browser-login-panel").count(), 0, "late discovery after logout must not mount a browser login popup");
  assert.equal(takeControlRequests, 0, "late discovery after logout must not take browser control");
});
