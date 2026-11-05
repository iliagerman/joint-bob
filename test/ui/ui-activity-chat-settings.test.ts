import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

for (const width of [1440, 390]) {
  test(`Activity Chat settings collapse to leave room for messages at ${width}px`, { timeout: 120_000 }, async t => {
    const { page, environment, node } = await nativeUiFixture(t);
    await page.setViewportSize({ width, height: 844 });
    await page.goto(node.url);
    await page.locator("#loginDialog[open]").waitFor();
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.getByText("Internal Assistant", { exact: true }).click();
    await page.getByText("Short one", { exact: true }).click();
    await page.getByTestId("chat-message-input").fill("/bob-btw");
    await page.locator("#composer").evaluate((form: HTMLFormElement) => form.requestSubmit());
    await page.getByTestId("activity-chat-tab").click();
    const toggle = page.getByTestId("conversation-chat-settings-toggle");
    await toggle.waitFor();
    const readOnly = page.getByTestId("conversation-chat-read-only");
    assert.equal(await readOnly.isVisible(), false);
    const clear = page.getByTestId("conversation-chat-clear");
    assert.equal(await clear.isVisible(), true, "clear conversation stays visible with settings closed");
    assert.equal(await clear.textContent(), "Clear conversation");
    const cleared = page.waitForResponse(response => response.url().endsWith("/chat") && response.request().method() === "DELETE");
    await clear.click();
    assert.equal((await cleared).status(), 200);
    await toggle.click();
    assert.equal(await readOnly.isVisible(), true);
    const modeSaved = page.waitForResponse(response => response.url().endsWith("/chat") && response.request().method() === "PATCH");
    await readOnly.uncheck();
    assert.equal((await modeSaved).status(), 200);
    const messages = page.getByTestId("conversation-chat-messages");
    const expandedHeight = (await messages.boundingBox())!.height;
    await toggle.click();
    assert.equal(await readOnly.isVisible(), false);
    const collapsedHeight = (await messages.boundingBox())!.height;
    assert.ok(collapsedHeight > expandedHeight + 100, "collapsing settings gives the conversation more space");
    await page.getByTestId("conversation-chat-input").fill("Keep this draft");
    await toggle.focus();
    await page.keyboard.press("Enter");
    assert.equal(await readOnly.isChecked(), false, "settings survive collapsing");
    await page.keyboard.press("Enter");
    assert.equal(await page.getByTestId("conversation-chat-input").inputValue(), "Keep this draft");
    const input = (await page.getByTestId("conversation-chat-input").boundingBox())!;
    assert.ok(input.y + input.height <= 844, "the composer stays on screen");
  });
}
