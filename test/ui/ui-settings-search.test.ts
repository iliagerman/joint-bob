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

  // A query nothing matches says so.
  await search.fill("zqxjv");
  await page.getByText("No settings match").waitFor({ timeout: 10_000 });

  assert.deepEqual(errors, []);
});
