import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function login(page: any, environment: any, url: string): Promise<void> {
  await page.goto(url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByTestId("usage-open").waitFor();
}

test("usage dashboard edits subscription price and manual quota on desktop and mobile", { timeout: 240_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => errors.push(error.message));
  await login(page, environment, node.url);
  await page.getByTestId("usage-open").click();
  await page.getByTestId("usage-dialog").waitFor({ state: "visible" });
  await page.getByTestId("usage-summary").waitFor();
  assert.ok(await page.getByTestId("usage-breakdowns").getByRole("table").count() >= 1);

  await page.getByTestId("subscription-add").click();
  await page.getByTestId("subscription-provider").fill("anthropic");
  await page.getByTestId("subscription-account-label").fill("Work account");
  await page.getByTestId("subscription-plan-name").fill("Max");
  await page.getByTestId("subscription-price").fill("200");
  await page.getByTestId("quota-add").click();
  await page.getByTestId("quota-label").fill("Monthly messages");
  await page.getByTestId("quota-used").fill("25");
  await page.getByTestId("quota-limit").fill("100");
  await page.getByTestId("quota-reset").fill("2030-01-02T12:00");
  await page.getByTestId("subscription-save").click();
  const card = page.getByTestId("subscription-card").filter({ hasText: "Work account" });
  await card.getByText("$200/month", { exact: true }).waitFor();
  await card.getByText("75 remaining", { exact: false }).waitFor();
  await card.getByText("Manual snapshot", { exact: false }).waitFor();
  await card.getByText("resets", { exact: false }).waitFor();

  await card.getByTestId("subscription-edit").click();
  await page.getByTestId("subscription-price").fill("210");
  await page.getByTestId("subscription-save").click();
  await card.getByText("$210/month", { exact: true }).waitFor();

  await page.getByTestId("subscription-add").click();
  await page.getByTestId("subscription-provider").fill("openai");
  await page.getByTestId("subscription-account-label").fill("Second account");
  await page.getByTestId("subscription-plan-name").fill("Plus");
  await page.getByTestId("subscription-price").fill("20");
  await page.getByTestId("subscription-save").click();
  await page.getByTestId("subscription-card").filter({ hasText: "Second account" }).getByText("$20/month", { exact: true }).waitFor();
  assert.equal(await page.getByTestId("subscription-card").count(), 2, "creating after editing must not overwrite the first plan");
  await card.getByText("$210/month", { exact: true }).waitFor();
  const classificationFilter = page.getByTestId("usage-classification-filter");
  if (await classificationFilter.locator("option").count() > 1) {
    await classificationFilter.selectOption({ index: 1 });
    assert.notEqual(await classificationFilter.inputValue(), "", "existing classification scopes usage");
  }
  await page.getByTestId("usage-close").click();
  await page.getByTestId("usage-open").click();
  await card.getByText("$210/month", { exact: true }).waitFor();

  await page.setViewportSize({ width: 390, height: 500 });
  const box = await page.getByTestId("usage-dialog").locator(".usage-card").boundingBox();
  assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 500);
  assert.equal(await page.getByTestId("usage-dialog").evaluate((dialog: HTMLElement) => dialog.scrollWidth <= dialog.clientWidth), true);
  assert.deepEqual(errors, []);
});
