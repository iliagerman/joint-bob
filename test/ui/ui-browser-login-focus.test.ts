import assert from "node:assert/strict";
import test from "node:test";
import { api, signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

// Real touch events matter: desktop clicks bypass Focus mode's tap recognizer.
test("Focus mode leaves sign-in taps and typing with the browser viewer", { timeout: 120_000 }, async t => {
  const fixture = await nativeUiFixture(t);
  const login = await signIn(fixture.environment, fixture.node);
  await api(fixture.node, login, "PUT", "/preferences", { focusUiEnabled: true });
  const context = await fixture.page.context().browser()!.newContext({
    viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: "block",
  });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await context.addCookies(login.cookie.split("; ").map(cookie => ({
    name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: fixture.node.url,
  })));
  const frame = await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 390; canvas.height = 600;
    return canvas.toDataURL("image/jpeg").split(",")[1];
  });
  const session: any = {
    id: "11111111-1111-4111-8111-111111111111", nodeId: fixture.node.nodeId,
    state: "running", owner: "human", canControl: true,
    profileId: "22222222-2222-4222-8222-222222222222", profileLabel: "Synthetic sign-in",
    activePageId: "33333333-3333-4333-8333-333333333333",
    tabs: [{ id: "33333333-3333-4333-8333-333333333333", title: "Sign in", url: "https://accounts.example.test/login" }], downloads: [],
    loginRequest: {
      id: "44444444-4444-4444-8444-444444444444", expectedOrigin: "https://accounts.example.test",
      readySelector: "[data-authenticated]", label: "Synthetic sign-in", automatic: false,
    },
  };
  const inputs: any[] = [];
  await page.route("**/api/browser/**", async route => {
    const url = new URL(route.request().url());
    let result: any = {};
    if (url.pathname === "/api/browser/sessions") result = { sessions: [{ ...session }] };
    else if (url.pathname === `/api/browser/sessions/${session.id}` || url.pathname.endsWith("/command")) result = { session: { ...session } };
    else if (url.pathname === "/api/browser/status") result = {
      config: { executorNodeId: fixture.node.nodeId },
      nodes: [{ id: fixture.node.nodeId, name: "Fixture", available: true, reachable: true, runningCount: 1 }],
    };
    else if (url.pathname === "/api/browser/preferences") result = { nodeId: null, effectiveNodeId: fixture.node.nodeId };
    else if (url.pathname === "/api/browser/profiles") result = { profiles: [] };
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket(/\/ws\?mode=browser/, ws => {
    ws.onMessage(message => inputs.push(JSON.parse(String(message))));
    ws.send(JSON.stringify({ type: "browserState", session: { ...session } }));
    ws.send(JSON.stringify({ type: "browserFrame", pageId: session.activePageId, width: 390, height: 600, data: frame }));
  });
  await page.goto(fixture.node.url);
  await page.locator("body.focus-ui .project-card").first().waitFor();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("#messageInput")!.disabled);
  await page.locator("#messageInput").fill("Keep this local draft");
  Object.assign(session, await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    return { projectId: state.activeProjectId, engine: state.engine, conversationId: state.activeConversationId || state.activeSessionId, appNodeId: state.conversationLock?.nodeId || state.activeNodeId };
  }));
  await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged")));
  const panel = page.getByTestId("browser-login-panel");
  const screen = panel.getByTestId("browser-screen");
  await screen.waitFor({ state: "visible" });
  assert.equal(await panel.evaluate(element => element.parentElement === document.body), true, "phone popup is outside the regular Browser panel");
  await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('[data-testid="browser-typing"]')!.disabled);
  await screen.tap();
  assert.equal(await panel.getByTestId("browser-typing").evaluate(element => document.activeElement === element), true,
    "touch must focus the real typing input in the user gesture, not get swallowed by Focus mode");
  await page.keyboard.insertText("synthetic input");
  // Allow the app's multi-tap window to expire before checking for stray actions.
  for (let i = 0; i < 3; i++) await screen.tap();
  await page.waitForTimeout(450);
  assert.equal(inputs.filter(input => input.command?.action === "click").length, 4, "every tap reaches the remote page once");
  assert.ok(inputs.some(input => input.command?.action === "text" && input.command.text === "synthetic input"), "typing reaches the remote page");
  assert.equal(await panel.getByTestId("browser-typing").inputValue(), "", "proxy does not retain typed text");
  assert.equal(await page.locator("#messageInput").inputValue(), "Keep this local draft");
  assert.equal(await page.getByTestId("recent-sessions-dialog").isVisible(), false, "remote taps must not trigger app gestures");
  assert.equal(await page.getByTestId("running-conversations-dialog").isVisible(), false, "remote taps must not open app dialogs");
});
