// A hidden tab must not ping its conversation socket: browsers throttle hidden
// timers past the pong deadline, and the old heartbeat then reconnected and
// reloaded the whole transcript every few minutes overnight.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { nativeUiFixture } from "./native-ui-fixture.js";

const PROJECT_NAME = "Internal Assistant";
const CONVERSATION_TITLE = "Makor deployment information";

async function setVisibility(page: Page, visibility: "hidden" | "visible"): Promise<void> {
  await page.evaluate(`(() => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "${visibility}" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => ${visibility === "hidden"} });
    document.dispatchEvent(new Event("visibilitychange"));
  })()`);
}

async function waitUntil(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("a hidden tab stops pinging, and returning probes once without reloading the transcript", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.clock.install();
  const pings: string[] = [];
  const logs: string[] = [];
  page.on("console", (message) => logs.push(message.text()));
  page.on("websocket", (socket) => {
    if (socket.url().includes("sessionPath=watch")) return;
    socket.on("framesent", (frame) => { if (String(frame.payload).includes("\"ping\"")) pings.push(String(frame.payload)); });
  });

  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: PROJECT_NAME }).first().click();
  await page.locator(".session-card", { hasText: CONVERSATION_TITLE }).first().click();
  await waitUntil(() => logs.some((line) => line.startsWith("Conversation transcript ready")), "the conversation to open");
  const readyCount = (): number => logs.filter((line) => line.startsWith("Conversation transcript ready")).length;
  const reconnects = (): string[] => logs.filter((line) => line.startsWith("Reconnecting conversation socket"));
  const openedReady = readyCount();

  await setVisibility(page, "hidden");
  const pingsBeforeHiding = pings.length;
  await page.clock.runFor(10 * 60_000);
  await page.waitForTimeout(500);
  assert.equal(pings.length, pingsBeforeHiding, `a hidden tab sent ${pings.length - pingsBeforeHiding} ping(s) in 10 minutes`);
  assert.deepEqual(reconnects(), [], "a hidden tab must not reconnect a healthy socket");
  assert.equal(readyCount(), openedReady, "a hidden tab must not reload the transcript");

  await setVisibility(page, "visible");
  await waitUntil(() => pings.length === pingsBeforeHiding + 1, "one probe ping after the tab became visible");
  await page.clock.runFor(6_000);
  await page.waitForTimeout(500);
  assert.deepEqual(reconnects(), [], "an answered probe keeps the socket");
  assert.equal(readyCount(), openedReady, "an answered probe does not reload the transcript");

  await page.clock.runFor(16_000);
  await waitUntil(() => pings.length > pingsBeforeHiding + 1, "the visible heartbeat to resume");
});
