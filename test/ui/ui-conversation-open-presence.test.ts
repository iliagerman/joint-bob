import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("a local conversation opens while unrelated node discovery is still pending", { timeout: 90_000 }, async (t) => {
  const { page, node, environment } = await nativeUiFixture(t);
  const project = node.projects.find(project => project.name === "Joint Bob")!;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let requested!: () => void;
  const started = new Promise<void>(resolve => { requested = resolve; });
  const local = { id: node.nodeId, name: node.name, local: true, online: true, mapped: true };
  const targeted: string[] = [];
  await page.route(`**/api/projects/${project.id}/session-nodes*`, async route => {
    const target = new URL(route.request().url()).searchParams.get("nodeId");
    if (target) targeted.push(target);
    else { requested(); await pending; }
    await route.fulfill({ json: { nodes: [local] } });
  });
  try {
    await page.goto(node.url);
    await page.getByTestId("login-username-input").fill(environment.username);
    await page.getByTestId("login-password-input").fill(environment.password);
    await page.getByTestId("login-submit-button").click();
    await page.locator("#projectList .project-card", { hasText: "Joint Bob" }).click();
    await started;
    const first = page.locator("#sessionList .session-card").first();
    await first.waitFor();
    const before = await page.evaluate(async nodeId => {
      const { state } = await import("/app/state.js");
      // Simulate a known local execution owner with a cold node directory.
      for (const session of state.sessions) session.executionNodeId = nodeId;
      return state.sessionNodes.length;
    }, node.nodeId);
    assert.equal(before, 0, "the inventory request has not supplied local-node information");
    const socketOpened = page.waitForEvent("websocket", {
      predicate: socket => { const url = new URL(socket.url()); return url.pathname === "/ws" && url.searchParams.get("sessionPath") !== "watch"; },
      timeout: 5_000,
    });
    await first.click();
    const socket = await socketOpened;
    assert.equal(new URL(socket.url()).searchParams.get("nodeId"), node.nodeId);
    assert.deepEqual(targeted, [node.nodeId], "only the selected owner is refreshed before opening");

    const retained = await page.evaluate(async local => {
      const { state } = await import("/app/state.js");
      const { loadSessionNodes } = await import("/app/chat-controls.js");
      const other = { id: "unrelated", name: "Other node", local: false, online: true, mapped: true };
      state.sessionNodes = [local, other];
      await loadSessionNodes(state.activeProjectId, local.id);
      return state.sessionNodes.map(node => node.id).sort();
    }, local);
    assert.deepEqual(retained, [node.nodeId, "unrelated"].sort(), "a targeted refresh preserves other node-picker choices");
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
