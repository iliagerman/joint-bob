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

// A 2560px-wide monitor must not blow the remote page image up past its real
// size: an upscaled frame is blurry and its 52vh scrollbox shows only a slice.
test("browser screen never renders wider than the remote frame", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const liveSockets = new Set<WebSocketRoute>();

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
  const activeIdentity = await page.evaluate(async () => { const { state } = await import("/app/state.js"); return { projectId: state.activeProjectId, engine: state.engine, conversationId: state.activeConversationId || state.activeSessionId, appNodeId: state.conversationLock?.nodeId || state.activeNodeId }; });
  Object.assign(session, activeIdentity);
  await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged")));

  const dialog = page.getByTestId("browser-login-panel");
  await dialog.waitFor();
  const screen = dialog.getByTestId("browser-screen");
  await screen.waitFor({ state: "visible" });

  for (const width of [2560, 1440]) {
    await page.setViewportSize({ width, height: 1300 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const rect = await screen.evaluate(element => { const box = element.getBoundingClientRect(); return { width: box.width, height: box.height }; });
    assert.ok(rect.width <= frameWidth + 1, `at viewport ${width}px the remote frame must not upscale: rendered ${rect.width}px > frame ${frameWidth}px`);
    assert.ok(rect.width > 0, "screen image must stay visible");
  }
  // A container narrower than the frame still downscales the image to fit.
  await page.setViewportSize({ width: 800, height: 1000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const small = await screen.evaluate(element => element.getBoundingClientRect().width);
  assert.ok(small < frameWidth && small > 0, `narrow screens must downscale the frame to fit: rendered ${small}px`);
});
