// The Browser panel takes half the row beside the conversation. With the Activity panel still
// sharing what was left, the thread wrapped a word or a syllable a line ("uce it / on / stagin /
// g first."). The thread has to keep a readable width wherever the browser opens.
//
// Run with `npm run test:file -- test/ui/ui-browser-panel-layout.test.ts`.
import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

const READABLE_BUBBLE = 280;

const frames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

/** The narrowest message bubble, and whether something covers the middle of one. */
async function thread(page: Page) {
  await frames(page);
  return page.evaluate(`(() => {
    const bubbles = [...document.querySelectorAll("#messages .message.user, #messages .message.assistant")];
    const scrollport = document.querySelector("#messages").getBoundingClientRect();
    const covered = bubbles.filter((bubble) => {
      const box = bubble.getBoundingClientRect();
      const top = Math.max(box.top, scrollport.top), bottom = Math.min(box.bottom, scrollport.bottom);
      if (bottom - top < 4) return false;
      return !bubble.contains(document.elementFromPoint(box.left + box.width / 2, (top + bottom) / 2));
    });
    const activity = document.querySelector("#activityPanel");
    return {
      thread: Math.round(scrollport.width),
      column: Math.round(document.querySelector("#messagesWrap").getBoundingClientRect().width),
      count: bubbles.length,
      narrowest: Math.round(Math.min(...bubbles.map((bubble) => bubble.getBoundingClientRect().width))),
      covered: covered.length,
      activityOpen: !activity.hidden,
      activityPosition: getComputedStyle(activity).position,
      browserWidth: Math.round(document.querySelector("#browserPanel")?.getBoundingClientRect().width ?? 0),
    };
  })()`) as Promise<{ thread: number; column: number; count: number; narrowest: number; covered: number; activityOpen: boolean; activityPosition: string; browserWidth: number }>;
}

function assertReadable(label: string, measured: Awaited<ReturnType<typeof thread>>) {
  assert.ok(measured.count >= 2, `${label}: the conversation's messages must be on the page`);
  assert.ok(measured.narrowest >= READABLE_BUBBLE, `${label}: message bubbles must stay at least ${READABLE_BUBBLE}px wide, got ${measured.narrowest}px (${JSON.stringify(measured)})`);
  assert.equal(measured.covered, 0, `${label}: nothing may cover the messages (${JSON.stringify(measured)})`);
}

test("the transcript keeps a readable width beside the Browser panel", { timeout: 300_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  page.context().setDefaultTimeout(60_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const login = await signIn(environment, node);
  await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(node.url);
  await page.locator("#projectList").getByText("Internal Assistant", { exact: true }).click();
  await page.locator("#sessionList .list-row").filter({ has: page.locator("strong", { hasText: "Thread-Based Agent Builder" }) }).first().click();
  await page.locator("#sessionTitle").filter({ hasText: "Thread-Based Agent Builder" }).waitFor();
  await page.locator("#messages .message.assistant").first().waitFor();
  await page.getByTestId("projects-panel-collapse-button").click();
  await page.getByTestId("chats-panel-collapse-button").click();
  const activityToggle = page.getByTestId("chat-activity-toggle");
  const openBrowser = async () => {
    if (await page.getByTestId("chat-more-button").isVisible()) await page.getByTestId("chat-more-button").click();
    await page.getByTestId("chat-open-browser-button").click();
    await page.locator("#browserPanel").waitFor();
  };
  const closeBrowser = async () => {
    await page.getByTestId("browser-close-viewer").click();
    await page.locator("#browserPanel").waitFor({ state: "detached" });
  };

  // The bug needs the Activity panel sharing the row when the browser opens.
  const before = await thread(page);
  assert.equal(before.activityOpen, true, "a 1280px window opens the Activity panel beside the thread");
  assert.equal(before.activityPosition, "relative", "the Activity panel shares the row before the browser opens");

  await openBrowser();
  const beside = await thread(page);
  assert.ok(beside.browserWidth >= 320, `the Browser panel keeps its column: ${beside.browserWidth}px`);
  assertReadable("1280×800, rails collapsed, Browser open", beside);
  assert.equal(await activityToggle.getAttribute("aria-expanded"), "false", "the Activity panel steps aside for the browser");

  // Asked for again beside the browser, Activity floats over the thread rather than squeezing it.
  await activityToggle.click();
  await page.getByTestId("activity-panel").waitFor();
  const floating = await thread(page);
  assert.equal(floating.activityPosition, "absolute", "Activity floats beside the browser");
  assert.ok(floating.narrowest >= READABLE_BUBBLE, `the thread under floating Activity keeps its width: ${floating.narrowest}px`);
  await page.getByTestId("activity-activity-tab").press("Escape");
  assert.equal(await activityToggle.getAttribute("aria-expanded"), "false", "Escape closes floating Activity");

  // Collapsed for the browser, Activity comes back when the browser closes.
  await closeBrowser();
  await activityToggle.click();
  await openBrowser();
  assert.equal((await thread(page)).activityOpen, false);
  await closeBrowser();
  const after = await thread(page);
  assert.equal(after.activityOpen, true, "closing the browser brings back the Activity panel it hid");
  assert.equal(after.activityPosition, "relative", "Activity shares the row again without the browser");

  await openBrowser();
  for (const width of [1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    assertReadable(`${width}px, rails collapsed, Browser open`, await thread(page));
  }
  // With both lists open beside the browser the column is narrow before Activity takes any of
  // it (305px at 1280); Activity must not take a share of what is left.
  await page.getByTestId("projects-panel-expand-button").click();
  await page.getByTestId("chats-panel-expand-button").click();
  await activityToggle.click();
  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    const measured = await thread(page);
    assert.equal(measured.activityPosition, "absolute", `${width}px, rails open: Activity floats beside the browser`);
    assert.ok(measured.thread >= measured.column - 2, `${width}px, rails open: the thread keeps the whole column, ${measured.thread}px of ${measured.column}px`);
  }
  await activityToggle.click();
  assertReadable("1920px, rails open, Browser open", await thread(page));
  // Collapsed by the person, Activity stays collapsed when the browser closes.
  await closeBrowser();
  assert.equal((await thread(page)).activityOpen, false, "a panel the person collapsed is not reopened");
  // Without the browser the layout is as it was: Activity shares the row at 1920.
  await activityToggle.click();
  const wide = await thread(page);
  assert.equal(wide.activityOpen, true);
  assert.equal(wide.activityPosition, "relative", "without the browser Activity shares the row again");
  await page.setViewportSize({ width: 390, height: 844 });
  await frames(page);
  if (await activityToggle.getAttribute("aria-expanded") === "true") await page.getByTestId("activity-panel-close").click();
  const phone = await thread(page);
  assert.ok(phone.narrowest >= READABLE_BUBBLE, `phone thread keeps its width: ${phone.narrowest}px`);
  assert.deepEqual(errors, []);
});
