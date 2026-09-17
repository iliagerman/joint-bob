import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("project files read as a compact desktop file explorer", async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.getByText("Internal Assistant", { exact: true }).click();
  await page.locator('[data-filter="all"]').click();
  await page.locator("#sessionList .list-row", { hasText: "Short one" }).locator("button").first().click();
  await page.waitForFunction(() => import("/app/state.js").then(({ state }) => Boolean(state.activeConversationId || state.activeSessionId)));
  await page.route("**/api/projects/*/files?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ path: "", entries: [
      { name: "public", path: "public", type: "directory", size: null },
      { name: "README.md", path: "README.md", type: "file", size: 4096 },
    ] }),
  }));
  if (await page.getByTestId("chat-more-button").isVisible()) await page.getByTestId("chat-more-button").click();
  await page.getByTestId("chat-files-button").click();

  const dialog = page.getByTestId("project-files-dialog");
  await dialog.waitFor();
  const header = dialog.getByTestId("project-files-columns");
  await header.waitFor();
  assert.deepEqual(await header.locator("span").allTextContents(), ["Name", "Size", "Actions"]);

  const folder = dialog.getByTestId("project-files-folder").first();
  await folder.waitFor();
  assert.equal(await folder.locator("svg").count(), 1, "folders need a recognizable icon");
  const file = dialog.getByTestId("project-files-file").first();
  await file.waitFor();
  assert.equal(await file.locator("svg").count(), 1, "files need a recognizable icon");
  assert.equal((await dialog.getByTestId("project-files-copy-button").first().textContent())?.trim(), "", "copy is an icon action");
  assert.equal((await dialog.getByTestId("project-files-delete-button").first().textContent())?.trim(), "", "delete is an icon action");

  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const geometry = await dialog.evaluate((element) => {
    const card = element.querySelector(".file-explorer-card")!.getBoundingClientRect();
    const row = element.querySelector(".file-explorer-row")!.getBoundingClientRect();
    return { width: card.width, rowHeight: row.height };
  });
  assert.ok(geometry.width >= 680, `explorer width ${geometry.width}px should fit real file columns`);
  assert.ok(geometry.rowHeight >= 38 && geometry.rowHeight <= 48, `row height ${geometry.rowHeight}px should stay compact`);
});
