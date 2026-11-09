import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("phone sign-in remains dismissible while its browser host is unavailable", { timeout: 120_000 }, async t => {
  const { page, node } = await nativeUiFixture(t);
  await page.goto(`${node.url}/browser.html`);
  await page.setViewportSize({ width: 412, height: 730 });
  await page.evaluate("window.__name = (value) => value");
  await page.evaluate(async () => {
    const { createBrowserViewer } = await import("/app/browser-viewer.js");
    const root = document.createElement("section");
    root.id = "unavailable-login";
    root.className = "browser-login-inline browser-login-fullscreen";
    document.body.replaceChildren(root);
    let rejectSession: (error: Error) => void;
    (window as any).failSession = () => rejectSession(new Error("Browser node is unreachable. Its browser is not moved to another node."));
    (window as any).attempts = 0;
    (window as any).viewer = createBrowserViewer(root, {
      sessionId: "synthetic-session", nodeId: "offline-host", loginMode: true,
      api: async () => { (window as any).attempts++; return new Promise((_, reject) => { rejectSession = reject; }); },
      confirm: async () => true, onClose: () => root.remove(),
    });
  });
  const root = page.locator("#unavailable-login");
  assert.equal(await root.getByTestId("browser-login-dismiss").isVisible(), true, "dismiss must be visible before session GET resolves");
  assert.match(await root.locator('[data-part="frame-hint"]').textContent() || "", /connecting/i);
  await page.evaluate(() => (window as any).failSession());
  await root.getByTestId("browser-error").waitFor({ state: "visible" });
  assert.match(await root.getByTestId("browser-error").textContent() || "", /unreachable/);
  await root.getByTestId("browser-login-retry").click();
  assert.equal(await page.evaluate(() => (window as any).attempts), 2);
  await root.getByTestId("browser-login-dismiss").click();
  assert.equal(await root.count(), 0);
  await page.evaluate(() => { (window as any).viewer.dispose(); (window as any).failSession(); });
});
