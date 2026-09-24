import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserSessionView } from "../../src/browser-types.js";
import { signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";

// The actual viewer, synthetic metadata and loopback server. No website or saved login is opened.
test("browser profiles explain identity, separate opening from viewing, and group controls on phones", { timeout: 120_000 }, async t => {
  const { page, environment, node } = await nativeUiFixture(t);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const identity = { projectId: "fixture", engine: "pi" as const, conversationId: "conversation", appNodeId: node.nodeId };
  const profiles = [
    { id: "11111111-1111-4111-8111-111111111111", label: "WhatsApp", persistent: true, createdAt: "2026-09-12T13:00:00Z" },
    { id: "22222222-2222-4222-8222-222222222222", label: "WhatsApp Homeserver", persistent: true, createdAt: "2026-09-10T13:00:00Z" },
  ];
  let session: BrowserSessionView | null = null;
  const starts: Array<Record<string, unknown>> = [];
  await page.route("**/api/browser/**", async route => {
    const request = route.request(), url = new URL(request.url());
    let result: unknown = {};
    if (url.pathname === "/api/browser/status") result = { config: { executorNodeId: node.nodeId }, nodes: [{ id: node.nodeId, name: "Homeserver", available: true, reachable: true }] };
    else if (url.pathname === "/api/browser/preferences") result = { nodeId: null, effectiveNodeId: node.nodeId };
    else if (url.pathname === "/api/browser/profiles") result = { profiles };
    else if (url.pathname === "/api/browser/sessions" && request.method() === "POST") {
      const body = request.postDataJSON(); starts.push({ ...body, nodeId: url.searchParams.get("nodeId") });
      const profile = profiles.find(item => item.id === body.profileId)!;
      session = { ...identity, id: "session", nodeId: node.nodeId, profileId: profile.id, profileLabel: profile.label, state: "running", owner: "agent", canControl: true, activePageId: "blank", tabs: [{ id: "blank", title: "New tab", url: "about:blank" }], downloads: [], restoreOnRestart: true, createdAt: "2026-09-12T13:00:00Z", updatedAt: "2026-09-12T13:00:00Z", fileChooser: false, fileChooserRequest: null, dialog: null };
      result = { session };
    } else if (url.pathname === "/api/browser/sessions") result = { sessions: session ? [session] : [] };
    else if (url.pathname.endsWith("/command")) {
      const command = request.postDataJSON();
      assert.ok(session, "browser commands require an open session");
      if (command.action === "takeControl") session.owner = "human";
      if (command.action === "resumeAgent") session.owner = "agent";
      if (command.action === "close") { session.state = "closed"; session.restoreOnRestart = false; }
      result = { session };
    } else result = { session };
    await route.fulfill({ json: result });
  });
  await page.routeWebSocket(/\/ws\?mode=browser/, ws => ws.send(JSON.stringify({ type: "browserState", session })));
  const login = await signIn(environment, node);
  await page.context().addCookies(login.cookie.split("; ").map(cookie => ({ name: cookie.slice(0, cookie.indexOf("=")), value: cookie.slice(cookie.indexOf("=") + 1), url: node.url })));
  await page.goto(`${node.url}/browser.html?${new URLSearchParams(identity)}`);
  await page.getByTestId("browser-profile-select").locator(`option[value="${profiles[1].id}"]`).waitFor({ state: "attached" });
  const library = page.getByTestId("browser-profile-library");
  assert.equal(await library.count(), 1, "saved profile library must be distinct from the running browser picker");
  assert.equal(await library.evaluate(el => (el as HTMLDetailsElement).open), true, "empty viewer starts with profile choices open");
  assert.match(await library.innerText(), /separate from your personal Chrome/i);
  assert.match(await library.innerText(), /name.*does not.*sign you in/i);
  const selector = page.getByTestId("browser-profile-select");
  await selector.selectOption(profiles[0].id);
  const detail = page.getByTestId("browser-profile-description");
  assert.match(await detail.innerText(), /11111111/);
  await selector.selectOption(profiles[1].id);
  assert.match(await detail.innerText(), /22222222/);
  assert.match(await detail.innerText(), /Homeserver/);
  assert.match(await detail.innerText(), /not verified/i, "saved data must never masquerade as verified login");
  assert.equal(starts.length, 0, "choosing a profile is not opening it");
  assert.equal(await page.getByTestId("browser-start").innerText(), "Open saved profile");
  await page.getByTestId("browser-start").click();
  await page.getByTestId("browser-connection-status").filter({ hasText: "Live" }).waitFor();
  assert.equal(starts[0].profileId, profiles[1].id);
  assert.equal(starts[0].nodeId, node.nodeId);
  assert.equal(await library.evaluate(el => (el as HTMLDetailsElement).open), false, "opening a browser gives space back to its page");
  assert.match(await page.getByTestId("browser-current-profile").innerText(), /22222222/);
  assert.equal(await page.getByTestId("browser-blank-help").isVisible(), true, "blank page explains the next step instead of suggesting the saved login was lost");
  assert.match(await page.getByTestId("browser-blank-help").innerText(), /website address/);
  assert.equal(await page.locator('.browser-control-actions [data-testid="browser-take-control"]').count(), 1);
  assert.equal(await page.locator('.browser-session-tools [data-testid="browser-end"]').count(), 1);
  await page.getByTestId("browser-take-control").click();
  await page.getByTestId("browser-control-status").filter({ hasText: "Human control" }).waitFor();
  await page.getByTestId("browser-resume-agent").click();
  await page.getByTestId("browser-control-status").filter({ hasText: "Agent control" }).waitFor();

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const stage = (await page.locator(".browser-stage").boundingBox())!;
    assert.ok(stage.y < 500, `live page should not be buried below setup at ${width}px: ${stage.y}`);
    assert.ok(await page.locator(".browser-body").evaluate(el => el.scrollWidth <= el.clientWidth), "viewer must not overflow horizontally");
    await page.getByTestId("browser-profile-library-toggle").click();
    await selector.selectOption("new");
    assert.equal(await page.getByTestId("browser-profile-name").isVisible(), true);
    assert.match(await detail.innerText(), /no saved logins/i);
    assert.equal(await page.getByTestId("browser-start").innerText(), "Create profile");
    assert.ok(await page.locator(".browser-body").evaluate(el => el.scrollWidth <= el.clientWidth), "expanded profile form must fit narrow viewers");
    await page.screenshot({ path: `tmp/browser-profiles-${width}.png` });
    await page.getByTestId("browser-profile-library-toggle").click();
  }
  await page.getByTestId("browser-end").click();
  await page.getByTestId("browser-confirm-accept").click();
  await page.getByTestId("browser-session-status").filter({ hasText: "No browser selected" }).waitFor();
  await page.getByTestId("browser-show-archived").check();
  await page.getByTestId("browser-session-select").selectOption("session");
  await page.getByTestId("browser-session-status").filter({ hasText: "closed" }).waitFor();
  assert.equal(await page.getByTestId("browser-reopen").isVisible(), true);
  assert.deepEqual(errors, []);
});
