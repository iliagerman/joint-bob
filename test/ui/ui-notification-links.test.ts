import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

async function assertOpened(page: import("playwright-core").Page, target: { id: string; path: string; title: string }): Promise<void> {
  const state = await page.evaluateHandle(async () => (await import("/app/state.js")).state);
  try {
    await page.waitForFunction(({ state, target }) => state.preferencesLoaded
      && state.activeSessionId === target.id
      && state.activeSessionPath === target.path
      && document.querySelector("#sessionTitle")!.textContent === target.title, { state, target });
  } finally {
    await state.dispose();
  }
  assert.equal(await page.locator("#sessionTitle").textContent(), target.title);
}

test("notification links open stable conversation IDs, project aliases, and legacy paths", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator("#loginDialog[open]").waitFor();
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator("#projectList .project-card", { hasText: "Internal Assistant" }).click();
  const state = await page.evaluateHandle(async () => (await import("/app/state.js")).state);
  try {
    await page.waitForFunction(state => state.preferencesLoaded
      && state.sessions.filter(session => !session.readOnly).length >= 2, state);
  } finally {
    await state.dispose();
  }
  const selected = await page.evaluate(async () => {
    const { state } = await import("/app/state.js");
    const sessions = state.sessions.filter((session) => !session.readOnly).slice(0, 2);
    return { projectId: state.activeProjectId, target: { id: sessions[0].conversationId || sessions[0].id, path: sessions[0].path, title: sessions[0].title }, other: sessions[1] };
  });
  assert.equal(Boolean(selected.target && selected.other), true, "fixture needs two writable conversations");
  await page.evaluate(async (other) => (await import("/app/reviews.js")).openListedSession(other), selected.other);
  assert.notEqual(await page.evaluate(async () => (await import("/app/state.js")).state.activeSessionPath), selected.target.path);

  const stableUrl = `${node.url}/?projectId=${encodeURIComponent(selected.projectId)}&sessionId=${encodeURIComponent(selected.target.id)}`;
  await page.goto(stableUrl);
  await assertOpened(page, selected.target);
  await page.reload();
  await assertOpened(page, selected.target);

  const alias = `notification-link-alias-${Date.now()}`;
  const db = new DatabaseSync(path.join(node.dataDir, "node.db"));
  db.prepare("INSERT INTO project_aliases(alias_id,project_id,created_at) VALUES(?,?,?)").run(alias, selected.projectId, new Date().toISOString());
  db.close();
  await page.goto(`${node.url}/?projectId=${encodeURIComponent(alias)}&sessionId=${encodeURIComponent(selected.target.id)}`);
  await assertOpened(page, selected.target);
  assert.equal(await page.evaluate(async () => (await import("/app/state.js")).state.activeProjectId), selected.projectId);

  await page.goto(`${node.url}/?projectId=${encodeURIComponent(selected.projectId)}&sessionPath=${encodeURIComponent(selected.target.path)}`);
  await assertOpened(page, selected.target);
});
