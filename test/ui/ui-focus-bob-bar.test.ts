import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { signIn } from "../dev-nodes.js";

test("phone focus keeps Bob in the top bar and edits a queued message full screen", { timeout: 180_000 }, async t => {
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

  const fab = page.getByTestId("focus-controls-button");
  const panelOf = () => fab.evaluate(button => button.closest("header")?.parentElement?.id);
  assert.equal(await panelOf(), "projectsPanel", "projects: Bob sits in the projects top bar");

  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
  await page.locator("#sessionList .session-card").first().click();
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>("#messageInput")!.disabled);
  assert.equal(await panelOf(), "chatPanel", "chat: Bob sits in the conversation top bar");
  const handle = await fab.boundingBox();
  assert.ok(handle && handle.y < 80, "Bob's handle is in the header, not floating over the messages");

  await fab.tap();
  // A tap opens the menu once the gesture window closes, so wait for it rather than sampling at once.
  await page.locator("#focusControls").waitFor({ state: "visible" });
  const menu = await page.locator("#focusControls").boundingBox();
  assert.ok(menu && menu.y >= handle.y + handle.height, "the menu drops down from the handle");
  await page.getByTestId("focus-close").tap();

  await page.evaluate(async () => {
    const transcript = await import("/app/chat-transcript.js");
    transcript.markMessageQueued(transcript.appendMessage("user", "Original message\n\nSecond paragraph."), 71, "Original message\n\nSecond paragraph.");
  });
  await page.getByTestId("queued-message-edit-button").tap();
  await page.locator(".queued-editor").waitFor({ state: "visible" });
  const editor = await page.locator(".queued-editor").boundingBox();
  assert.ok(editor && editor.x === 0 && editor.y === 0 && editor.width === 390 && editor.height === 844, `the editor covers the screen: ${JSON.stringify(editor)}`);
  const save = await page.getByTestId("queued-message-save-button").boundingBox();
  const cancel = await page.getByTestId("queued-message-edit-cancel-button").boundingBox();
  assert.ok(save && cancel && cancel.y === save.y && cancel.x < save.x, "Cancel sits left of Save on one row");
  assert.ok(save.y + save.height <= 844, "Save is on screen");
  const text = await page.getByTestId("queued-message-edit-input").boundingBox();
  assert.ok(text && text.height > 200, `the text box fills the screen: ${text?.height}px`);
  assert.equal(await page.locator(".queued-editor-hints").isVisible(), false, "the keyboard hints are desktop-only");
  await page.getByTestId("queued-message-edit-close-button").tap();
  await page.getByTestId("queued-message-edit-input").waitFor({ state: "hidden" });
});
