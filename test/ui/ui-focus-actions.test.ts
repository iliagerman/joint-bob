import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";
import { api, signIn } from "../dev-nodes.js";

const actions = ["focus-new-conversation", "focus-new-note", "focus-reviews", "focus-running"];

test("focus actions work before choosing a project, on lists and in chat; classic wizard stays unchanged", { timeout: 180_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card").first().waitFor();
  await page.getByTestId("settings-open-button").click();
  await page.getByTestId("settings-focus-ui-toggle").check();
  await page.waitForFunction(() => document.body.classList.contains("focus-ui"));
  await page.getByTestId("settings-cancel-button").click();
  // No active project yet: note creation must still offer a project picker.
  await page.getByTestId("focus-controls-button").click();
  for (const action of actions) assert.equal(await page.getByTestId(action).isVisible(), true, `${action} available on Projects`);
  await page.getByTestId("focus-new-note").click();
  await page.getByTestId("quick-note-dialog").waitFor();
  await page.getByTestId("quick-note-save-button").waitFor({ state: "visible" });
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("[data-testid='quick-note-save-button']")!.disabled);
  await page.getByTestId("quick-note-project-select").fill("Joint Bob");
  await page.getByTestId("quick-note-project-options").getByRole("option", { name: "Joint Bob", exact: true }).click();
  await page.getByTestId("quick-note-title-input").fill("Focus action note");
  await page.getByTestId("quick-note-save-button").click();
  await page.getByTestId("quick-note-dialog").waitFor({ state: "hidden" });
  const session = await signIn(environment, node);
  const project = node.projects.find(project => project.name === "Joint Bob")!;
  const notes = await api<{ notes: Array<{ title: string }> }>(node, session, "GET", `/projects/${project.id}/quick-notes`);
  assert.ok(notes.body.notes.some(note => note.title === "Focus action note"), "note persisted in the chosen project");
  assert.equal(await page.locator("body.view-projects").count(), 1, "creating a note does not navigate away");
  for (const view of ["projects", "sessions", "chat"]) {
    if (view === "sessions") await page.locator(".project-card", { hasText: "Internal Assistant" }).first().click();
    if (view === "chat") await page.locator("#sessionList .session-card").first().click();
    await page.locator(`body.view-${view}`).waitFor();
    await page.getByTestId("focus-controls-button").click();
    for (const action of actions) assert.equal(await page.getByTestId(action).isVisible(), true, `${action} available on ${view}`);
    await page.getByTestId("focus-reviews").click();
    await page.getByTestId("pending-reviews-dialog").waitFor();
    await page.getByTestId("pending-reviews-close-button").click();
    await page.getByTestId("focus-controls-button").click();
    await page.getByTestId("focus-running").click();
    await page.getByTestId("running-conversations-dialog").waitFor();
    await page.getByTestId("running-conversations-close-button").click();
    assert.equal(await page.locator(`body.view-${view}`).count(), 1, "inspection preserves current screen");
  }
  await page.setViewportSize({ width: 390, height: 460 });
  await page.getByTestId("focus-controls-button").click();
  for (const action of actions) {
    const box = await page.getByTestId(action).boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 460, `${action} reachable without scrolling long chat controls`);
  }
  await page.getByTestId("focus-settings").click();
  await page.getByTestId("settings-focus-ui-toggle").uncheck();
  await page.waitForFunction(() => !document.body.classList.contains("focus-ui"));
  await page.getByTestId("settings-cancel-button").click();
  for (const action of actions) assert.equal(await page.getByTestId(action).isVisible(), false);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTestId("session-create-button").click();
  await page.getByTestId("new-session-name-dialog").waitFor();
  assert.equal(await page.getByTestId("new-session-project-select").isVisible(), false, "classic wizard has no focus-only project picker");
  await page.getByTestId("new-session-name-cancel-button").click();
});
