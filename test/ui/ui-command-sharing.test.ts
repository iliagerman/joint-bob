import assert from "node:assert/strict";
import test from "node:test";
import { nativeUiFixture } from "./native-ui-fixture.js";

test("command settings preserve identity and drafts, expose scoped sharing and read-only received commands", { timeout: 240_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  await page.goto(node.url);
  await page.getByTestId("login-username-input").fill(environment.username);
  await page.getByTestId("login-password-input").fill(environment.password);
  await page.getByTestId("login-submit-button").click();
  await page.locator(".project-card", { hasText: "Internal Assistant" }).first().waitFor();
  await page.evaluate(async () => (await import("/app/settings.js")).openSettings("commands"));
  await page.getByTestId("add-saved-command").click();
  await page.getByTestId("saved-command-name").fill("Share review");
  await page.getByTestId("saved-command-prompt").fill("Review carefully");
  const id = await page.locator(".saved-command-row").getAttribute("data-command-id");
  assert.match(id!, /^[0-9a-f-]{36}$/);
  await page.getByTestId("saved-command-share").click();
  assert.equal(await page.getByTestId("command-share-dialog").count(), 0, "Unsaved command cannot be shared");
  assert.equal(await page.getByTestId("saved-command-prompt").inputValue(), "Review carefully");
  await page.getByTestId("settings-save-button").click();
  await page.locator("#settingsDialog[open]").waitFor({ state: "hidden" });
  let refreshes = 0;
  const opaque = "owner/account/preset";
  await page.route("**/api/commands/sharing", async (route) => {
    refreshes++;
    await route.fulfill({ json: {
      commands: [{ id: opaque, presetId: id, kind: "local", name: "Share review", prompt: "Review carefully", clusterIds: [], nodeIds: [], workspaceIds: [], projectIds: [], conversations: [] }, { id: "received", kind: "received", name: "Peer command", prompt: "Peer prompt", receivedFromName: "Test peer" }],
      clusters: [{ id: "cluster", name: "Team" }], nodes: [{ nodeId: "peer", name: "Peer" }], workspaces: [{ id: "workspace", label: "Work" }], projects: [{ id: "project", name: "Project" }],
    } });
  });
  await page.route("**/api/projects/project/sessions", (route) => route.fulfill({ json: { sessions: [{ conversationId: "conversation", title: "Thread" }] } }));
  let saved: unknown;
  await page.route("**/api/commands/*/sharing", async (route) => {
    assert.equal(decodeURIComponent(new URL(route.request().url()).pathname), `/api/commands/${opaque}/sharing`);
    saved = route.request().postDataJSON(); await route.fulfill({ json: { ok: true } });
  });
  await page.evaluate(async () => (await import("/app/settings.js")).openSettings("commands"));
  assert.equal(await page.locator(".saved-command-row").getAttribute("data-command-id"), id);
  await page.getByTestId("received-commands-list").getByText("Peer command").waitFor();
  assert.match(await page.getByTestId("received-commands-list").innerText(), /From Test peer · Read only/);
  assert.equal(await page.getByTestId("received-commands-list").locator("input,textarea,button").count(), 0);
  const before = refreshes;
  const refreshed = page.waitForResponse((response) => response.url().endsWith("/api/commands/sharing"));
  await page.getByTestId("received-commands-refresh").click();
  await refreshed;
  assert.ok(refreshes > before);
  await page.getByTestId("saved-command-prompt").fill("Unsaved edit");
  await page.getByTestId("saved-command-share").click();
  assert.equal(await page.getByTestId("command-share-dialog").count(), 0);
  await page.getByTestId("saved-command-prompt").fill("Review carefully");
  // Sharing is independent of other settings and must leave their unsaved values alone.
  await page.locator("#settingsStartConversationPrompt").fill("Keep unsaved settings", { force: true });
  await page.getByTestId("saved-command-share").click();
  await page.getByTestId("command-share-dialog").waitFor();
  for (const field of ["clusterIds", "nodeIds", "workspaceIds", "projectIds"]) await page.getByTestId(`command-share-${field}`).check();
  await page.getByTestId("command-share-conversation-project").selectOption("project");
  await page.getByTestId("command-share-conversations").check();
  await page.getByTestId("command-share-save").click();
  await page.getByTestId("command-share-dialog").waitFor({ state: "detached" });
  assert.deepEqual(saved, { clusterIds: ["cluster"], nodeIds: ["peer"], workspaceIds: ["workspace"], projectIds: ["project"], conversations: [{ projectId: "project", conversationId: "conversation" }] });
  assert.equal(await page.locator("#settingsStartConversationPrompt").inputValue(), "Keep unsaved settings");
});
