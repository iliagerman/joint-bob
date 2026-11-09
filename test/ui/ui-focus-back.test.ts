import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { signIn } from "../dev-nodes.js";

test("phone titles read in title case at one size, and Back climbs a level instead of replaying visits and stays on Projects", { timeout: 180_000 }, async t => {
  const fixture = await nativeUiFixture(t);
  await signIn(fixture.environment, fixture.node);
  const context = await fixture.page.context().browser()!.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  await page.goto(fixture.node.url);
  await page.getByTestId("login-username-input").fill(fixture.environment.username);
  await page.getByTestId("login-password-input").fill(fixture.environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("body.focus-ui .project-card").first().waitFor();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("body.view-sessions #sessionList .session-card").first().waitFor();

  const titles = await page.locator("#sessionList .session-card strong").evaluateAll(cards => cards.map(card => {
    const tail = card.querySelector(".session-title-tail");
    return { text: card.textContent!.trim(), size: getComputedStyle(card).fontSize, tailSize: tail ? getComputedStyle(tail).fontSize : null };
  }));
  assert.ok(titles.length > 0, "the project lists conversations to check");
  for (const title of titles) {
    assert.doesNotMatch(title.text, /(^|[\s\]])[a-z]/, `every word starts with a capital: ${title.text}`);
    if (title.tailSize) assert.equal(title.tailSize, title.size, `the last word is the same size as the title: ${title.text}`);
  }

  // Labelled titles split their last word into its own span; that word must stay the title's size.
  const sized = await page.evaluate(`(async () => {
    const { state } = await import("/app/state.js");
    const { renderSessions } = await import("/app/session-list.js");
    state.sessions[0].classification = "ux";
    renderSessions();
    const card = document.querySelector("#sessionList .session-card");
    const tail = card.querySelector(".session-title-tail");
    return { title: getComputedStyle(card.querySelector("strong")).fontSize, tail: tail ? getComputedStyle(tail).fontSize : null };
  })()`) as { title: string; tail: string | null };
  assert.ok(sized.tail, "a labelled title has a last-word span");
  assert.equal(sized.tail, sized.title, "the last word is the same size as the rest of the title");

  // Each Back lands on the base entry, and the app puts the entry above it back, so the page never leaves the app.
  const back = async (view: string) => {
    await page.evaluate(() => history.back());
    await page.locator(`body.view-${view}`).waitFor();
    await page.waitForFunction(() => history.state?.appTop === true);
  };
  await page.locator("#sessionList .session-card").first().click();
  await page.locator("body.view-chat").waitFor();
  await back("sessions");

  await page.locator("#sessionList .session-card").first().click();
  await page.locator("body.view-chat").waitFor();
  await page.evaluate(async () => (await import("/app/layout.js")).setMobileView("board"));
  await page.locator("body.view-board").waitFor();
  await back("sessions");
  await back("projects");
  await back("projects");
  assert.equal(new URL(page.url()).origin, new URL(fixture.node.url).origin, "Back on Projects stays in the app");

  // The control center sits under Projects, whichever view it was opened from.
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("body.view-sessions").waitFor();
  await page.evaluate(async () => (await import("/app/layout.js")).setMobileView("control"));
  await page.locator("body.view-control").waitFor();
  await back("projects");
});
