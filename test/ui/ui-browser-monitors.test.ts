import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { BrowserChecker } from "../../src/browser-monitor-checkers.js";
import type { MonitorEvent, MonitorRecord, MonitorRun } from "../../src/browser-monitor-types.js";
import type { BrowserProfile, BrowserSessionView } from "../../src/browser-types.js";
import { api, signIn } from "../dev-nodes.js";
import { nativeUiFixture } from "./native-ui-fixture.js";
import type { Page, Request, Response, Route } from "playwright-core";

type MonitorList = { monitors: MonitorRecord[] };
type History = { runs: MonitorRun[]; events: MonitorEvent[] };

async function waitFor<T>(label: string, read: () => Promise<T | undefined>, timeout = 20_000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result !== undefined) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`${label} timed out after ${timeout}ms`);
}

type HeldRequest = {
  request: Promise<Request>;
  release: () => void;
  finish: () => Promise<Response>;
  cleanup: () => Promise<void>;
};

async function holdMonitorCommand(page: Page, action: string): Promise<HeldRequest> {
  let release!: () => void;
  let capture!: (request: Request) => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const request = new Promise<Request>(resolve => { capture = resolve; });
  let matched = false;
  let captured: Request | undefined;
  let finished = false;
  const handler = async (route: Route) => {
    if (!matched && route.request().method() === "POST" && route.request().postDataJSON().command?.action === action) {
      matched = true; captured = route.request(); capture(captured); await gate;
    }
    await route.continue();
  };
  await page.route("**/api/browser/monitors", handler);
  return {
    request,
    release,
    finish: async () => {
      const held = await request;
      const response = await held.response();
      assert.ok(response); await response.finished();
      await page.unroute("**/api/browser/monitors", handler); finished = true;
      return response;
    },
    cleanup: async () => {
      release();
      if (captured && !finished) { const response = await captured.response(); await response?.finished(); }
      await page.unroute("**/api/browser/monitors", handler);
    },
  };
}

