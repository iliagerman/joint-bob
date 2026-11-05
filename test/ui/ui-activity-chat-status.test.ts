import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

for (const width of [1440, 390]) {
  test(`Activity Chat shows sending, processing, completion and failure at ${width}px`, { timeout: 120_000 }, async t => {
    const { page, environment, node } = await nativeUiFixture(t);
    await page.setViewportSize({ width, height: 844 });
    let snapshot: any = { messages: [], queue: [], busy: false, readOnly: true, accountIds: [], model: null,
      defaults: { showSelectors: true, model: null } };
    let releasePost: (() => void) | undefined;
    const posted = new Promise<void>(resolve => { releasePost = resolve; });
    t.after(() => releasePost?.());
    await page.route("**/api/projects/*/conversations/*/chat", async route => {
      if (route.request().method() === "POST") {
        const request = route.request().postDataJSON();
        snapshot = { ...snapshot, busy: true, messages: [{ id: request.id, role: "user", text: request.question }] };
        await posted;
        await route.fulfill({ status: 202, json: {} });
      } else await route.fulfill({ json: snapshot });
    });
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
    const status = page.getByTestId("conversation-chat-status");
    await status.filter({ hasText: "Ready" }).waitFor();
    await page.getByTestId("conversation-chat-input").fill("What is running?");
    await page.getByTestId("conversation-chat-send").click();
    await status.filter({ hasText: "Sending" }).waitFor();
    releasePost!();
    await status.filter({ hasText: "Processing" }).waitFor();
    assert.equal(await status.getAttribute("data-state"), "working");
    assert.equal(await page.getByTestId("conversation-chat-settings").getAttribute("open"), null, "status is visible with settings closed");
    const box = (await status.boundingBox())!;
    assert.ok(box.height >= 20 && box.y >= 0 && box.y + box.height <= 844, "processing status stays visible above the composer");
    assert.equal(await page.getByTestId("conversation-chat-send").getAttribute("aria-label"), "Queue");
    assert.equal(await page.getByTestId("conversation-chat-send").locator("svg").count(), 1, "queue keeps the send icon");
    snapshot = { ...snapshot, busy: false, messages: [...snapshot.messages, { id: "answer", role: "assistant", text: "All done" }] };
    await page.evaluate(() => document.dispatchEvent(new Event("conversation-chat-reconnected")));
    await status.filter({ hasText: "Ready" }).waitFor();
    assert.equal(await status.getAttribute("data-state"), "idle");
    snapshot = { ...snapshot, messages: [{ id: "failed", role: "user", text: "Question", error: "Pool exhausted" }] };
    await page.evaluate(() => document.dispatchEvent(new Event("conversation-chat-reconnected")));
    await status.filter({ hasText: "Failed: Pool exhausted" }).waitFor();
    assert.equal(await status.getAttribute("data-state"), "error");
  });
}
