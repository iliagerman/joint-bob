import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("settings search finds a setting by its name, opens its section, and flashes the row", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.goto(node.url, { waitUntil: "domcontentloaded" });
  await page.locator("#loginDialog[open]").waitFor({ timeout: 30_000 });
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).waitFor({ timeout: 30_000 });

  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-tab-conversations").click();

  // Sections are grouped in the sidebar, each with a coloured icon tile.
  assert.deepEqual(await page.locator(".settings-group-label").allTextContents(), ["You", "Workspace", "Agents", "Network", "This node"]);
  assert.ok(await page.locator('[data-testid="settings-tab-account"] .settings-tab-icon').isVisible());

  // A field name finds its setting even when another section is open.
  const search = page.getByTestId("settings-search-input");
  await search.fill("mfa");
  const results = page.getByTestId("settings-search-result");
  await results.first().waitFor({ timeout: 10_000 });
  assert.match(await results.first().textContent() ?? "", /Multi-factor authentication/);
  await results.first().click();

  assert.equal(await page.getByTestId("settings-tab-account").getAttribute("aria-selected"), "true", "the matching section opens");
  await page.locator("#settingsPanel-account .settings-hit").first().waitFor({ timeout: 10_000 });
  assert.equal(await search.inputValue(), "", "the search clears after a pick");

  // A section name finds its tab.
  await search.fill("harnesses");
  await results.first().waitFor({ timeout: 10_000 });
  await search.press("Enter");
  assert.equal(await page.getByTestId("settings-tab-engines").getAttribute("aria-selected"), "true");

  // A saved account can be found by name or variable from anywhere, even when
  // the Secrets list is currently filtered to another provider.
  await page.getByTestId("settings-tab-secrets").click();
  await page.getByTestId("secret-account-add-button").click();
  await page.getByTestId("secret-account-label-input").fill("Search fixture billing");
  await page.getByTestId("secret-variable-name-input").first().fill("BILLING_SEARCH_KEY");
  await page.getByTestId("secret-variable-value-input").first().fill("synthetic-only");
  await page.getByTestId("secret-variable-value-input").nth(1).fill("synthetic-only");
  const created = page.waitForResponse((response) => response.url().endsWith("/api/secrets/accounts") && response.request().method() === "POST");
  await page.getByTestId("secret-account-save-button").click();
  assert.equal((await created).status(), 201);
  await page.getByTestId("secret-account-dialog").waitFor({ state: "hidden" });
  await page.getByTestId("secret-type-select").click();
  await page.getByTestId("secret-type-select-search").fill("stripe");
  await page.getByTestId("secret-type-select-option").getByText("Stripe").click();
  await page.getByTestId("settings-tab-account").click();
  await search.fill("BILLING_SEARCH_KEY");
  await results.getByText("Search fixture billing").waitFor();
  await results.getByText("Search fixture billing").click();
  assert.equal(await page.getByTestId("settings-tab-secrets").getAttribute("aria-selected"), "true");
  const accountRow = page.getByTestId("secret-account-list").locator(".secret-account-row").filter({ hasText: "Search fixture billing" });
  await accountRow.waitFor();
  assert.ok(await accountRow.evaluate((row) => row.classList.contains("settings-hit")));
  assert.equal(await page.getByTestId("secret-account-search").inputValue(), "Search fixture billing");
  assert.equal(await page.getByTestId("secret-type-select").getAttribute("data-value"), "all");
  await search.fill("Search fixture billing");
  await results.getByText("Search fixture billing").waitFor();
  await search.fill("synthetic-only");
  await page.getByText("No settings match").waitFor({ timeout: 10_000 });

  // A query nothing matches says so.
  await search.fill("zqxjv");
  await page.getByText("No settings match").waitFor({ timeout: 10_000 });

  assert.deepEqual(errors, []);
});
