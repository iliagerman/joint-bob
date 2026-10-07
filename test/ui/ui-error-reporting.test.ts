// Settings → Notifications → Send errors to ntfy, end to end against a loopback
// ntfy fixture: configure client and backend destinations, then a UI error and an
// unhandled rejection in the page reach the client topic with their stacks.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

type Published = { topic: string; title: string; message: string };

async function ntfyFixture(t: test.TestContext): Promise<{ url: string; published: Published[] }> {
  const published: Published[] = [];
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (part) => { raw += part; });
    request.on("end", () => { if (request.method === "POST") published.push(JSON.parse(raw)); response.end("{}"); });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("ntfy fixture address missing");
  return { url: `http://127.0.0.1:${address.port}`, published };
}

async function waitUntil(check: () => boolean, label: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function openNotifications(page: Page): Promise<void> {
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-notifications").click();
  await page.getByTestId("error-reporting-settings").waitFor();
}

test("errors are sent to the ntfy topics chosen in Settings", { timeout: 120_000 }, async (t) => {
  const ntfy = await ntfyFixture(t);
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByTestId("settings-open-button").waitFor();
  await openNotifications(page);

  await page.getByTestId("ntfy-service-name-input").fill("Errors fixture");
  await page.getByTestId("ntfy-service-url-input").fill(ntfy.url);
  await page.getByTestId("ntfy-service-add-button").click();
  await page.getByTestId("ntfy-service-list").getByText("Errors fixture").waitFor();

  assert.equal(await page.getByTestId("error-reporting-options").isVisible(), false, "the options stay hidden until the feature is on");
  await page.getByTestId("error-reporting-enabled").check();
  await page.getByTestId("error-reporting-options").waitFor();
  assert.equal(await page.getByTestId("error-reporting-client-service").inputValue() !== "", true, "the saved server is preselected");
  assert.equal(await page.getByTestId("error-reporting-same-destination").isChecked(), true, "one destination for both is the default");
  assert.equal(await page.getByTestId("error-reporting-backend-destination").isVisible(), false, "a shared destination hides the backend fields");
  await page.getByTestId("error-reporting-client-topic").fill("ui-errors");
  await page.getByTestId("error-reporting-same-destination").uncheck();
  await page.getByTestId("error-reporting-backend-destination").waitFor();
  await page.getByTestId("error-reporting-backend-topic").fill("bad/topic");
  await page.getByTestId("error-reporting-save-button").click();
  await page.locator(".toast", { hasText: "Backend errors need a topic" }).waitFor();
  await page.getByTestId("error-reporting-backend-topic").fill("backend-errors");
  await page.getByTestId("error-reporting-save-button").click();
  await page.locator(".toast", { hasText: "Errors will be sent to ntfy" }).waitFor();

  await page.reload();
  await page.getByTestId("settings-open-button").waitFor();
  await openNotifications(page);
  await page.getByTestId("error-reporting-options").waitFor();
  assert.equal(await page.getByTestId("error-reporting-enabled").isChecked(), true);
  assert.equal(await page.getByTestId("error-reporting-client-topic").inputValue(), "ui-errors");
  assert.equal(await page.getByTestId("error-reporting-backend-topic").inputValue(), "backend-errors");
  assert.equal(await page.getByTestId("error-reporting-same-destination").isChecked(), false);

  await page.evaluate(`console.error("UI boom from the browser test")`);
  await waitUntil(() => ntfy.published.some((entry) => entry.message.includes("UI boom from the browser test")), "the console error to reach ntfy");
  const consoleReport = ntfy.published.find((entry) => entry.message.includes("UI boom from the browser test"))!;
  assert.equal(consoleReport.topic, "ui-errors");
  assert.equal(consoleReport.title, "Joint Bob UI error");
  assert.match(consoleReport.message, new RegExp(`Source: .*${environment.username}`));

  await page.evaluate(`setTimeout(() => Promise.reject(new Error("Lost in the UI")), 0)`);
  await waitUntil(() => ntfy.published.some((entry) => entry.message.includes("Error: Lost in the UI")), "the unhandled rejection to reach ntfy");
  const rejection = ntfy.published.find((entry) => entry.message.includes("Error: Lost in the UI"))!;
  assert.match(rejection.message, /\n\s*(at |@)/, `the stack travels with the report: ${rejection.message}`);

  await page.getByTestId("error-reporting-client-enabled").uncheck();
  assert.equal(await page.getByTestId("error-reporting-client-destination").isVisible(), false);
  assert.equal(await page.getByTestId("error-reporting-same-destination").isVisible(), false, "sharing needs both channels");
  await page.getByTestId("error-reporting-save-button").click();
  await page.locator(".toast", { hasText: "Errors will be sent to ntfy" }).last().waitFor();
  const before = ntfy.published.length;
  await page.evaluate(`console.error("Backend-only mode ignores this UI error")`);
  await page.waitForTimeout(1_000);
  assert.equal(ntfy.published.length, before, "with only backend errors on, UI errors are not sent");
});
