import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function signIn(page: Page, url: string, username: string, password: string) {
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#loginDialog[open]") || document.querySelector('[data-testid="settings-open-button"]')?.getClientRects().length);
  if (await page.locator("#loginDialog[open]").count()) {
    await page.getByTestId("login-username-input").fill(username);
    await page.getByTestId("login-password-input").fill(password);
    await page.getByTestId("login-submit-button").click();
  }
  await page.getByTestId("settings-open-button").waitFor();
}

test("Settings keeps client console diagnostics across a PWA reload", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);

  await page.evaluate(() => console.warn("kiro-render-diagnostic", { messages: 5271 }));
  await page.reload();
  await page.getByTestId("settings-open-button").waitFor();
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-logs").click();

  const output = page.getByTestId("settings-client-logs-output");
  await output.waitFor();
  assert.match(await output.textContent() || "", /kiro-render-diagnostic.*messages.*5271/);
  assert.match(await output.textContent() || "", /navigation=reload/);

  await page.getByTestId("settings-client-logs-clear-button").click();
  assert.match(await output.textContent() || "", /No client logs captured/);
});

test("caught API failures identify the request in the alert and survive in client logs", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  await page.route("**/api/preferences?diagnostic=*", (route) => route.fulfill({ status: 500, json: { error: "This operation was aborted" } }));
  await page.evaluate(`(async () => {
    const { api } = await import("/app/api.js");
    const { toast } = await import("/app/shell.js");
    try { await api("/api/preferences?diagnostic=private-query", { method: "PUT", body: JSON.stringify({ privateBody: "private-body" }) }); }
    catch (error) { toast.error(error.message); }
  })()`);
  const alert = page.locator('.toast[role="alert"]').filter({ hasText: "PUT /api/preferences" });
  await alert.waitFor();
  assert.match(await alert.textContent() || "", /interrupted/);
  assert.match(await alert.textContent() || "", /check.*before.*try/i);
  assert.doesNotMatch(await alert.textContent() || "", /private-query|private-body/);
  await page.reload();
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-logs").click();
  const logs = await page.getByTestId("settings-client-logs-output").textContent() || "";
  assert.match(logs, /API request failed.*PUT.*\/api\/preferences/);
  assert.match(logs, /"status":500/);
  assert.doesNotMatch(logs, /private-query|private-body/);
});

test("agent switch waits for server confirmation before changing conversation identity", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await signIn(page, node.url, environment.username, environment.password);
  const result = await page.evaluate(`(async () => {
    const { state } = await import("/app/state.js");
    const original = { path: "/existing/pi.jsonl", id: crypto.randomUUID() };
    const sent = [];
    state.activeProjectId = "project";
    state.harnesses = [
      { id: "pi", label: "Pi", newSessionPath: "new", runtimeConfigured: true },
      { id: "kiro", label: "Kiro", newSessionPath: "kiro:new", runtimeConfigured: true },
    ];
    state.engine = "pi";
    state.activeSessionPath = original.path;
    state.activeSessionId = original.id;
    state.socket = { readyState: WebSocket.OPEN, send(value) { sent.push(value); } };
    const select = document.querySelector("#chatHarnessSelect");
    select.replaceChildren(new Option("Pi", "pi"), new Option("Kiro", "kiro"));
    select.value = "kiro";
    select.dispatchEvent(new Event("change"));
    return { path: state.activeSessionPath, id: state.activeSessionId, engine: state.engine, selected: select.value, sent };
  })()`);

  assert.deepEqual(result, {
    path: "/existing/pi.jsonl",
    id: result.id,
    engine: "pi",
    selected: "pi",
    sent: [JSON.stringify({ type: "setEngine", engine: "kiro" })],
  });
  assert.ok(result.id);
});