async function twoFrames(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

const fixtureHtml = `<!doctype html><html><body>
<div id="account" data-account-id="monitor@example.test">monitor@example.test</div>
<div id="target" data-target-id="chat-1">Fixture chat</div>
<div id="ready">Ready</div><div id="empty" hidden>Empty</div>
<div class="message incoming" data-message-id="m1" data-sender-id="sender"><span class="body">&lt;img src=x onerror=&quot;window.__monitorXss=true&quot;&gt;</span></div>
</body></html>`;

test("project browser monitor management journey", { timeout: 180_000 }, async (t) => {
  const { page, environment, node } = await nativeUiFixture(t);
  const fixture = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fixtureHtml);
  });
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  t.after(async () => {
    fixture.closeAllConnections();
    await new Promise<void>((resolve, reject) => fixture.close(error => error ? reject(error) : resolve()));
  });

  const origin = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;
  const pageErrors: Error[] = [];
  page.on("pageerror", error => pageErrors.push(error));
  const auth = await signIn(environment, node);
  const project = node.projects.find(candidate => candidate.name === "Internal Assistant");
  assert.ok(project, "Seeded Internal Assistant project missing");
  const conversationId = randomUUID();

  const startSession = async (profileName: string): Promise<BrowserSessionView> => {
    const response = await api<{ session: BrowserSessionView }>(node, auth, "POST", `/browser/sessions?nodeId=${node.nodeId}`, {
      projectId: project.id, engine: "pi", conversationId, appNodeId: node.nodeId, url: origin, profileName,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.ok(response.body.session.profileId, "Started browser must expose its profile ID");
    assert.ok(response.body.session.activePageId, "Started browser must expose its active page ID");
    return response.body.session;
  };
  const first = await startSession(`ui-monitor-source-${randomUUID()}`);
  const replacement = await startSession(`ui-monitor-replacement-${randomUUID()}`);
  assert.notEqual(first.id, replacement.id);
  assert.notEqual(first.profileId, replacement.profileId);

  const aggregate = () => api<MonitorList>(node, auth, "GET", `/projects/${project.id}/browser-monitors`);
  const current = async (): Promise<MonitorRecord | undefined> => {
    const response = await aggregate();
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return response.body.monitors.find(monitor => monitor.name.startsWith("UI monitor"));
  };

  await page.goto(node.url);
    await page.locator("#loginDialog[open]").waitFor();
    await page.locator("#loginUsernameInput").fill(environment.username);
    await page.locator("#loginPasswordInput").fill(environment.password);
    await page.locator("#loginSubmitButton").click();
    await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3);
    await page.locator('[aria-label="Actions for Internal Assistant"]').click();
    await page.getByTestId("project-automations-button").click();
    await page.locator("#automationsDialog[open]").waitFor();
    assert.equal(await page.locator('#automationError[role="alert"]').count(), 1);

    const checker: BrowserChecker = {
      id: "ui:fixture", version: 1, name: "UI fixture", origins: [origin], kind: "messages", readySelector: "#ready",
      loginSelector: null, loadingSelector: null, emptySelector: "#empty",
      account: { selector: "#account", attribute: "data-account-id", format: "text" },
      target: { selector: "#target", attribute: "data-target-id", format: "text" },
      targetLabel: { selector: "#target", attribute: null, format: "text" }, itemsSelector: ".message",
      itemId: { selector: ":scope", attribute: "data-message-id", format: "text" },
      sender: { selector: ":scope", attribute: "data-sender-id", format: "text" }, text: { selector: ".body", attribute: null, format: "text" },
      incomingSelector: ".incoming", outgoingSelector: ".outgoing",
    };
    await page.getByTestId("automation-install-checker").click();
    await page.locator("#automationCheckerForm").waitFor();
    await page.getByTestId("automation-checker-json").fill(JSON.stringify(checker));
    await page.getByTestId("automation-checker-save").click();
    await page.locator("#automationCheckerForm").waitFor({ state: "hidden" });
    assert.equal((await aggregate()).body.monitors.length, 0, "Installing a checker must not create a monitor");

    await page.getByTestId("automation-new").click();
    await page.locator("#automationMonitorForm").waitFor();
    await page.getByTestId("automation-name").fill("UI monitor");
    await page.getByTestId("automation-checker").selectOption("ui:fixture:1");
    await page.getByTestId("automation-session").selectOption(`${node.nodeId}:${first.id}`);
    await page.getByTestId("automation-origin").fill(origin);
    await page.getByTestId("automation-account").fill("monitor@example.test");
    await page.getByTestId("automation-targets").fill("chat-1");
    await page.getByTestId("automation-interval").fill("9");
    assert.deepEqual(await page.locator("#automationMonitorForm").evaluate((form: HTMLFormElement) => {
      const interval = form.querySelector('[data-testid="automation-interval"]') as HTMLInputElement;
      return { rangeUnderflow: interval.validity.rangeUnderflow, valid: form.checkValidity() };
    }), { rangeUnderflow: true, valid: false });
    await page.getByTestId("automation-interval").fill("10");
    assert.equal(await page.getByTestId("automation-read-ack").isChecked(), false);
    await page.getByTestId("automation-read-ack").check();
    const createResponse = page.waitForResponse(response => response.url().endsWith("/api/browser/monitors") && response.request().method() === "POST"
      && response.request().postDataJSON().command?.action === "create");
    await page.getByTestId("automation-save").click();
    assert.equal((await createResponse).status(), 200, "colon-containing checker ID must create successfully");
    const card = page.getByTestId("automation-monitor").filter({ hasText: "UI monitor" });
    await card.waitFor();
    await card.getByText("Paused", { exact: true }).waitFor();
    let monitor = await waitFor("paused monitor creation", async () => {
      const value = await current();
      return value && !value.enabled && !value.baseline ? value : undefined;
    });
    assert.equal(monitor.intervalSeconds, 10);

    await card.getByTestId("automation-preview").click();
    const details = page.locator("#automationDetails");
    await details.getByText("m1", { exact: false }).waitFor();
    assert.ok((await details.textContent())?.includes("<img"));
    assert.equal(await details.locator("img[onerror], script").count(), 0);
    assert.equal(await page.evaluate(() => "__monitorXss" in window), false);
    const beforeEnable = await api<History>(node, auth, "POST", "/browser/monitors", { nodeId: node.nodeId, command: { action: "history", projectId: project.id, id: monitor.id } });
    assert.deepEqual(beforeEnable.body, { runs: [], events: [] });
    assert.equal((await current())?.baseline, false);

    await card.getByRole("button", { name: "Enable monitoring" }).click();
    monitor = await waitFor("real scheduler baseline", async () => {
      const value = await current();
      return value?.enabled && value.baseline ? value : undefined;
    }, 20_000);
    await card.getByText("Paused", { exact: true }).waitFor({ state: "hidden" });
    const liveHref = await card.getByTestId("automation-live-view").getAttribute("href");
    assert.ok(liveHref?.includes(`browserSessionId=${first.id}`) && liveHref.includes(`nodeId=${node.nodeId}`), liveHref ?? "missing live-view URL");
    const popupPromise = page.waitForEvent("popup");
    await card.getByTestId("automation-live-view").click();
    const popup = await popupPromise;
    await popup.getByTestId("browser-screen").waitFor();
    await popup.getByTestId("browser-close-viewer").click();
    await popup.getByText("Viewer closed. Browser session is still running.", { exact: false }).waitFor();
    await popup.close();
    monitor = (await current())!;
    assert.equal(monitor.enabled, true);
    assert.equal(monitor.binding.sessionId, first.id);

    await card.getByRole("button", { name: "Pause monitoring" }).click();
    monitor = await waitFor("monitor pause", async () => {
      const value = await current(); return value && !value.enabled ? value : undefined;
    });
    await card.getByTestId("automation-edit").click();
    await page.getByTestId("automation-name").fill("UI monitor edited");
    await page.getByTestId("automation-interval").fill("30");
    await page.getByTestId("automation-save").click();
    await card.getByText("UI monitor edited", { exact: true }).waitFor();
    monitor = (await current())!;
    assert.equal(monitor.intervalSeconds, 30);
    assert.equal(monitor.enabled, false);
    await card.getByTestId("automation-history").click();
    await page.waitForFunction(() => {
      const text = document.querySelector("#automationDetails")?.textContent ?? "";
      return text.includes("succeeded") && text.includes("m1");
    });

    await card.getByTestId("automation-rebind").click();
    await page.locator("#automationBindingForm").waitFor();
    await page.getByTestId("automation-rebind-session").selectOption(`${node.nodeId}:${replacement.id}`);
    await page.getByTestId("automation-rebind-save").click();
    monitor = await waitFor("replacement binding", async () => {
      const value = await current(); return value?.binding.sessionId === replacement.id ? value : undefined;
    });
    assert.equal(monitor.baseline, true);
    assert.equal(monitor.enabled, false);
    await card.locator(`[data-testid="automation-live-view"][href*="browserSessionId=${replacement.id}"]`).waitFor();
    const replacementHref = await card.getByTestId("automation-live-view").getAttribute("href");
    assert.ok(replacementHref?.includes(`browserSessionId=${replacement.id}`), replacementHref ?? "missing replacement live-view URL");

    const reopenAutomations = async (projectName = "Internal Assistant") => {
      await page.locator(`[aria-label="Actions for ${projectName}"]`).click();
      await page.getByTestId("project-automations-button").click();
      await page.locator("#automationsDialog[open]").waitFor();
      if (projectName === "Internal Assistant") await card.waitFor();
    };
    const resetAutomations = async () => {
      await page.reload();
      await page.waitForFunction(() => document.querySelectorAll("#projectList .list-row").length === 3);
      await reopenAutomations(project.name);
      await page.locator("#automationList:not([hidden])").waitFor();
      await card.waitFor();
    };
    const assertOldSaveCannotDisableReopened = async (kind: "checker" | "edit" | "rebind") => {
      const action = kind === "checker" ? "installChecker" : kind === "edit" ? "update" : "rebind";
      const hold = await holdMonitorCommand(page, action);
      try {
        if (kind === "checker") {
          await page.getByTestId("automation-install-checker").click();
          await page.getByTestId("automation-checker-json").fill(JSON.stringify({ ...checker, version: 20 }));
          await page.getByTestId("automation-checker-save").click();
        } else if (kind === "edit") {
          await card.getByTestId("automation-edit").click(); await page.getByTestId("automation-save").click();
        } else {
          await card.getByTestId("automation-rebind").click();
          await page.getByTestId("automation-rebind-session").selectOption(`${node.nodeId}:${replacement.id}`);
          await page.getByTestId("automation-rebind-save").click();
        }
        await hold.request;
        await page.keyboard.press("Escape");
        await reopenAutomations();
        if (kind === "checker") await page.getByTestId("automation-install-checker").click();
        else if (kind === "edit") await card.getByTestId("automation-edit").click();
        else await card.getByTestId("automation-rebind").click();
        const save = page.getByTestId(kind === "checker" ? "automation-checker-save" : kind === "edit" ? "automation-save" : "automation-rebind-save");
        assert.equal(await save.isEnabled(), true, `${kind} submit must be enabled immediately after reopen`);
        hold.release(); assert.equal((await hold.finish()).status(), 200);
        assert.equal(await save.isVisible(), true, `${kind} editor must survive old response`);
        assert.equal(await save.isEnabled(), true, `${kind} submit must remain enabled after old response`);
        await page.getByTestId(kind === "checker" ? "automation-checker-cancel" : kind === "edit" ? "automation-cancel" : "automation-rebind-cancel").click();
        const refreshed = page.waitForResponse(response => response.url().includes(`/api/projects/${project.id}/browser-monitors`));
        await page.getByTestId("automation-refresh").click(); await (await refreshed).finished();
      } finally { await hold.cleanup(); }
    };

    for (const kind of ["checker", "edit", "rebind"] as const) {
      await t.test(`fresh ${kind} editor ignores a save from a closed dialog`, async () => {
        await resetAutomations();
        await assertOldSaveCannotDisableReopened(kind);
      });
    }

    await t.test("same-dialog checker editor identity fences two pending installs", async () => {
      await resetAutomations();
      const firstHold = await holdMonitorCommand(page, "installChecker");
      let secondHold: HeldRequest | undefined;
      try {
        await page.getByTestId("automation-install-checker").click();
        await page.getByTestId("automation-checker-json").fill(JSON.stringify({ ...checker, version: 21 }));
        await page.getByTestId("automation-checker-save").click(); await firstHold.request;
        await page.getByTestId("automation-checker-cancel").click();
        await page.getByTestId("automation-install-checker").click();
        const secondJson = JSON.stringify({ ...checker, version: 22 });
        await page.getByTestId("automation-checker-json").fill(secondJson);
        assert.equal(await page.getByTestId("automation-checker-save").isEnabled(), true);
        secondHold = await holdMonitorCommand(page, "installChecker");
        await page.getByTestId("automation-checker-save").click(); await secondHold.request;
        assert.equal(await page.getByTestId("automation-checker-save").isDisabled(), true);
        firstHold.release(); assert.equal((await firstHold.finish()).status(), 200);
        assert.equal(await page.getByTestId("automation-checker-json").inputValue(), secondJson);
        assert.equal(await page.getByTestId("automation-checker-save").isDisabled(), true);
        secondHold.release(); assert.equal((await secondHold.finish()).status(), 200);
        await page.locator("#automationCheckerForm").waitFor({ state: "hidden" });
      } finally { await firstHold.cleanup(); if (secondHold) await secondHold.cleanup(); }
    });

    for (const kind of ["edit", "rebind"] as const) {
      await t.test(`same-dialog ${kind} editor ignores an old completed save`, async () => {
        await resetAutomations();
        const hold = await holdMonitorCommand(page, kind === "edit" ? "update" : "rebind");
        try {
          await card.getByTestId(kind === "edit" ? "automation-edit" : "automation-rebind").click();
          if (kind === "rebind") await page.getByTestId("automation-rebind-session").selectOption(`${node.nodeId}:${replacement.id}`);
          await page.getByTestId(kind === "edit" ? "automation-save" : "automation-rebind-save").click(); await hold.request;
          await page.getByTestId(kind === "edit" ? "automation-cancel" : "automation-rebind-cancel").click();
          await card.getByTestId(kind === "edit" ? "automation-edit" : "automation-rebind").click();
          const save = page.getByTestId(kind === "edit" ? "automation-save" : "automation-rebind-save");
          assert.equal(await save.isEnabled(), true);
          hold.release(); assert.equal((await hold.finish()).status(), 200);
          assert.equal(await save.isVisible(), true); assert.equal(await save.isEnabled(), true);
          await page.getByTestId(kind === "edit" ? "automation-cancel" : "automation-rebind-cancel").click();
          const refreshed = page.waitForResponse(response => response.url().includes(`/api/projects/${project.id}/browser-monitors`));
          await page.getByTestId("automation-refresh").click(); await (await refreshed).finished();
        } finally { await hold.cleanup(); }
      });
    }

    await t.test("refresh preserves focused monitor action", async () => {
      await resetAutomations();
      const refresh = page.getByTestId("automation-refresh");
      const preview = card.getByTestId("automation-preview");
      await preview.focus();
      const originalPreview = await preview.elementHandle();
      assert.ok(originalPreview);
      try {
        const sessionsResponse = page.waitForResponse(response => response.url().includes("/api/browser/sessions?"));
        const monitorsResponse = page.waitForResponse(response => response.url().includes(`/api/projects/${project.id}/browser-monitors`));
        await refresh.evaluate((button: HTMLButtonElement) => button.click());
        await Promise.all([(await sessionsResponse).finished(), (await monitorsResponse).finished()]);
        await twoFrames(page);
        assert.equal(await originalPreview.evaluate(element => element.isConnected && document.activeElement === element), true,
          "Polling must preserve the focused monitor action");
      } finally { await originalPreview.dispose(); }
    });

    await t.test("refresh preserves action-local busy state", async () => {
      await resetAutomations();
      const hold = await holdMonitorCommand(page, "preview");
      try {
        await card.getByTestId("automation-preview").click(); await hold.request;
        const sessionsResponse = page.waitForResponse(response => response.url().includes("/api/browser/sessions?"));
        const monitorsResponse = page.waitForResponse(response => response.url().includes(`/api/projects/${project.id}/browser-monitors`));
        await page.getByTestId("automation-refresh").evaluate((button: HTMLButtonElement) => button.click());
        await Promise.all([(await sessionsResponse).finished(), (await monitorsResponse).finished()]);
        await twoFrames(page);
        assert.equal(await card.getByTestId("automation-preview").isDisabled(), true,
          "Polling must keep the in-flight preview disabled");
        assert.equal(await card.getByTestId("automation-edit").isEnabled(), true);
        hold.release(); assert.equal((await hold.finish()).status(), 200);
      } finally { await hold.cleanup(); }
    });

    await t.test("old-project preview cannot write into a reopened dialog", async () => {
      await resetAutomations();
      const hold = await holdMonitorCommand(page, "preview");
      try {
        await card.getByTestId("automation-preview").click(); await hold.request;
        await page.keyboard.press("Escape"); await reopenAutomations("Joint Bob");
        await page.getByText("No browser monitors", { exact: false }).waitFor();
        hold.release(); assert.equal((await hold.finish()).status(), 200); await twoFrames(page);
        assert.equal(await page.locator("#automationDetails").isHidden(), true);
        assert.equal((await page.locator("#automationsDialog").textContent())?.includes("m1"), false);
        assert.equal(await page.locator('#automationError[role="alert"]').textContent(), "");
        await page.keyboard.press("Escape"); await reopenAutomations();
      } finally { await hold.cleanup(); }
    });

    await page.setViewportSize({ width: 390, height: 600 });
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const mobile = await page.evaluate(() => {
      const dialog = document.querySelector("#automationsDialog > .dialog-card") as HTMLElement;
      const monitorCard = document.querySelector('[data-testid="automation-monitor"]') as HTMLElement;
      const buttons = [...dialog.querySelectorAll("button")].filter(button => (button as HTMLElement).offsetParent !== null);
      const rect = dialog.getBoundingClientRect(), cardRect = monitorCard.getBoundingClientRect();
      return { rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, cardWithin: cardRect.left >= rect.left && cardRect.right <= rect.right,
        scrollCapacity: dialog.scrollHeight >= dialog.clientHeight, horizontalOverflow: dialog.scrollWidth > dialog.clientWidth,
        buttonHeights: buttons.map(button => button.getBoundingClientRect().height) };
    });
    assert.ok(mobile.rect.left >= 8 && mobile.rect.right <= 382 && mobile.rect.top >= 8 && mobile.rect.bottom <= 592, JSON.stringify(mobile));
    assert.equal(mobile.cardWithin, true);
    assert.equal(mobile.scrollCapacity, true);
    assert.equal(mobile.horizontalOverflow, false);
    assert.ok(mobile.buttonHeights.every(height => height >= 40), JSON.stringify(mobile.buttonHeights));
    await card.getByTestId("automation-edit").scrollIntoViewIfNeeded();
    await card.getByTestId("automation-edit").focus();
    await page.keyboard.press("Enter");
    await page.getByTestId("automation-save").scrollIntoViewIfNeeded();
    assert.equal(await page.getByTestId("automation-name").isEditable(), true);
    assert.equal(await page.getByTestId("automation-save").isVisible(), true);
    await page.keyboard.press("Escape");
    await page.locator("#automationsDialog").waitFor({ state: "hidden" });

    await page.locator('[aria-label="Actions for Internal Assistant"]').click();
    await page.getByTestId("project-automations-button").click();
    await card.waitFor();

    await t.test("human takeover renders the specific paused health", async () => {
      await resetAutomations();
      let value = (await current())!;
      let response = await api<{ monitor: MonitorRecord }>(node, auth, "POST", "/browser/monitors", { nodeId: node.nodeId,
        command: { action: "enable", projectId: project.id, id: value.id, generation: value.generation, enabled: true } });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      value = await waitFor("enabled monitor baseline", async () => {
        const candidate = await current(); return candidate?.enabled && candidate.baseline ? candidate : undefined;
      });
      const takeover = await api(node, auth, "POST", `/browser/sessions/${replacement.id}/command?nodeId=${node.nodeId}`, { action: "takeControl" });
      assert.equal(takeover.status, 200, JSON.stringify(takeover.body));
      response = await api<{ monitor: MonitorRecord }>(node, auth, "POST", "/browser/monitors", { nodeId: node.nodeId,
        command: { action: "check", projectId: project.id, id: value.id, generation: value.generation } });
      assert.equal(response.status, 200, JSON.stringify(response.body));
      await waitFor("paused-by-human health", async () => {
        const candidate = await current(); return candidate?.health === "paused-by-human" && !candidate.enabled ? candidate : undefined;
      });
      await page.getByTestId("automation-refresh").click();
      await card.getByText("Paused by human", { exact: true }).waitFor();
      assert.equal(await card.getByText("Paused", { exact: true }).count(), 0);
    });

    await card.getByTestId("automation-delete").click();
    await page.locator("#confirmDialog[open]").waitFor();
    await page.locator("#confirmAcceptButton").click();
    await card.waitFor({ state: "detached" });
    await page.getByText("No browser monitors", { exact: false }).waitFor();
    assert.equal((await aggregate()).body.monitors.length, 0);

    const sessions = await api<{ sessions: BrowserSessionView[] }>(node, auth, "GET", `/browser/sessions?nodeId=${node.nodeId}`);
    assert.ok(sessions.body.sessions.some(session => session.id === first.id));
    assert.ok(sessions.body.sessions.some(session => session.id === replacement.id));
    const profiles = await api<{ profiles: BrowserProfile[] }>(node, auth, "GET", `/browser/profiles?nodeId=${node.nodeId}&projectId=${project.id}`);
    assert.ok(profiles.body.profiles.some(profile => profile.id === first.profileId));
    assert.ok(profiles.body.profiles.some(profile => profile.id === replacement.profileId));
    assert.deepEqual(pageErrors, []);
});
