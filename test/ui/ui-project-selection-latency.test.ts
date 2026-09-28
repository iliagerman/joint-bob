import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("project conversations become usable while shared quick notes are still loading", { timeout: 90_000 }, async (t) => {
  const { page, node, environment } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#projectList .project-card", { hasText: "Internal Assistant" }).waitFor();

  const target = node.projects.find(project => project.name === "Joint Bob")!;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void;
  const started = new Promise<void>(resolve => { requested = resolve; });
  // Simulate an unavailable shared peer, without changing conversation API responses.
  await page.route(`**/api/projects/${target.id}/quick-notes`, async route => {
    requested();
    await pending;
    await route.fulfill({ json: { notes: [] } });
  });
  try {
    await page.locator("#projectList .project-card", { hasText: "Joint Bob" }).click();
    await started;
    await page.locator('#sessionList [data-testid="session-menu-button"]').first().waitFor({ timeout: 3_000 });
    const snapshot = await page.evaluate(async () => {
      const { state } = await import("/app/state.js");
      return { projectId: state.activeProjectId, conversations: state.sessions.length };
    });
    assert.equal(snapshot.projectId, target.id);
    assert.ok(snapshot.conversations > 0, "the conversation list must not wait for remote quick notes");
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
