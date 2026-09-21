import assert from "node:assert/strict";
import test from "node:test";
import type { WebSocketRoute } from "playwright-core";
import { signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

const sessionId = "11111111-1111-4111-8111-111111111111";
const ownerNodeId = "22222222-2222-4222-8222-222222222222";
const pageId = "33333333-3333-4333-8333-333333333333";
const requestId = "44444444-4444-4444-8444-444444444444";
const frameWidth = 1200, frameHeight = 800;

// The remote browser launches desktop-sized, so on a phone the sign-in page
// arrives as a shrunken desktop layout: unreadable text and untappable fields.
// When the sign-in handoff starts on a narrow screen, the viewer asks the
// remote page to shrink to phone dimensions so the site serves its mobile
// layout instead.
test("sign-in on a phone resizes the remote page to phone dimensions", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const liveSockets = new Set<WebSocketRoute>();
  const commands: any[] = [];

  const frame = await page.evaluate(([width, height]) => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d")!; context.fillStyle = "#eef4ff"; context.fillRect(0, 0, width, height);
    context.fillStyle = "#17345c"; context.font = "48px sans-serif"; context.fillText("Synthetic sign-in", 80, 140);
    return canvas.toDataURL("image/jpeg", .85).split(",")[1];
  }, [frameWidth, frameHeight]);

  const session: any = {
    id: sessionId, nodeId: ownerNodeId, state: "running", owner: "agent", canControl: true,
    profileId: "55555555-5555-4555-8555-555555555555", profileLabel: "Synthetic login",
    activePageId: pageId, tabs: [{ id: pageId, title: "Sign in", url: "https://accounts.example.test/login" }], downloads: [],
    loginRequest: { id: requestId, expectedOrigin: "https://accounts.example.test", readySelector: "[data-authenticated]", loginSelector: "input", label: "Synthetic login", automatic: false },
  };
  const snapshot = () => ({ ...session });
  await page.route("**/api/browser/**", async route => {
    const url = new URL(route.request().url());
    let result: any = {};
    if (url.pathname === "/api/browser/sessions" && route.request().method() === "GET") result = { sessions: [snapshot()] };
    else if (url.pathname === `/api/browser/sessions/${sessionId}`) result = { session: snapshot() };
    else if (url.pathname.endsWith("/command")) {
      const command = route.request().postDataJSON();
      commands.push(command);
      if (command.action === "takeControl") { session.owner = "human"; session.canControl = true; }
      result = { session: snapshot() };
    } else if (url.pathname === "/api/browser/status") result = { config: { executorNodeId: node.nodeId }, nodes: [{ id: ownerNodeId, name: "Owner", available: true, reachable: true, runningCount: 1 }] };
    else if (url.pathname === "/api/browser/preferences") result = { nodeId: null, effectiveNodeId: ownerNodeId };
    else if (url.pathname === "/api/browser/profiles") result = { profiles: [] };
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket(/\/ws\?mode=browser/, ws => {
    liveSockets.add(ws);
    ws.onClose(() => liveSockets.delete(ws));
    ws.send(JSON.stringify({ type: "browserState", session: snapshot() }));
    ws.send(JSON.stringify({ type: "browserFrame", pageId, width: frameWidth, height: frameHeight, data: frame }));
  });

  const login = await signIn(environment, node);
  await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
  await page.goto(node.url);
  await page.locator("#projectList").getByText("Internal Assistant", { exact: true }).click();
  await page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Short one" }) }).first().click();
  await page.locator("#sessionTitle").filter({ hasText: "Short one" }).waitFor();

  // The panel mounts on a phone-sized screen: the size decision reads the real window.
  await page.setViewportSize({ width: 412, height: 730 });

  const activeIdentity = await page.evaluate(async () => { const { state } = await import("/app/state.js"); return { projectId: state.activeProjectId, engine: state.engine, conversationId: state.activeConversationId || state.activeSessionId, appNodeId: state.conversationLock?.nodeId || state.activeNodeId }; });
  Object.assign(session, activeIdentity);
  await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged")));

  const dialog = page.getByTestId("browser-login-panel");
  await dialog.waitFor();
  await dialog.getByTestId("browser-screen").waitFor({ state: "visible" });

  // The handoff auto-takes control, then asks for a phone-sized remote page.
  await page.waitForFunction(() => true);
  for (let i = 0; i < 100 && !commands.some(c => c.action === "setViewport"); i++) await new Promise(r => setTimeout(r, 100));
  const takeControl = commands.findIndex(c => c.action === "takeControl");
  const setViewport = commands.findIndex(c => c.action === "setViewport");
  assert.ok(takeControl >= 0, "handoff must take control automatically");
  assert.ok(setViewport > takeControl, "viewer must request a phone-sized page after taking control");
  const resize = commands[setViewport];
  assert.ok(resize.width >= 320 && resize.width < 700, `remote width must be phone-sized: ${resize.width}`);
  assert.ok(resize.height >= 480 && resize.height <= 2000, `remote height must be phone-sized: ${resize.height}`);

  // On a phone the embedded strip is a few pixels tall once the keyboard
  // opens; the sign-in starts as the full-screen popup with only the page.
  const fullscreen = await dialog.evaluate(element => element.classList.contains("browser-login-fullscreen"));
  assert.equal(fullscreen, true, "a phone sign-in must open in full-screen mode");
  const exitLabel = await dialog.getByTestId("browser-login-expand").textContent();
  assert.equal(exitLabel, "Exit full screen", "the expand button must offer the way back");

  // The on-screen keyboard shrinks the window; the remote page must follow so
  // the focused field is never hidden below the visible area.
  const before = commands.filter(c => c.action === "setViewport").length;
  await page.setViewportSize({ width: 412, height: 360 });
  for (let i = 0; i < 100 && commands.filter(c => c.action === "setViewport").length === before; i++) await new Promise(r => setTimeout(r, 100));
  const shrunk = commands.filter(c => c.action === "setViewport").at(-1);
  assert.ok(commands.filter(c => c.action === "setViewport").length > before, "a shrinking window must re-request the remote page size");
  assert.ok(shrunk.height <= 400, `the remote page must follow the keyboard-shrunk height: ${shrunk.height}`);
});

// A handoff can be held by a stale controller identity: the same person's
// earlier connection through another app node took control, and their current
// viewer is treated as a spectator — input ignored, no way to dismiss, agent
// paused. The viewer showing this conversation's own sign-in handoff must take
// over from the stale controller automatically.
test("a handoff held by a stale controller is taken over automatically", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const commands: any[] = [];

  const frame = await page.evaluate(([width, height]) => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d")!; context.fillStyle = "#eef4ff"; context.fillRect(0, 0, width, height);
    return canvas.toDataURL("image/jpeg", .85).split(",")[1];
  }, [frameWidth, frameHeight]);

  const session: any = {
    id: sessionId, nodeId: ownerNodeId, state: "running", owner: "human", canControl: false,
    profileId: "55555555-5555-4555-8555-555555555555", profileLabel: "Synthetic login",
    activePageId: pageId, tabs: [{ id: pageId, title: "Sign in", url: "https://accounts.example.test/login" }], downloads: [],
    loginRequest: { id: requestId, expectedOrigin: "https://accounts.example.test", readySelector: "[data-authenticated]", loginSelector: "input", label: "Synthetic login", automatic: false },
  };
  const snapshot = () => ({ ...session });
  await page.route("**/api/browser/**", async route => {
    const url = new URL(route.request().url());
    let result: any = {};
    if (url.pathname === "/api/browser/sessions" && route.request().method() === "GET") result = { sessions: [snapshot()] };
    else if (url.pathname === `/api/browser/sessions/${sessionId}`) result = { session: snapshot() };
    else if (url.pathname.endsWith("/command")) {
      const command = route.request().postDataJSON();
      commands.push(command);
      if (command.action === "takeControl") session.canControl = true;
      result = { session: snapshot() };
    } else if (url.pathname === "/api/browser/status") result = { config: { executorNodeId: node.nodeId }, nodes: [{ id: ownerNodeId, name: "Owner", available: true, reachable: true, runningCount: 1 }] };
    else if (url.pathname === "/api/browser/preferences") result = { nodeId: null, effectiveNodeId: ownerNodeId };
    else if (url.pathname === "/api/browser/profiles") result = { profiles: [] };
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket(/\/ws\?mode=browser/, ws => {
    ws.send(JSON.stringify({ type: "browserState", session: snapshot() }));
    ws.send(JSON.stringify({ type: "browserFrame", pageId, width: frameWidth, height: frameHeight, data: frame }));
  });

  const login = await signIn(environment, node);
  await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
  await page.goto(node.url);
  await page.locator("#projectList").getByText("Internal Assistant", { exact: true }).click();
  await page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Short one" }) }).first().click();
  await page.locator("#sessionTitle").filter({ hasText: "Short one" }).waitFor();
  await page.setViewportSize({ width: 412, height: 730 });

  const activeIdentity = await page.evaluate(async () => { const { state } = await import("/app/state.js"); return { projectId: state.activeProjectId, engine: state.engine, conversationId: state.activeConversationId || state.activeSessionId, appNodeId: state.conversationLock?.nodeId || state.activeNodeId }; });
  Object.assign(session, activeIdentity);
  await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged")));

  const dialog = page.getByTestId("browser-login-panel");
  await dialog.waitFor();
  await dialog.getByTestId("browser-screen").waitFor({ state: "visible" });

  for (let i = 0; i < 100 && !commands.some(c => c.action === "setViewport"); i++) await new Promise(r => setTimeout(r, 100));
  const takeControl = commands.findIndex(c => c.action === "takeControl");
  assert.ok(takeControl >= 0, "the viewer must take over the stale controller's handoff");
  assert.equal(commands[takeControl].force, true, "replacing another controller requires force");
  assert.ok(commands.findIndex(c => c.action === "setViewport") > takeControl, "the phone-sized page must follow the takeover");
});

// A sign-in handoff that already granted control before this code loaded (an
// older app version took control, or the panel reopened) must still get the
// phone-sized remote page: the resize belongs to showing the handoff on a
// narrow screen, not to the moment control was taken.
test("a handoff already under human control still gets a phone-sized page", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const commands: any[] = [];

  const frame = await page.evaluate(([width, height]) => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d")!; context.fillStyle = "#eef4ff"; context.fillRect(0, 0, width, height);
    return canvas.toDataURL("image/jpeg", .85).split(",")[1];
  }, [frameWidth, frameHeight]);

  const session: any = {
    id: sessionId, nodeId: ownerNodeId, state: "running", owner: "human", canControl: true,
    profileId: "55555555-5555-4555-8555-555555555555", profileLabel: "Synthetic login",
    activePageId: pageId, tabs: [{ id: pageId, title: "Sign in", url: "https://accounts.example.test/login" }], downloads: [],
    loginRequest: { id: requestId, expectedOrigin: "https://accounts.example.test", readySelector: "[data-authenticated]", loginSelector: "input", label: "Synthetic login", automatic: false },
  };
  const snapshot = () => ({ ...session });
  await page.route("**/api/browser/**", async route => {
    const url = new URL(route.request().url());
    let result: any = {};
    if (url.pathname === "/api/browser/sessions" && route.request().method() === "GET") result = { sessions: [snapshot()] };
    else if (url.pathname === `/api/browser/sessions/${sessionId}`) result = { session: snapshot() };
    else if (url.pathname.endsWith("/command")) { commands.push(route.request().postDataJSON()); result = { session: snapshot() }; }
    else if (url.pathname === "/api/browser/status") result = { config: { executorNodeId: node.nodeId }, nodes: [{ id: ownerNodeId, name: "Owner", available: true, reachable: true, runningCount: 1 }] };
    else if (url.pathname === "/api/browser/preferences") result = { nodeId: null, effectiveNodeId: ownerNodeId };
    else if (url.pathname === "/api/browser/profiles") result = { profiles: [] };
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket(/\/ws\?mode=browser/, ws => {
    ws.send(JSON.stringify({ type: "browserState", session: snapshot() }));
    ws.send(JSON.stringify({ type: "browserFrame", pageId, width: frameWidth, height: frameHeight, data: frame }));
  });

  const login = await signIn(environment, node);
  await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
  await page.goto(node.url);
  await page.locator("#projectList").getByText("Internal Assistant", { exact: true }).click();
  await page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Short one" }) }).first().click();
  await page.locator("#sessionTitle").filter({ hasText: "Short one" }).waitFor();
  await page.setViewportSize({ width: 412, height: 730 });

  const activeIdentity = await page.evaluate(async () => { const { state } = await import("/app/state.js"); return { projectId: state.activeProjectId, engine: state.engine, conversationId: state.activeConversationId || state.activeSessionId, appNodeId: state.conversationLock?.nodeId || state.activeNodeId }; });
  Object.assign(session, activeIdentity);
  await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged")));

  const dialog = page.getByTestId("browser-login-panel");
  await dialog.waitFor();
  await dialog.getByTestId("browser-screen").waitFor({ state: "visible" });

  for (let i = 0; i < 100 && !commands.some(c => c.action === "setViewport"); i++) await new Promise(r => setTimeout(r, 100));
  const resize = commands.find(c => c.action === "setViewport");
  assert.ok(resize, "an already-controlled handoff must still request a phone-sized page");
  assert.ok(resize.width >= 320 && resize.width < 700, `remote width must be phone-sized: ${resize.width}`);
  assert.ok(!commands.some(c => c.action === "takeControl"), "control is already held; the viewer must not take it again");
});

// While an HTTP command is in flight the viewer sets its busy flag. The busy
// flag must not disable the typing proxy: disabling blurs it, and a phone
// closes its on-screen keyboard the instant the field blurs.
test("typing keeps focus while a slow command is in flight", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);

  const frame = await page.evaluate(([width, height]) => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d")!; context.fillStyle = "#eef4ff"; context.fillRect(0, 0, width, height);
    return canvas.toDataURL("image/jpeg", .85).split(",")[1];
  }, [frameWidth, frameHeight]);

  const session: any = {
    id: sessionId, nodeId: ownerNodeId, state: "running", owner: "human", canControl: true,
    profileId: "55555555-5555-4555-8555-555555555555", profileLabel: "Synthetic login",
    activePageId: pageId, tabs: [{ id: pageId, title: "Sign in", url: "https://accounts.example.test/login" }], downloads: [],
    loginRequest: { id: requestId, expectedOrigin: "https://accounts.example.test", readySelector: "[data-authenticated]", loginSelector: "input", label: "Synthetic login", automatic: false },
  };
  const snapshot = () => ({ ...session });
  await page.route("**/api/browser/**", async route => {
    const url = new URL(route.request().url());
    let result: any = {};
    if (url.pathname === "/api/browser/sessions" && route.request().method() === "GET") result = { sessions: [snapshot()] };
    else if (url.pathname === `/api/browser/sessions/${sessionId}`) result = { session: snapshot() };
    else if (url.pathname.endsWith("/command")) {
      // Every command crawls: the busy window is wide open while typing happens.
      await new Promise(r => setTimeout(r, 1500));
      result = { session: snapshot() };
    } else if (url.pathname === "/api/browser/status") result = { config: { executorNodeId: node.nodeId }, nodes: [{ id: ownerNodeId, name: "Owner", available: true, reachable: true, runningCount: 1 }] };
    else if (url.pathname === "/api/browser/preferences") result = { nodeId: null, effectiveNodeId: ownerNodeId };
    else if (url.pathname === "/api/browser/profiles") result = { profiles: [] };
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket(/\/ws\?mode=browser/, ws => {
    ws.send(JSON.stringify({ type: "browserState", session: snapshot() }));
    ws.send(JSON.stringify({ type: "browserFrame", pageId, width: frameWidth, height: frameHeight, data: frame }));
  });

  const login = await signIn(environment, node);
  await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
  await page.goto(node.url);
  await page.locator("#projectList").getByText("Internal Assistant", { exact: true }).click();
  await page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Short one" }) }).first().click();
  await page.locator("#sessionTitle").filter({ hasText: "Short one" }).waitFor();
  await page.setViewportSize({ width: 412, height: 730 });

  const activeIdentity = await page.evaluate(async () => { const { state } = await import("/app/state.js"); return { projectId: state.activeProjectId, engine: state.engine, conversationId: state.activeConversationId || state.activeSessionId, appNodeId: state.conversationLock?.nodeId || state.activeNodeId }; });
  Object.assign(session, activeIdentity);
  await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged")));

  const dialog = page.getByTestId("browser-login-panel");
  await dialog.waitFor();
  const screen = dialog.getByTestId("browser-screen");
  await screen.waitFor({ state: "visible" });

  // Tap the page: the typing proxy takes focus (a phone opens its keyboard).
  await screen.click();
  const typing = dialog.getByTestId("browser-typing");
  // The mount-time size request is now crawling through its 1.5s response.
  // Through that whole busy window the typing field must stay enabled and focused.
  for (let sample = 0; sample < 10; sample++) {
    const state = await typing.evaluate(element => ({ disabled: (element as HTMLInputElement).disabled, focused: document.activeElement === element }));
    assert.equal(state.disabled, false, `typing must not be disabled while a command is in flight (sample ${sample})`);
    assert.equal(state.focused, true, `typing must keep focus while a command is in flight (sample ${sample})`);
    await new Promise(r => setTimeout(r, 150));
  }
});

