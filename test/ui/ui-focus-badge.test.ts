import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { api, signIn } from "../dev-nodes.js";

test("logo FAB reflects the live cross-project review count and clears at zero", { timeout: 180_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  const session = await signIn(environment, node);
  await api(node, session, "PUT", "/preferences", { focusUiEnabled: true });
  let count = 2;
  await page.route("**/api/reviews/pending", route => route.fulfill({
    json: { projects: node.projects.slice(0, count).map(project => ({
      projectId: project.id, projectName: project.name,
      sessions: [{ path: "review-fixture.jsonl", title: "Synthetic pending review", agentId: "pi", agentLabel: "Pi", updatedAt: "2026-09-24T12:00:00Z" }],
    })) },
  }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("body.focus-ui .project-card").first().waitFor();
  const fab = page.getByTestId("focus-controls-button");
  assert.equal(await fab.locator('img[src="/icon.svg"]').count(), 1, "FAB uses the actual Joint Bob logo");
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>("#focusControlsButton img")!.naturalWidth > 0);
  await page.waitForFunction(() => document.querySelector("#focusPendingBadge")!.textContent === "2");
  assert.equal(await page.getByTestId("focus-pending-badge").isVisible(), true);
  assert.match(await fab.getAttribute("aria-label") || "", /2.*review/);
  await fab.click();
  const menuBadge = page.getByTestId("focus-review-count");
  assert.equal(await menuBadge.textContent(), "2");
  assert.equal(await menuBadge.isVisible(), true);
  const row = await page.getByTestId("focus-reviews").boundingBox();
  const badge = await menuBadge.boundingBox();
  assert.ok(row && badge && badge.x >= row.x && badge.x + badge.width <= row.x + row.width, "counter stays inside the Needs review action");
  for (count of [1, 0]) {
    await page.getByTestId("focus-reviews").click();
    await page.getByTestId("pending-reviews-dialog").waitFor();
    await page.waitForFunction(expected => document.querySelector("#focusPendingBadge")!.textContent === String(expected), count);
    await page.getByTestId("pending-reviews-close-button").click();
    assert.equal(await page.getByTestId("focus-pending-badge").isVisible(), count > 0);
    assert.equal(await fab.getAttribute("aria-label"), count ? "Show controls, 1 conversation needs review" : "Show controls");
    await fab.click();
    assert.equal(await menuBadge.textContent(), String(count));
    assert.equal(await menuBadge.isVisible(), count > 0);
    assert.equal(await page.getByTestId("focus-reviews").getAttribute("aria-label"), count ? "Needs review, 1 conversation" : "Needs review");
  }
});
