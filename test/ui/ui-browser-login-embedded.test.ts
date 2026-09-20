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

// Embedded in the conversation, the sign-in reads like a message: site name,
// the three actions, and the page itself. Browser chrome — back/reload, Send
// Tab, the session context and the help sentence — returns only in full screen
// where there is room for it.
test("embedded sign-in panel hides browser chrome until full screen", { timeout: 120_000 }, async (t) => {
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
  await dialog.getByTestId("browser-screen").waitFor({ state: "visible" });

  // Inline: only the caption row and the page. No session context, no help
  // sentence, no back/reload, no Send Tab.
  for (const hidden of ["browser-login-context", "browser-back", "browser-reload", "browser-send-tab", "browser-send-shift-tab"]) {
    assert.equal(await dialog.getByTestId(hidden).isVisible(), false, `${hidden} must stay hidden in the embedded panel`);
  }
  assert.equal(await dialog.locator('[data-part="login-help"]').isVisible(), false, "help sentence must stay hidden in the embedded panel");
  for (const visible of ["browser-login-done", "browser-login-expand", "browser-login-dismiss"]) {
    assert.equal(await dialog.getByTestId(visible).isVisible(), true, `${visible} must stay visible in the embedded panel`);
  }
  // No card frame: the panel itself draws no border around the conversation slot.
  const borders = await dialog.evaluate(element => {
    const style = getComputedStyle(element);
    return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth];
  });
  assert.deepEqual(borders, ["0px", "0px", "0px", "0px"], `embedded panel must not draw a frame: ${borders.join(", ")}`);

  // Full screen brings the working chrome back: back/reload and Send Tab.
  await dialog.getByTestId("browser-login-expand").click();
  for (const visible of ["browser-back", "browser-reload", "browser-send-tab"]) {
    assert.equal(await dialog.getByTestId(visible).isVisible(), true, `${visible} must return in full screen`);
  }

  // Exiting full screen hides the chrome again.
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "visible" });
  assert.equal(await dialog.getByTestId("browser-back").isVisible(), false, "back must hide again after leaving full screen");
});