// The phone-size request can fail transiently — a service restart swaps page
// ids mid-flight, a network blip drops the POST. A single burned attempt must
// not leave the handoff desktop-sized forever: the viewer retries on a later
// render.
test("a failed phone-size request is retried until it succeeds", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const commands: any[] = [];
  let viewportAttempts = 0;

  const frame = await page.evaluate(([width, height]) => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d")!; context.fillStyle = "#eef4ff"; context.fillRect(0, 0, width, height);
    return canvas.toDataURL("image/jpeg", .85).split(",")[1];
  }, [frameWidth, frameHeight]);

  const session: any = {
    id: sessionId, nodeId: ownerNodeId, state: "running", owner: "human", canControl: true,
    profileId: "55555555-5555-4555-8555-555555555555", profileLabel: "Synthetic login",
    activePageId: pageId, tabs: [{ id: pageId, title: "Sign in", url: "https://accounts.example.test/login" }], downloads: [],
    loginRequest: { id: requestId, expectedOrigin: "https://accounts.example.test", readySelector: "[data-authenticated]", loginSelector: "input", label: "Synthetic login", automatic: false },
  };
  const snapshot = () => ({ ...session });
  await page.route("**/api/browser/**", async route => {
    const url = new URL(route.request().url());
    let result: any = {};
    if (url.pathname === "/api/browser/sessions" && route.request().method() === "GET") result = { sessions: [snapshot()] };
    else if (url.pathname === `/api/browser/sessions/${sessionId}`) result = { session: snapshot() };
    else if (url.pathname.endsWith("/command")) {
      const command = route.request().postDataJSON();
      commands.push(command);
      if (command.action === "setViewport" && ++viewportAttempts === 1) { await route.fulfill({ status: 409, json: { error: "Browser page changed; command discarded" } }); return; }
      result = { session: snapshot() };
    } else if (url.pathname === "/api/browser/status") result = { config: { executorNodeId: node.nodeId }, nodes: [{ id: ownerNodeId, name: "Owner", available: true, reachable: true, runningCount: 1 }] };
    else if (url.pathname === "/api/browser/preferences") result = { nodeId: null, effectiveNodeId: ownerNodeId };
    else if (url.pathname === "/api/browser/profiles") result = { profiles: [] };
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket(/\/ws\?mode=browser/, ws => {
    ws.send(JSON.stringify({ type: "browserState", session: snapshot() }));
    ws.send(JSON.stringify({ type: "browserFrame", pageId, width: frameWidth, height: frameHeight, data: frame }));
  });

  const login = await signIn(environment, node);
  await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
  await page.goto(node.url);
  await page.locator("#projectList").getByText("Internal Assistant", { exact: true }).click();
  await page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Short one" }) }).first().click();
  await page.locator("#sessionTitle").filter({ hasText: "Short one" }).waitFor();
  await page.setViewportSize({ width: 412, height: 730 });

  const activeIdentity = await page.evaluate(async () => { const { state } = await import("/app/state.js"); return { projectId: state.activeProjectId, engine: state.engine, conversationId: state.activeConversationId || state.activeSessionId, appNodeId: state.conversationLock?.nodeId || state.activeNodeId }; });
  Object.assign(session, activeIdentity);
  await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged")));

  const dialog = page.getByTestId("browser-login-panel");
  await dialog.waitFor();
  const screen = dialog.getByTestId("browser-screen");
  await screen.waitFor({ state: "visible" });

  // Renders happen on state changes; a scroll gesture after the failure is a
  // natural render trigger on a phone.
  for (let i = 0; i < 100 && viewportAttempts < 2; i++) {
    await screen.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const startX = rect.left + rect.width / 2, startY = rect.top + rect.height * .7;
      for (const [type, offset] of [["touchstart", 0], ["touchmove", 30], ["touchend", 30]] as const) {
        const touch = new Touch({ identifier: 1, target: element, clientX: startX, clientY: startY - offset });
        element.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [touch], changedTouches: [touch] }));
      }
    });
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(viewportAttempts >= 2, `the failed phone-size request must be retried (attempts: ${viewportAttempts})`);
});

