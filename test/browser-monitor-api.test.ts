import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { BrowserChecker } from "../src/browser-monitor-checkers.js";
import { resolveDataDirectory } from "../src/data-directory.js";

function checker(): BrowserChecker {
  const field = (selector: string, attribute: BrowserChecker["account"]["attribute"] = null) => ({ selector, attribute, format: "text" as const });
  return {
    id: "fixture", version: 1, name: "Fixture", origins: ["https://fixture.example.test"], kind: "messages",
    readySelector: "#ready", loginSelector: null, loadingSelector: null, emptySelector: null,
    account: field("#account", "data-account-id"), target: field("#target", "data-target-id"), targetLabel: field("#target"),
    itemsSelector: ".message", itemId: field(":scope", "data-message-id"), sender: field(":scope", "data-sender-id"),
    text: field(".body"), incomingSelector: ".incoming", outgoingSelector: ".outgoing",
  };
}

function sessionCookie(response: Response): string {
  const value = response.headers.get("set-cookie");
  if (!value) throw new Error("Expected session cookie");
  return value.split(";", 1)[0];
}

test("browser monitor API enforces authentication, scope, and validation", async () => {
  const { createApp } = await import(`../src/app.js?monitor-api=${Date.now()}-${Math.random()}`);
  const { addProject } = await import("../src/store.js");
  const { getClusterMachineToken, getClusterNode } = await import("../src/cluster.js");
  const { browserMonitorStore } = await import("../src/browser-monitors.js");
  const server = createServer(createApp());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    const base = `http://127.0.0.1:${address.port}`;
    const project = await addProject("Monitor fixture", path.join(resolveDataDirectory(), "project"));
    const other = await addProject("Other fixture", path.join(resolveDataDirectory(), "other-project"));
    const node = await getClusterNode();
    const setup = await fetch(`${base}/api/auth/setup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "owner", password: "owner-selected-password" }) });
    assert.equal(setup.status, 201);
    const setupBody = await setup.json() as { csrfToken: string };
    const cookie = sessionCookie(setup);
    const request = async (method: string, route: string, body?: unknown, authenticated = true, csrf = true, bearer?: string) => {
      const headers: Record<string, string> = {};
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (authenticated) headers.Cookie = cookie;
      if (csrf) headers["x-csrf-token"] = setupBody.csrfToken;
      if (bearer) headers.Authorization = `Bearer ${bearer}`;
      return fetch(`${base}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    };
    const command = (nodeId: string, value: unknown) => ({ nodeId, command: value });
    const binding = { nodeId: node.id, sessionId: randomUUID(), profileId: randomUUID(), pageId: randomUUID(), engine: "pi" as const, conversationId: "conversation" };
    const input = { projectId: project.id, name: "Inbox", checkerId: "fixture", checkerVersion: 1, origin: "https://fixture.example.test", accountId: "account", targetIds: ["target"], intervalSeconds: 10, binding, readAcknowledged: false };

    let response = await request("GET", `/api/projects/${project.id}/browser-monitors`, undefined, false);
    assert.equal(response.status, 401);
    response = await request("GET", `/api/projects/${project.id}/browser-monitors`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { monitors: [], nodes: [{ nodeId: node.id, runtime: { started: false, activeCount: 0, error: null } }], unavailableNodes: [] });
    response = await request("POST", "/api/browser/monitors", command(node.id, { action: "checkers", projectId: project.id }), true, false);
    assert.equal(response.status, 403);
    response = await request("POST", "/api/browser/monitors", { nodeId: node.id });
    assert.equal(response.status, 400);
    response = await request("POST", "/api/browser/monitors", command(node.id, { action: "history", projectId: project.id, id: randomUUID() }));
    assert.equal(response.status, 404);

    response = await request("POST", "/api/browser/monitors", command(node.id, { action: "installChecker", projectId: project.id, definition: checker() }));
    assert.equal(response.status, 200);
    response = await request("POST", "/api/browser/monitors", command(node.id, { action: "installChecker", projectId: project.id, definition: checker() }));
    assert.equal(response.status, 409);
    response = await request("POST", "/api/browser/monitors", command(node.id, { action: "checkers", projectId: other.id }));
    assert.equal(response.status, 200); assert.deepEqual((await response.json() as { checkers: unknown[] }).checkers, []);
    response = await request("POST", "/api/browser/monitors", command(node.id, { action: "checkers", projectId: project.id }));
    assert.equal(response.status, 200); assert.equal((await response.json() as { checkers: unknown[] }).checkers.length, 1);

    for (const bad of [
      { action: "create", input: { ...input, checkerId: "unknown" } },
      { action: "create", input: { ...input, intervalSeconds: 9 } },
      { action: "create", input: { ...input, extra: true } },
    ]) {
      response = await request("POST", "/api/browser/monitors", command(node.id, bad));
      assert.equal(response.status, bad.action === "create" && "input" in bad && bad.input.checkerId === "unknown" ? 404 : 400);
    }
    response = await request("POST", "/api/browser/monitors", command(node.id, { action: "create", input }));
    assert.equal(response.status, 200);
    const created = (await response.json() as { monitor: { id: string; generation: number; enabled: boolean; health: string } }).monitor;
    assert.equal(created.enabled, false); assert.equal(created.health, "paused");

    const corruptionDb = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
    const checkpoint = corruptionDb.prepare("SELECT checkpoint FROM browser_monitor_monitors WHERE id = ?").get(created.id) as { checkpoint: string };
    try {
      corruptionDb.prepare("UPDATE browser_monitor_monitors SET checkpoint = 'invalid json' WHERE id = ?").run(created.id);
      response = await request("POST", "/api/browser/monitors", command(node.id, { action: "history", projectId: project.id, id: created.id }));
      assert.equal(response.status, 409);
      response = await request("POST", "/api/browser/monitors", command(node.id, { action: "history", projectId: other.id, id: created.id }));
      assert.equal(response.status, 404);
    } finally {
      corruptionDb.prepare("UPDATE browser_monitor_monitors SET checkpoint = ? WHERE id = ?").run(checkpoint.checkpoint, created.id);
    }
    const checkerRow = corruptionDb.prepare("SELECT digest FROM browser_monitor_checkers WHERE project_id = ? AND id = 'fixture' AND version = 1").get(project.id) as { digest: string };
    try {
      corruptionDb.prepare("UPDATE browser_monitor_checkers SET digest = ? WHERE project_id = ? AND id = 'fixture' AND version = 1").run("0".repeat(64), project.id);
      response = await request("POST", "/api/browser/monitors", command(node.id, { action: "create", input: { ...input, name: "Corrupt checker" } }));
      assert.equal(response.status, 409);
      assert.equal((await response.json() as { error: string }).error, "Browser checker integrity check failed");
    } finally {
      corruptionDb.prepare("UPDATE browser_monitor_checkers SET digest = ? WHERE project_id = ? AND id = 'fixture' AND version = 1").run(checkerRow.digest, project.id);
      corruptionDb.close();
    }

    response = await request("POST", "/api/browser/monitors", command(node.id, { action: "preview", projectId: project.id, id: created.id, generation: created.generation }));
    assert.equal(response.status, 409);
    response = await request("POST", "/api/browser/monitors", command(node.id, { action: "history", projectId: project.id, id: created.id }));
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { runs: [], events: [] });
    response = await request("POST", "/api/browser/monitors", command(node.id, { action: "history", projectId: other.id, id: created.id }));
    assert.equal(response.status, 404);

    response = await request("POST", "/api/browser/monitors", command(node.id, { action: "update", projectId: project.id, id: created.id, generation: created.generation + 1, patch: { intervalSeconds: 20 } }));
    assert.equal(response.status, 409);
    response = await request("POST", "/api/browser/monitors", command(node.id, { action: "update", projectId: project.id, id: created.id, generation: created.generation, patch: { intervalSeconds: 20, readAcknowledged: true } }));
    assert.equal(response.status, 200);
    const updated = (await response.json() as { monitor: { generation: number } }).monitor;
    response = await request("POST", "/api/browser/monitors", command(node.id, { action: "enable", projectId: project.id, id: created.id, generation: created.generation, enabled: false }));
    assert.equal(response.status, 409);

    let enabled = browserMonitorStore().setEnabled(created.id, updated.generation, true);

    const store = browserMonitorStore();
    const now = Date.now() + 10;
    const baseline = store.claim(enabled.id, node.id, now);
    assert.ok(baseline);
    store.complete(baseline.id, { accountId: "account", items: [], checkpoint: {}, complete: true, detail: "" }, now + 1);
    store.requestCheck(enabled.id, enabled.generation, now + 2);
    const triggerRun = store.claim(enabled.id, node.id, now + 2);
    assert.ok(triggerRun);
    const [event] = store.complete(triggerRun.id, { accountId: "account", items: [{
      externalId: "approval-source", targetId: "target", targetLabel: "Synthetic thread", senderId: "sender@fixture.example.test",
      direction: "incoming", kind: "message.received", text: "Exact original trigger", occurredAt: now + 2, identity: "stable",
    }], checkpoint: {}, complete: true, detail: "" }, now + 3);
    assert.ok(event);
    store.requestCheck(enabled.id, enabled.generation, now + 4);
    const laterRun = store.claim(enabled.id, node.id, now + 4);
    assert.ok(laterRun);
    store.complete(laterRun.id, { accountId: "account", items: Array.from({ length: 101 }, (_, index) => ({
      externalId: `later-${index}`, targetId: "target", targetLabel: "Synthetic thread", senderId: `later-${index}@fixture.example.test`,
      direction: "incoming" as const, kind: "message.received" as const, text: `Later message ${index}`, occurredAt: now + 4 + index, identity: "stable" as const,
    })), checkpoint: {}, complete: true, detail: "" }, now + 105);
    const recent = store.events(enabled.id);
    assert.equal(recent.length, 100);
    assert.equal(recent.some(item => item.id === event.id), false);
    const historyCommand = command(node.id, { action: "history", projectId: project.id, id: created.id });
    response = await request("POST", "/api/browser/monitors", historyCommand, false);
    assert.equal(response.status, 401);
    response = await request("POST", "/api/browser/monitors", historyCommand, true, false);
    assert.equal(response.status, 403);
    const token = await getClusterMachineToken();
    response = await request("POST", "/api/browser/monitors", historyCommand, false, false, token);
    assert.equal(response.status, 401);
    for (const bad of [
      { action: "history", projectId: project.id, id: "not-a-uuid" },
      { action: "history", projectId: project.id, id: created.id, unknown: true },
      { action: "update", projectId: project.id, id: created.id, generation: created.generation, patch: {} },
    ]) {
      response = await request("POST", "/api/browser/monitors", command(node.id, bad));
      assert.equal(response.status, 400);
    }


    const foreignMonitor = store.create({ ...input, projectId: other.id, name: "Foreign monitor", readAcknowledged: true }, node.id, now + 2000);
    let foreignEnabled = store.setEnabled(foreignMonitor.id, foreignMonitor.generation, true, now + 2001);
    const foreignBaseline = store.claim(foreignEnabled.id, node.id, now + 2001); assert.ok(foreignBaseline);
    store.complete(foreignBaseline.id, { accountId: "account", items: [], checkpoint: {}, complete: true, detail: "" }, now + 2002);
    store.requestCheck(foreignEnabled.id, foreignEnabled.generation, now + 2003);
    const foreignRun = store.claim(foreignEnabled.id, node.id, now + 2003); assert.ok(foreignRun);
    const [foreignEvent] = store.complete(foreignRun.id, { accountId: "account", items: [{
      externalId: "foreign-source", targetId: "target", targetLabel: "Foreign thread", senderId: "foreign@fixture.example.test",
      direction: "incoming", kind: "message.received", text: "Foreign event", occurredAt: now + 2003, identity: "stable",
    }], checkpoint: {}, complete: true, detail: "" }, now + 2004);
    assert.ok(foreignEvent);
    assert.deepEqual(store.eventsByIds(enabled.id, []), []);
    assert.throws(() => store.eventsByIds(enabled.id, [event.id, event.id]), /Event IDs must be unique/);
    assert.throws(() => store.eventsByIds(enabled.id, [randomUUID()]), /event not found/i);
    const eventDb = new DatabaseSync(path.join(resolveDataDirectory(), "node.db"));
    const foreignItem = eventDb.prepare("SELECT item FROM browser_monitor_events WHERE id = ?").get(foreignEvent.id) as { item: string };
    try {
      eventDb.prepare("UPDATE browser_monitor_events SET item = 'invalid json' WHERE id = ?").run(foreignEvent.id);
      assert.throws(() => store.eventsByIds(enabled.id, [foreignEvent.id]), /event not found/i);
    } finally {
      eventDb.prepare("UPDATE browser_monitor_events SET item = ? WHERE id = ?").run(foreignItem.item, foreignEvent.id);
      eventDb.close();
    }
    foreignEnabled = store.setEnabled(foreignEnabled.id, foreignEnabled.generation, false, now + 2005);
    store.delete(foreignEnabled.id, foreignEnabled.generation);

    response = await request("POST", "/api/cluster/browser/monitor-authorize", { reference: { kind: "run", projectId: project.id, monitorId: created.id, generation: enabled.generation, runId: randomUUID() } }, false, false, token);
    assert.equal(response.status, 409);
    response = await request("POST", "/api/browser/monitors", command(node.id, { action: "delete", projectId: project.id, id: created.id, generation: enabled.generation }));
    assert.equal(response.status, 409);
    response = await request("POST", "/api/browser/monitors", command(node.id, { action: "enable", projectId: project.id, id: created.id, generation: enabled.generation, enabled: false }));
    assert.equal(response.status, 200);
    const paused = (await response.json() as { monitor: { generation: number } }).monitor;

    response = await request("POST", "/api/cluster/browser/monitor-authorize", { reference: { kind: "run", projectId: project.id, monitorId: created.id, generation: paused.generation, runId: randomUUID() } });
    assert.equal(response.status, 403);
    response = await request("POST", "/api/browser/monitors", command(node.id, { action: "list", projectId: project.id }), false, false, token);
    assert.equal(response.status, 401);
    response = await request("POST", "/api/cluster/browser/monitor-authorize", { reference: { kind: "run", projectId: project.id, monitorId: created.id, generation: paused.generation, runId: randomUUID() } }, false, false, token);
    assert.equal(response.status, 409);
    response = await request("POST", "/api/cluster/browser/monitor-authorize", { reference: { kind: "run", projectId: project.id, monitorId: randomUUID(), generation: 1, runId: randomUUID() } }, false, false, token);
    assert.equal(response.status, 404);

    response = await request("POST", "/api/browser/monitors", command(node.id, { action: "delete", projectId: project.id, id: created.id, generation: paused.generation }));
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { deleted: true });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
