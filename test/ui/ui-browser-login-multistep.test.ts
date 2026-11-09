import assert from "node:assert/strict";
import test from "node:test";
import type { WebSocketRoute } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

for (const width of [412, 1280]) {
  test(`live sign-in preserves manual multi-step authentication at ${width}px`, { timeout: 120_000 }, async t => {
    const { page, node } = await nativeUiFixture(t);
    await page.goto(`${node.url}/browser.html`);
    await page.setViewportSize({ width, height: 800 });
    const frame = await page.evaluate(() => {
      const canvas = document.createElement("canvas"); canvas.width = 1200; canvas.height = 800;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "white"; context.fillRect(0, 0, 1200, 800);
      context.fillStyle = "black"; context.font = "32px sans-serif";
      context.fillText("Synthetic website: choose an authentication method", 40, 80);
      return canvas.toDataURL("image/jpeg").split(",")[1];
    });
    const session: any = {
      id: "synthetic-login", nodeId: "synthetic-host", state: "running", owner: "human", canControl: true,
      profileLabel: "Synthetic account", activePageId: "website", downloads: [],
      tabs: [{ id: "website", title: "Sign in", url: "https://accounts.example.test/login" }],
      loginRequest: { id: "request", expectedOrigin: "https://accounts.example.test", label: "Sign in" },
    };
    const commands: any[] = [];
    let socket: WebSocketRoute;
    await page.route("**/api/browser/**", async route => {
      if (route.request().method() === "POST") {
        const command = route.request().postDataJSON(); commands.push(command);
        if (command.action === "completeLogin") session.loginRequest = null;
      }
      await route.fulfill({ json: { session, result: null } });
    });
    await page.routeWebSocket(/\/ws\?mode=browser/, ws => {
      socket = ws;
      ws.onMessage(message => { const value = JSON.parse(String(message)); if (value.type === "browserCommand") commands.push(value.command); });
      ws.send(JSON.stringify({ type: "browserState", session }));
      ws.send(JSON.stringify({ type: "browserFrame", pageId: "website", width: 1200, height: 800, data: frame }));
    });
    await page.evaluate("window.__name = (value) => value");
    await page.evaluate(async () => {
      const { createBrowserViewer } = await import("/app/browser-viewer.js");
      const root = document.createElement("section"); root.id = "multistep-login";
      root.className = "browser-login-inline browser-login-fullscreen";
      document.body.replaceChildren(root);
      (window as any).viewer = createBrowserViewer(root, {
        loginMode: true, sessionId: "synthetic-login", nodeId: "synthetic-host", confirm: async () => true,
        api: async (path, options) => { const response = await fetch(path, options); return response.json(); },
      });
    });
    const root = page.locator("#multistep-login"), screen = root.getByTestId("browser-screen");
    await screen.waitFor({ state: "visible" });
    assert.equal(await root.getByTestId("browser-login-form").count(), 0);
    // The website moves from credentials to a challenge, then changes challenge method
    // without changing its URL. Neither transition should restore credential fields.
    for (const title of ["Two-factor authentication", "Authenticator method"]) {
      session.tabs[0] = { id: "website", title, url: "https://accounts.example.test/two-factor" };
      socket!.send(JSON.stringify({ type: "browserState", session }));
      await page.waitForFunction(expected => (window as any).viewer.session.tabs[0].title === expected, title);
      assert.equal(await screen.isVisible(), true);
      assert.equal(await root.getByTestId("browser-login-form").count(), 0);
    }
    await screen.click({ position: { x: 40, y: 40 } });
    await page.waitForFunction(() => document.querySelector('[data-testid="browser-login-done"]:enabled') !== null);
    assert.equal(commands.some(command => ["loginForm", "fill", "completeLogin"].includes(command.action)), false);
    await root.getByTestId("browser-login-done").click();
    await page.waitForFunction(() => (window as any).viewer.session.loginRequest === null);
    assert.equal(commands.filter(command => command.action === "completeLogin").length, 1);
    assert.ok(commands.some(command => command.action === "click"), "manual website clicks must reach the remote browser");
    await page.evaluate(() => (window as any).viewer.dispose());
  });
}
