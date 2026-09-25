import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { type Browser } from "playwright-core";
import { seedDevEnvironment, startDevNode, stopDevNode } from "../dev-nodes.js";
import { fixtureTotp } from "../mfa-fixture.js";
import { launchChrome } from "./launch-chrome.js";

test("account MFA setup, two-step login, recovery rotation and disable work on desktop and phone", { timeout: 150_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-ui-mfa-"));
  let server: ChildProcess | undefined;
  let browser: Browser | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    server = await startDevNode(environment, node);
    browser = await launchChrome({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(node.url);
    const passwordLogin = async () => {
      await page.getByTestId("login-username-input").fill(environment.username);
      await page.getByTestId("login-password-input").fill(environment.password);
      await page.getByTestId("login-submit-button").click();
    };
    const ready = () => page.getByText("Internal Assistant", { exact: true }).waitFor();
    const openSettings = async () => {
      if (await page.getByTestId("settings-open-button").isVisible()) await page.getByTestId("settings-open-button").click();
      else {
        await page.getByTestId("app-menu-button").click();
        await page.getByTestId("app-menu-settings-button").click();
      }
    };
    const openMfa = async () => {
      await openSettings();
      await page.getByTestId("settings-mfa-button").click();
      await page.getByTestId("mfa-dialog").waitFor();
    };
    const logout = async () => {
      await openSettings();
      await page.getByTestId("settings-logout-button").click();
      await page.getByTestId("login-dialog").waitFor();
    };
    await passwordLogin();
    await ready();
    await openMfa();
    await page.getByTestId("mfa-password-input").fill(environment.password);
    await page.getByTestId("mfa-submit-button").click();
    const key = page.getByTestId("mfa-setup-key");
    await key.waitFor();
    const secret = await key.inputValue();
    assert.match(secret, /^[A-Z2-7]{32}$/);
    await page.getByTestId("mfa-code-input").fill("00000");
    await page.getByTestId("mfa-submit-button").click();
    await page.getByTestId("mfa-error").waitFor();
    await page.getByTestId("mfa-code-input").fill(fixtureTotp(secret));
    await page.getByTestId("mfa-submit-button").click();
    const recovery = page.getByTestId("mfa-recovery-codes");
    await recovery.waitFor().catch(async error => { throw new Error(`${error.message}; MFA error: ${await page.getByTestId("mfa-error").textContent()}`); });
    const codes = (await recovery.inputValue()).trim().split("\n");
    assert.equal(codes.length, 10);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const bounds = await page.getByTestId("mfa-dialog").evaluate(dialog => ({ width: dialog.clientWidth, content: dialog.scrollWidth, left: dialog.getBoundingClientRect().left, right: dialog.getBoundingClientRect().right }));
      assert.ok(bounds.content <= bounds.width && bounds.left >= 0 && bounds.right <= width, `MFA fits ${width}px without horizontal overflow`);
    }
    await page.getByTestId("mfa-submit-button").click();
    await page.getByTestId("mfa-dialog").waitFor({ state: "hidden" });
    assert.equal(await key.inputValue(), "", "setup key leaves the DOM on close");
    assert.equal(await recovery.inputValue(), "", "recovery codes leave the DOM on close");
    await page.getByTestId("settings-mfa-status").getByText(/Enabled/).waitFor();
    await page.getByTestId("settings-logout-button").click();
    await passwordLogin();
    const loginCode = page.getByTestId("login-mfa-code-input");
    await loginCode.waitFor();
    assert.equal(await page.getByTestId("login-password-input").inputValue(), "", "password is cleared before MFA entry");
    assert.equal((await page.request.get(`${node.url}/api/projects`)).status(), 401, "first factor alone has no API session");
    await loginCode.fill("invalid-code");
    await page.getByTestId("login-submit-button").click();
    await page.locator("#loginError").getByText(/Invalid/).waitFor();
    assert.equal(await loginCode.isVisible(), true, "a failed code stays on the MFA step");
    await page.getByTestId("login-back-button").click();
    await passwordLogin();
    await loginCode.fill(fixtureTotp(secret, 1));
    await page.getByTestId("login-submit-button").click();
    await ready();
    await page.reload();
    await ready();
    await logout();
    await passwordLogin();
    await loginCode.fill(codes[0]);
    await page.getByTestId("login-submit-button").click();
    await ready();
    await openMfa();
    await page.getByTestId("mfa-password-input").fill(environment.password);
    await page.getByTestId("mfa-code-input").fill(codes[1]);
    await page.getByTestId("mfa-submit-button").click();
    await recovery.waitFor();
    const replaced = (await recovery.inputValue()).trim().split("\n");
    assert.equal(replaced.length, 10);
    assert.notDeepEqual(replaced, codes);
    await page.getByTestId("mfa-submit-button").click();
    await page.getByTestId("settings-mfa-button").click();
    await page.getByTestId("mfa-password-input").fill(environment.password);
    await page.getByTestId("mfa-code-input").fill(replaced[0]);
    await page.getByTestId("mfa-disable-button").click();
    await page.getByTestId("mfa-dialog").waitFor({ state: "hidden" });
    await page.getByTestId("settings-mfa-status").getByText(/Not enabled/).waitFor();
    await page.getByTestId("settings-logout-button").click();
    await passwordLogin();
    await ready();
    assert.equal(await loginCode.isVisible(), false, "disabled MFA restores password-only sign in");
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    if (server) await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
