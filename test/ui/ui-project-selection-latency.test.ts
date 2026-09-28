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

test("project summaries render without waiting for cold harness metadata or loading chat histories", { timeout: 90_000 }, async (t) => {
  const { page, node, environment } = await nativeUiFixture(t);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/harnesses", async route => { await pending; await route.continue(); });
  const chatSockets: string[] = [];
  page.on("websocket", socket => {
    const url = new URL(socket.url());
    if (url.pathname === "/ws" && url.searchParams.get("sessionPath") !== "watch") chatSockets.push(url.pathname);
  });
  try {
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    const project = page.locator("#projectList .project-card", { hasText: "Joint Bob" });
    await project.waitFor();
    await project.click();
    await page.locator('#sessionList [data-testid="session-menu-button"]').first().waitFor({ timeout: 3_000 });
    const state = await page.evaluate(async () => {
      const { state } = await import("/app/state.js");
      return { conversations: state.sessions.length, harnesses: state.harnesses.length };
    });
    assert.equal(state.harnesses, 0, "the metadata request is still pending");
    assert.ok(state.conversations > 0, "summaries do not need model or harness discovery");
    assert.deepEqual(chatSockets, [], "opening a project must not open each conversation's message stream");
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("slow project openings log request versus rendering time without project or conversation data", { timeout: 90_000 }, async (t) => {
  const { page, node, environment } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  const project = page.locator("#projectList .project-card", { hasText: "Joint Bob" });
  await project.waitFor();
  const target = node.projects.find(project => project.name === "Joint Bob")!;
  let release!: () => void, requested!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { requested = resolve; });
  await page.route(`**/api/projects/${target.id}/sessions`, async route => { requested(); await pending; await route.continue(); });
  await page.clock.install();
  try {
    await project.click();
    await started;
    await page.clock.runFor(650);
    release();
    await page.waitForFunction(() => window.jointBobClientLogs.entries().some(line => line.includes("[performance] project.open")));
    const line = await page.evaluate(() => window.jointBobClientLogs.entries().find(line => line.includes("[performance] project.open"))!);
    const timing = JSON.parse(line.slice(line.indexOf("{")));
    assert.deepEqual(Object.keys(timing).sort(), ["conversations", "durationMs", "renderMs", "requestMs"]);
    assert.ok(timing.requestMs >= 600 && timing.durationMs >= timing.requestMs);
    assert.ok(timing.renderMs >= 0 && timing.conversations > 0);
    assert.equal(line.includes(target.id), false);
    assert.equal(line.includes(target.path), false);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