// Phones never emit wheel events, so before this a finger swipe on the remote
// screen scrolled nothing: the remote page was stuck at the top. A drag on the
// screen must translate into remote scroll commands.
test("a finger drag on the remote screen scrolls the remote page", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const wsMessages: any[] = [];

  const frame = await page.evaluate(([width, height]) => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d")!; context.fillStyle = "#eef4ff"; context.fillRect(0, 0, width, height);
    return canvas.toDataURL("image/jpeg", .85).split(",")[1];
  }, [frameWidth, frameHeight]);

  const session: any = {
    id: sessionId, nodeId: ownerNodeId, state: "running", owner: "human", canControl: true,
    profileId: "55555555-5555-4555-8555-555555555555", profileLabel: "Synthetic login",
    activePageId: pageId, tabs: [{ id: pageId, title: "Sign in", url: "https://accounts.example.test/login" }], downloads: [],
    loginRequest: { id: requestId, expectedOrigin: "https://accounts.example.test", readySelector: "[data-authenticated]", loginSelector: "input", label: "Synthetic login", automatic: false },
  };
  const snapshot = () => ({ ...session });
  await page.route("**/api/browser/**", async route => {
    const url = new URL(route.request().url());
    let result: any = {};
    if (url.pathname === "/api/browser/sessions" && route.request().method() === "GET") result = { sessions: [snapshot()] };
    else if (url.pathname === `/api/browser/sessions/${sessionId}`) result = { session: snapshot() };
    else if (url.pathname.endsWith("/command")) result = { session: snapshot() };
    else if (url.pathname === "/api/browser/status") result = { config: { executorNodeId: node.nodeId }, nodes: [{ id: ownerNodeId, name: "Owner", available: true, reachable: true, runningCount: 1 }] };
    else if (url.pathname === "/api/browser/preferences") result = { nodeId: null, effectiveNodeId: ownerNodeId };
    else if (url.pathname === "/api/browser/profiles") result = { profiles: [] };
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket(/\/ws\?mode=browser/, ws => {
    ws.onMessage(message => wsMessages.push(JSON.parse(String(message))));
    ws.send(JSON.stringify({ type: "browserState", session: snapshot() }));
    ws.send(JSON.stringify({ type: "browserFrame", pageId, width: frameWidth, height: frameHeight, data: frame }));
  });

  const login = await signIn(environment, node);
  await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
  await page.goto(node.url);
  await page.locator("#projectList").getByText("Internal Assistant", { exact: true }).click();
  await page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Short one" }) }).first().click();
  await page.locator("#sessionTitle").filter({ hasText: "Short one" }).waitFor();
  await page.setViewportSize({ width: 412, height: 730 });

  const activeIdentity = await page.evaluate(async () => { const { state } = await import("/app/state.js"); return { projectId: state.activeProjectId, engine: state.engine, conversationId: state.activeConversationId || state.activeSessionId, appNodeId: state.conversationLock?.nodeId || state.activeNodeId }; });
  Object.assign(session, activeIdentity);
  await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged")));

  const dialog = page.getByTestId("browser-login-panel");
  await dialog.waitFor();
  const screen = dialog.getByTestId("browser-screen");
  await screen.waitFor({ state: "visible" });

  // Swipe up on the remote screen: finger moves up, the remote page scrolls
  // down. The viewer briefly ignores input while its own mount-time size
  // request is in flight, so the swipe repeats until a quiet moment lands it.
  for (let round = 0; round < 40 && !wsMessages.some(m => m.command?.action === "scroll"); round++) {
    await screen.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const startX = rect.left + rect.width / 2, startY = rect.top + rect.height * .7;
      for (const [type, offset] of [["touchstart", 0], ["touchmove", 30], ["touchmove", 60], ["touchmove", 90], ["touchmove", 120], ["touchmove", 150], ["touchend", 150]] as const) {
        const touch = new Touch({ identifier: 1, target: element, clientX: startX, clientY: startY - offset });
        element.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [touch], changedTouches: [touch] }));
      }
    });
    await new Promise(r => setTimeout(r, 250));
  }
  const scrolls = wsMessages.filter(m => m.type === "browserCommand" && m.command?.action === "scroll");
  assert.ok(scrolls.length > 0, "a finger drag must send remote scroll commands");
  const total = scrolls.reduce((sum, m) => sum + m.command.y, 0);
  assert.ok(total > 0, `an upward swipe must scroll the page downward (total deltaY ${total})`);
});

