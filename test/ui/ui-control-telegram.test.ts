import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function signIn(page: Page, url: string, environment: { username: string; password: string }): Promise<void> {
  await page.goto(url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3 && !document.body.classList.contains("booting"));
  // Boot resets the view to the project list as its last step; open the control center only after that.
  await page.waitForFunction(async () => (await import("/app/state.js")).state.preferencesLoaded);
  await page.waitForTimeout(500);
}

const BOT_TOKEN = "123456:AAtestTOKENtestTOKENtestTOKEN";

test("Bob's settings connect the Telegram bot with a token, show the one-time link, say who it answers and disconnect", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment);

  // The Telegram routes are mocked in the page; the real server answers everything else.
  await page.evaluate(`(() => {
    const originalFetch = window.fetch;
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    window.__telegram = { connected: false, bases: [] };
    window.__requests = [];
    window.addEventListener('unhandledrejection', () => undefined);
    window.fetch = async (...args) => {
      const url = new URL(String(args[0]), location.href);
      const method = (args[1]?.method || 'GET').toUpperCase();
      if (!url.pathname.startsWith('/api/control-center/telegram')) return originalFetch(...args);
      const body = args[1]?.body ? JSON.parse(args[1].body) : undefined;
      window.__requests.push({ method, path: url.pathname, body });
      if (method === 'GET') return json(window.__telegram);
      if (method === 'DELETE') { window.__telegram = { connected: false, bases: [{ id: 'direct', label: "This machine's own address" }] }; return new Response(null, { status: 204 }); }
      if (url.pathname.endsWith('/pairing')) { window.__code = (window.__code || 0) + 1; return json({ ...window.__telegram, linkWaiting: true, pairingLink: 'https://t.me/bob_test_bot?start=code' + window.__code }); }
      if (body.token === '999:wrongwrongwrongwrongwrong') return json({ error: "Telegram didn't accept this token. Copy it again from @BotFather." }, 400);
      window.__telegram = { connected: true, botUsername: 'bob_test_bot', linked: null, linkWaiting: true };
      window.__code = 1;
      return json({ ...window.__telegram, pairingLink: 'https://t.me/bob_test_bot?start=code1' }, 201);
    };
  })()`);

  await page.getByTestId("projects-open-control-center-button").click();
  await page.getByTestId("control-chat").waitFor();
  const settings = page.getByTestId("control-chat-settings");
  assert.equal(await settings.isHidden(), true);
  await page.getByTestId("control-chat-settings-button").click();
  await settings.waitFor({ state: "visible" });

  // Not connected, and this machine has no address Telegram can reach: it says so, and there is nothing to press.
  const status = page.getByTestId("control-telegram-status");
  await page.waitForFunction(() => document.querySelector('[data-testid="control-telegram-status"]')?.textContent === "Telegram: not connected");
  assert.equal(await page.getByTestId("control-telegram-form").count(), 0, "the form is behind Connect");
  await page.getByTestId("control-telegram-toggle").click();
  assert.match(await page.getByTestId("control-telegram-no-address").innerText(), /This machine has no address Telegram can reach\. Join a relay in Settings → Relays first\./);
  assert.equal(await page.getByTestId("control-telegram-connect").isDisabled(), true);
  assert.equal(await page.getByTestId("control-telegram-base").count(), 0);
  // The row sits with the other settings, above the Guardian line.
  assert.equal(await page.getByTestId("control-telegram").evaluate((row) => row.nextElementSibling?.id), "controlBobGuard");

  // With an address, the token is asked for as a password and the steps are listed.
  await page.evaluate(`window.__telegram = { connected: false, bases: [{ id: 'direct', label: "This machine's own address" }] }`);
  await page.getByTestId("control-chat-settings-button").click();
  await settings.waitFor({ state: "hidden" });
  await page.getByTestId("control-chat-settings-button").click();
  await page.getByTestId("control-telegram-connect").waitFor();
  assert.equal(await page.getByTestId("control-telegram-no-address").count(), 0);
  assert.equal(await page.getByTestId("control-telegram-connect").isDisabled(), false);
  assert.equal(await page.getByTestId("control-telegram-token").getAttribute("type"), "password");
  assert.match(await page.getByTestId("control-telegram-form").innerText(), /open @BotFather, send \/newbot and copy the token[\s\S]*Only Joint Bob uses it/);

  // A token Telegram does not accept is reported and nothing is connected.
  await page.getByTestId("control-telegram-token").fill("999:wrongwrongwrongwrongwrong");
  await page.getByTestId("control-telegram-connect").click();
  await page.waitForFunction(() => window.__requests.some((request: { body?: { token?: string } }) => request.body?.token === "999:wrongwrongwrongwrongwrong"));
  await page.getByText("Telegram didn't accept this token").first().waitFor();
  assert.equal(await status.innerText(), "Telegram: not connected");

  // Connecting: the token goes to the server once and the page never shows it again; the one-time link is offered.
  await page.getByTestId("control-telegram-token").fill(BOT_TOKEN);
  await page.getByTestId("control-telegram-connect").click();
  await page.getByTestId("control-telegram-link").waitFor();
  const sent = (await page.evaluate("window.__requests") as Array<{ method: string; body?: { token: string; baseId?: string } }>).filter((request) => request.method === "POST" && request.body?.token === BOT_TOKEN);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body?.baseId, undefined, "one address needs no choice");
  assert.equal(await status.innerText(), "Telegram: @bob_test_bot · connected · no account linked yet");
  assert.equal(await page.getByTestId("control-telegram-token").count(), 0);
  assert.equal((await page.content()).includes(BOT_TOKEN), false, "the token is not left in the page");
  assert.equal(await page.getByTestId("control-telegram-link").getAttribute("href"), "https://t.me/bob_test_bot?start=code1");
  assert.equal(await page.getByTestId("control-telegram-link").getAttribute("target"), "_blank");
  assert.match(await page.getByTestId("control-telegram").locator(".control-telegram-link-block").innerText(), /to link your account\. It works once and expires in 10 minutes\./);
  assert.match(await page.getByTestId("control-telegram-warning").innerText(), /everything this chat can, including allowing or blocking Guardian reviews[\s\S]*two-step verification/);
  assert.equal(await page.getByTestId("control-telegram-owner").count(), 0);

  // Using the link in Telegram links the account; the server tells the page and the link is gone.
  await page.evaluate(`(() => { window.__telegram = { connected: true, botUsername: 'bob_test_bot', linked: { id: '111', name: 'Ilia' }, linkWaiting: false }; window.dispatchEvent(new CustomEvent('control-center-changed')); })()`);
  await page.waitForFunction(() => document.querySelector('[data-testid="control-telegram-status"]')?.textContent === "Telegram: @bob_test_bot · connected · answers only you");
  assert.equal(await page.getByTestId("control-telegram-link").count(), 0);
  assert.match(await page.getByTestId("control-telegram-owner").innerText(), /Linked to Ilia \(111\)\. Nobody else gets an answer, and groups are left at once\./);

  // Another account can be linked with a new one-time link.
  await page.getByTestId("control-telegram-new-link").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="control-telegram-link"]')?.getAttribute("href") === "https://t.me/bob_test_bot?start=code2");
  assert.match(await page.getByTestId("control-telegram-new-link").innerText(), /Link another account/);

  // Disconnecting asks first, then removes the bot; the form comes back.
  const deletes = () => page.evaluate("window.__requests.filter((request) => request.method === 'DELETE').length");
  await page.getByTestId("control-telegram-disconnect").click();
  assert.equal(await deletes(), 0, "the first click only asks");
  assert.match(await page.getByTestId("control-telegram-disconnect").innerText(), /Click again/);
  await page.getByTestId("control-telegram-disconnect").click();
  await page.waitForFunction(() => document.querySelector('[data-testid="control-telegram-status"]')?.textContent === "Telegram: not connected");
  assert.equal(await deletes(), 1);
  assert.equal(await page.getByTestId("control-telegram-disconnect").count(), 0);
  assert.equal(await page.getByTestId("control-telegram-link").count(), 0);
});
