import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

// A pool for a whole group is a relay rule, set on the relay's own Pools tab. A machine that
// serves no relay group says so there, and Assignments lists no relay rule.
test("Settings → Relay → Pools sets a relay's pool rule; with no relay group it says so and Assignments has no relay note", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const failed: string[] = [];
  page.on("response", (response) => { if (response.status() >= 400 && /relay\/subscription-pool|relay-rules/.test(response.url())) failed.push(`${response.status()} ${response.url()}`); });
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#loginDialog[open]").waitFor({ state: "hidden" });

  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-relay").click();
  await page.getByTestId("relay-tab-pools").click();
  const rule = page.getByTestId("relay-pool-rule");
  await rule.getByText("serves no relay group").waitFor();
  assert.equal(await page.getByTestId("relay-pools-section").isVisible(), true);
  assert.equal(await page.getByTestId("relay-pool-select").count(), 0, "no group, so no pool to choose");

  await page.getByTestId("settings-tab-connections").click();
  await page.getByTestId("provider-profiles-tab-assignments").click();
  await page.getByTestId("provider-assignment-default").waitFor();
  assert.equal(await page.getByTestId("provider-assignment-cluster-note").count(), 0, "no relay rule applies here");
  assert.deepEqual(failed, []);
  assert.deepEqual(pageErrors, []);
});