// A finger drag fires touchmove ~60 times a second. Sending one command per
// move floods the viewer socket: typing is dropped as "connection is busy",
// scrolling lags behind a backed-up queue, and the socket eventually dies.
// Moves must be coalesced into far fewer commands without losing distance.
test("a fast finger drag is coalesced into few scroll commands", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const wsMessages: any[] = [];

  const frame = await page.evaluate(([width, height]) => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    const context = canvas.getContext("2d")!; context.fillStyle = "#eef4ff"; context.fillRect(0, 0, width, height);
    return canvas.toDataURL("image/jpeg", .85).split(",")[1];
  }, [frameWidth, frameHeight]);

  const session: any = {
    id: sessionId, nodeId: ownerNodeId, state: "running", owner: "human", canControl: true,
    profileId: "55555555-5555-4555-8555-555555555555", profileLabel: "Synthetic login",
    activePageId: pageId, tabs: [{ id: pageId, title: "Sign in", url: "https://accounts.example.test/login" }], downloads: [],
    loginRequest: { id: requestId, expectedOrigin: "https://accounts.example.test", readySelector: "[data-authenticated]", loginSelector: "input", label: "Synthetic login", automatic: false },
  };
  const snapshot = () => ({ ...session });
  await page.route("**/api/browser/**", async route => {
    const url = new URL(route.request().url());
    let result: any = {};
    if (url.pathname === "/api/browser/sessions" && route.request().method() === "GET") result = { sessions: [snapshot()] };
    else if (url.pathname === `/api/browser/sessions/${sessionId}`) result = { session: snapshot() };
    else if (url.pathname.endsWith("/command")) result = { session: snapshot() };
    else if (url.pathname === "/api/browser/status") result = { config: { executorNodeId: node.nodeId }, nodes: [{ id: ownerNodeId, name: "Owner", available: true, reachable: true, runningCount: 1 }] };
    else if (url.pathname === "/api/browser/preferences") result = { nodeId: null, effectiveNodeId: ownerNodeId };
    else if (url.pathname === "/api/browser/profiles") result = { profiles: [] };
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket(/\/ws\?mode=browser/, ws => {
    ws.onMessage(message => wsMessages.push(JSON.parse(String(message))));
    ws.send(JSON.stringify({ type: "browserState", session: snapshot() }));
    ws.send(JSON.stringify({ type: "browserFrame", pageId, width: frameWidth, height: frameHeight, data: frame }));
  });

  const login = await signIn(environment, node);
  await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
  await page.goto(node.url);
  await page.locator("#projectList").getByText("Internal Assistant", { exact: true }).click();
  await page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Short one" }) }).first().click();
  await page.locator("#sessionTitle").filter({ hasText: "Short one" }).waitFor();
  await page.setViewportSize({ width: 412, height: 730 });

  const activeIdentity = await page.evaluate(async () => { const { state } = await import("/app/state.js"); return { projectId: state.activeProjectId, engine: state.engine, conversationId: state.activeConversationId || state.activeSessionId, appNodeId: state.conversationLock?.nodeId || state.activeNodeId }; });
  Object.assign(session, activeIdentity);
  await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged")));

  const dialog = page.getByTestId("browser-login-panel");
  await dialog.waitFor();
  const screen = dialog.getByTestId("browser-screen");
  await screen.waitFor({ state: "visible" });

  // 120 synchronous moves: a real drag's event storm, with no frame boundaries.
  const moves = 120;
  for (let round = 0; round < 20 && !wsMessages.some(m => m.command?.action === "scroll"); round++) {
    await screen.evaluate((element, count) => {
      const rect = element.getBoundingClientRect();
      const startX = rect.left + rect.width / 2, startY = rect.top + rect.height * .9;
      const steps: Array<[string, number]> = [["touchstart", startY]];
      for (let step = 1; step <= count; step++) steps.push(["touchmove", startY - step * 2]);
      steps.push(["touchend", startY - count * 2]);
      for (const [type, y] of steps) {
        const touch = new Touch({ identifier: 1, target: element, clientX: startX, clientY: y });
        element.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === "touchend" ? [] : [touch], changedTouches: [touch] }));
      }
    }, moves);
    await new Promise(r => setTimeout(r, 300));
  }

  const scrolls = wsMessages.filter(m => m.type === "browserCommand" && m.command?.action === "scroll");
  assert.ok(scrolls.length > 0, "a finger drag must send remote scroll commands");
  assert.ok(scrolls.length <= 20, `${moves} moves must coalesce into few commands, sent ${scrolls.length}`);
  const total = scrolls.reduce((sum, m) => sum + m.command.y, 0);
  assert.ok(total > 0, `the coalesced scroll must keep its direction and distance (total ${total})`);
});
