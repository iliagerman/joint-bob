import assert from "node:assert/strict";
import test from "node:test";
import { signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

for (const dismiss of ["Not now", "Escape"]) {
  test(`${dismiss} survives refresh without repeating sign-in notices or resuming the browser`, { timeout: 90_000 }, async (t) => {
    const { page, environment, node } = await nativeUiFixture(t);
    const errors: string[] = [], commands: any[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const login = await signIn(environment, node);
    await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
    let session: any = null;
    await page.route("**/api/browser/**", async route => {
      const url = new URL(route.request().url());
      let result: any = {};
      if (url.pathname === "/api/browser/sessions") result = { sessions: session ? [session] : [] };
      else if (url.pathname.endsWith("/command")) {
        const command = route.request().postDataJSON(); commands.push(command);
        if (command.action === "takeControl") { session.owner = "human"; session.canControl = true; }
        result = { session };
      } else if (url.pathname.startsWith("/api/browser/sessions/")) result = { session };
      else if (url.pathname === "/api/browser/status") result = { config: { executorNodeId: node.nodeId }, nodes: [{ id: node.nodeId, name: "Fixture", available: true, reachable: true, runningCount: 1 }] };
      else if (url.pathname === "/api/browser/preferences") result = { nodeId: null, effectiveNodeId: node.nodeId };
      else if (url.pathname === "/api/browser/profiles") result = { profiles: [] };
      await route.fulfill({ json: result });
    });
    await page.routeWebSocket(/\/ws\?mode=browser/, ws => {
      ws.send(JSON.stringify({ type: "browserState", session }));
    });
    await page.goto(node.url);
    const selectConversation = async () => {
      await page.locator("#projectList").getByText("Internal Assistant", { exact: true }).click();
      await page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Short one" }) }).first().click();
      await page.locator("#sessionTitle").filter({ hasText: "Short one" }).waitFor();
    };
    const selectOtherConversation = () => page.locator("#sessionList .list-row").filter({ hasNot: page.locator("strong", { hasText: "Short one" }) }).first().click();
    await selectConversation();
    const identity = await page.evaluate(async () => {
      const { state } = await import("/app/state.js");
      return { projectId: state.activeProjectId, engine: state.engine, conversationId: state.activeConversationId || state.activeSessionId, appNodeId: state.conversationLock?.nodeId || state.activeNodeId };
    });
    session = {
      ...identity, id: "11111111-1111-4111-8111-111111111111", nodeId: node.nodeId,
      state: "running", owner: "agent", canControl: true, profileLabel: "Dismissal fixture",
      activePageId: "33333333-3333-4333-8333-333333333333", tabs: [], downloads: [],
      loginRequest: { id: "44444444-4444-4444-8444-444444444444", expectedOrigin: "https://accounts.example.test", readySelector: "#ready", label: "Synthetic login" },
    };
    const discover = async () => {
      const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/browser/sessions" && !new URL(response.url()).search);
      await page.evaluate(() => document.dispatchEvent(new Event("browserSessionsChanged")));
      await (await response).finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const dialog = page.getByTestId("browser-login-panel");
    await discover();
    await dialog.getByTestId("browser-control-status").filter({ hasText: "Human control" }).waitFor({ state: "attached" });
    if (dismiss === "Not now") await dialog.getByTestId("browser-login-dismiss").click();
    else await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    const commandsAfterDismissal = commands.length;
    await selectOtherConversation();
    await page.reload();
    await page.locator("#projectList").getByText("Internal Assistant", { exact: true }).waitFor();
    await discover();
    assert.equal(await page.locator(".toast-message").filter({ hasText: "Sign-in needed" }).count(), 0, "refresh must not announce a dismissed login in another conversation");
    await selectConversation();
    await discover();
    assert.equal(await dialog.count(), 0, "refresh must not reopen a dismissed login in its conversation");
    assert.equal(commands.length, commandsAfterDismissal, "dismissal and refresh must not send browser commands");
    assert.equal(session.owner, "human");
    assert.equal(session.loginRequest.id, "44444444-4444-4444-8444-444444444444");
    assert.equal(commands.some(command => ["resumeAgent", "close", "completeLogin"].includes(command.action)), false);

    // Dismissal hides automatic prompts, not the pending sign-in in the Browser panel.
    if (await page.getByTestId("chat-more-button").isVisible()) await page.getByTestId("chat-more-button").click();
    await page.getByTestId("chat-open-browser-button").click();
    await page.locator("#browserPanel").getByTestId("browser-login-notice").waitFor({ state: "visible" });
    await selectOtherConversation();
    await selectConversation();
    session.loginRequest = { ...session.loginRequest, id: "55555555-5555-4555-8555-555555555555" };
    await discover();
    await dialog.waitFor({ state: "visible" });
    assert.deepEqual(errors, []);
  });
}
