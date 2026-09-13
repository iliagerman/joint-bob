import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { BrowserChecker } from "../src/browser-monitor-checkers.js";
import { BrowserCheckerStore } from "../src/browser-checker-store.js";
import { resolveDataDirectory } from "../src/data-directory.js";

function checker(version = 1, overrides: Partial<BrowserChecker> = {}): BrowserChecker {
  const field = (selector: string, attribute: BrowserChecker["account"]["attribute"] = null) => ({ selector, attribute, format: "text" as const });
  return {
    id: "fixture", version, name: "Fixture", origins: ["https://fixture.example.test"], kind: "messages",
    readySelector: "#ready", loginSelector: null, loadingSelector: null, emptySelector: null,
    account: field("#account", "data-account-id"), target: field("#target", "data-target-id"), targetLabel: field("#target"),
    itemsSelector: ".message", itemId: field(":scope", "data-message-id"), sender: field(":scope", "data-sender-id"),
    text: field(".body"), incomingSelector: ".incoming", outgoingSelector: ".outgoing", ...overrides,
  };
}
function memoryStore() { const db = new DatabaseSync(":memory:"); return { db, store: new BrowserCheckerStore(db) }; }

test("installs a validated checker with immutable metadata", () => {
  const x = memoryStore(); try {
    const definition = checker(); const serialized = JSON.stringify(definition);
    const expected = { projectId: "project", definition, digest: createHash("sha256").update(serialized).digest("hex"), createdBy: "user", createdAt: 123 };
    assert.deepEqual(x.store.install("project", definition, "user", 123), expected);
    assert.deepEqual(x.store.get("project", "fixture", 1), expected);
  } finally { x.store.close(); }
});

test("rejects invalid boundaries without inserting records", () => {
  const x = memoryStore(); try {
    for (const [projectId, definition, createdBy] of [["", checker(), "user"], ["project", checker(), ""], ["project", { ...checker(), extra: true }, "user"]] as const)
      assert.throws(() => x.store.install(projectId, definition, createdBy));
    assert.throws(() => x.store.install("project", checker(), "user", -1));
    assert.deepEqual(x.store.list("project"), []);
    for (const operation of [() => x.store.get("", "fixture", 1), () => x.store.get("project", "", 1), () => x.store.get("project", "fixture", 0), () => x.store.list("")]) assert.throws(operation);
  } finally { x.store.close(); }
});

test("duplicate versions fail and later versions do not mutate earlier ones", () => {
  const x = memoryStore(); try {
    const original = x.store.install("project", checker(), "user", 1);
    assert.throws(() => x.store.install("project", checker(), "user", 2), /Checker version already exists/);
    assert.throws(() => x.store.install("project", checker(1, { name: "Changed" }), "other", 3), /Checker version already exists/);
    assert.deepEqual(x.store.get("project", "fixture", 1), original);
    const second = x.store.install("project", checker(2), "user", 4);
    assert.equal(second.definition.version, 2); assert.deepEqual(x.store.get("project", "fixture", 1), original);
  } finally { x.store.close(); }
});

test("project scope isolates identical keys and missing versions", () => {
  const x = memoryStore(); try {
    const first = x.store.install("one", checker(), "user-one", 1);
    const second = x.store.install("two", checker(), "user-two", 2);
    assert.deepEqual(x.store.get("one", "fixture", 1), first); assert.deepEqual(x.store.get("two", "fixture", 1), second);
    assert.throws(() => x.store.get("three", "fixture", 1), /Browser checker version not found/);
    assert.throws(() => x.store.get("one", "fixture", 2), /Browser checker version not found/);
  } finally { x.store.close(); }
});

test("list is project-scoped, ordered, and limited to latest 200", () => {
  const x = memoryStore(); try {
    for (let version = 1; version <= 202; version++) x.store.install("project", checker(version, { id: version % 2 ? "z" : "a" }), "user", version <= 4 ? 1000 : version);
    x.store.install("other", checker(), "user", 1000);
    const rows = x.store.list("project");
    assert.equal(rows.length, 200); assert.equal(rows.some(row => row.projectId === "other"), false);
    assert.deepEqual(rows.slice(0, 4).map(row => [row.createdAt, row.definition.id, row.definition.version]), [[1000, "a", 4], [1000, "a", 2], [1000, "z", 3], [1000, "z", 1]]);
    assert.deepEqual(rows.slice(-2).map(row => row.definition.version), [8, 7]);
    assert.equal(rows.some(row => [5, 6].includes(row.definition.version)), false);
  } finally { x.store.close(); }
});

test("rejects persisted definition and digest tampering", () => {
  const x = memoryStore(); try {
    x.store.install("project", checker(), "user", 1);
    const changed = JSON.stringify(checker(1, { name: "Tampered" }));
    x.db.prepare("UPDATE browser_monitor_checkers SET definition = ? WHERE project_id = 'project'").run(changed);
    assert.throws(() => x.store.get("project", "fixture", 1), /Browser checker integrity check failed/);
    assert.throws(() => x.store.list("project"), /Browser checker integrity check failed/);
    x.db.prepare("UPDATE browser_monitor_checkers SET definition = ?, digest = ? WHERE project_id = 'project'").run(JSON.stringify(checker()), "0".repeat(64));
    assert.throws(() => x.store.get("project", "fixture", 1), /Browser checker integrity check failed/);
  } finally { x.store.close(); }
});

test("records survive database close and reopen", () => {
  const directory = path.join(resolveDataDirectory(), randomUUID()); mkdirSync(directory, { recursive: true }); const file = path.join(directory, "node.db");
  let store = new BrowserCheckerStore(new DatabaseSync(file)); const installed = store.install("project", checker(), "user", 42); store.close();
  store = new BrowserCheckerStore(new DatabaseSync(file)); try { assert.deepEqual(store.get("project", "fixture", 1), installed); } finally { store.close(); }
});
