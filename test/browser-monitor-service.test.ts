import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setImmediate as waitImmediate } from "node:timers/promises";
import test from "node:test";
import type { BrowserChecker } from "../src/browser-monitor-checkers.js";
import { browserCheckerStore } from "../src/browser-checker-store.js";
import { BrowserRuntime } from "../src/browser-runtime.js";
import { browserMonitorStore } from "../src/browser-monitors.js";
import { getClusterNode } from "../src/cluster.js";
import { resolveDataDirectory } from "../src/data-directory.js";
import { manageBrowserMonitor, browserMonitorRuntimeStatus, startBrowserMonitors, stopBrowserMonitors } from "../src/server/browser-monitors.js";
import { closeBrowserRuntime } from "../src/server/browser.js";
import { addProject } from "../src/store.js";

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
function checker(): BrowserChecker {
  const field = (selector: string, attribute: BrowserChecker["account"]["attribute"] = null) => ({ selector, attribute, format: "text" as const });
  return {
    id: "service-fixture", version: 1, name: "Fixture", origins: ["https://fixture.example.test"], kind: "messages",
    readySelector: "#ready", loginSelector: null, loadingSelector: null, emptySelector: null,
    account: field("#account", "data-account-id"), target: field("#target", "data-target-id"), targetLabel: field("#target"),
    itemsSelector: ".message", itemId: field(":scope", "data-message-id"), sender: field(":scope", "data-sender-id"),
    text: field(".body"), incomingSelector: ".incoming", outgoingSelector: ".outgoing",
  };
}

await test("preview times out and expires authorization while browser work remains queued", async t => {
  const project = await addProject("Monitor service fixture", path.join(resolveDataDirectory(), "service-project"));
  const node = await getClusterNode();
  browserCheckerStore().install(project.id, checker(), "fixture-user");
  const binding = { nodeId: node.id, sessionId: randomUUID(), profileId: randomUUID(), pageId: randomUUID(), engine: "pi" as const, conversationId: "conversation" };
  const created = await manageBrowserMonitor({ action: "create", input: { projectId: project.id, name: "Inbox", checkerId: "service-fixture", checkerVersion: 1, origin: "https://fixture.example.test", accountId: "account", targetIds: ["target"], intervalSeconds: 10, binding, readAcknowledged: true } }, "fixture-user") as { monitor: { id: string; generation: number } };
  const entered = deferred<void>(); const held = deferred<{ accountId: string; checkpoint: {}; complete: boolean; detail: string; items: [] }>();
  let grant!: { assertValid: () => Promise<void> };
  t.mock.method(BrowserRuntime.prototype, "inspectMonitor", ((supplied: typeof grant) => { grant = supplied; entered.resolve(); return held.promise; }) as BrowserRuntime["inspectMonitor"]);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const preview = manageBrowserMonitor({ action: "preview", projectId: project.id, id: created.monitor.id, generation: created.monitor.generation }, "fixture-user");
  let settled = false; preview.then(() => { settled = true; }, () => { settled = true; });
  try {
    await entered.promise; t.mock.timers.tick(15_001); await waitImmediate();
    assert.equal(settled, true, "preview must settle after its service deadline");
    await assert.rejects(preview, /Browser monitor preview timed out/);
    await assert.rejects(grant.assertValid(), /preview is not authorized/);
  } finally {
    held.resolve({ accountId: "account", checkpoint: {}, complete: true, detail: "", items: [] });
    t.mock.timers.reset(); t.mock.restoreAll(); await closeBrowserRuntime();
  }
});

await test("shutdown during startup cannot create a scheduler", async () => {
  const starting = startBrowserMonitors();
  stopBrowserMonitors();
  try {
    await assert.rejects(starting, /stopped/);
    assert.equal(browserMonitorRuntimeStatus().started, false);
  } finally { stopBrowserMonitors(); }
});
