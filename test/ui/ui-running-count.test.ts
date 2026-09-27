import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("the running conversations button shows how many conversations are running", { timeout: 120_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.locator('#loginDialog[open]').waitFor();
  await page.locator("#loginUsernameInput").fill(environment.username);
  await page.locator("#loginPasswordInput").fill(environment.password);
  await page.locator("#loginSubmitButton").click();
  await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3 && !document.body.classList.contains("booting"));
  const badge = page.getByTestId("running-conversations-open-button").locator("[data-running-count]");
  assert.equal(await badge.isHidden(), true, "no badge while nothing runs");

  await page.evaluate(`(async () => {
    const originalFetch = window.fetch;
    window.fetch = async (...args) => {
      if (new URL(String(args[0]), location.href).pathname !== '/api/running') return originalFetch(...args);
      const session = (id) => ({ id, path: id, title: id, running: true, turnRunning: true });
      return new Response(JSON.stringify({ projects: [
        { projectId: 'a', projectName: 'A', sessions: [session('one'), session('two')] },
        { projectId: 'b', projectName: 'B', sessions: [session('three')] },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const { refreshRunningConversations } = await import('/app/running.js');
    await refreshRunningConversations();
  })()`);
  assert.equal(await badge.textContent(), "3");
  assert.equal(await badge.isVisible(), true);
  assert.equal(await page.getByTestId("running-conversations-open-button").getAttribute("aria-label"), "Running conversations, 3 running");
});
