import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Express } from "express";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

async function listen(app: Express) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error("Missing session cookie");
  return cookie.split(";", 1)[0];
}

test("preferences store v6 canvas layouts and reject invalid trees", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-preferences-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  const previousUsername = process.env.MASTER_BOB_ADMIN_USERNAME;
  const previousPassword = process.env.MASTER_BOB_INITIAL_PASSWORD;
  let node: Awaited<ReturnType<typeof listen>> | undefined;
  try {
    process.env.PI_WEB_DATA_DIR = root;
    process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
    process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
    const app = await import(`../src/app.js?preferences=${Date.now()}-${Math.random()}`);
    node = await listen(app.createApp());

    const login = await fetch(`${node.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
    const cookie = sessionCookie(login);
    const { csrfToken } = await login.json() as { csrfToken: string };
    const passwordChange = await fetch(`${node.baseUrl}/api/auth/change-password`, { method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "replacement-password" }) });
    assert.equal(passwordChange.status, 204);
    const headers = { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };

    const defaults = await fetch(`${node.baseUrl}/api/preferences`, { headers: { Cookie: cookie } });
    assert.equal(defaults.status, 200);
    assert.deepEqual((await defaults.json() as { canvasLayout: unknown }).canvasLayout,
      { version: 6, pages: [{ id: "page-1", name: "Page 1", root: null, focusedPaneId: null, projectFilter: "" }], activePageId: "page-1" });

    const pane = (id: string, sessionId: string) => ({ kind: "pane" as const, id, projectId: "p", sessionPath: `/tmp/${sessionId}.jsonl`, sessionId, executionNodeId: null });
    const stored = { version: 6 as const, activePageId: "page", pages: [{ id: "page", name: "Page", root: { kind: "split" as const, id: "split", axis: "row" as const, ratio: 0.4, first: pane("pane-a", "s-a"), second: pane("pane-b", "s-b") }, focusedPaneId: "pane-b", projectFilter: "" }] };
    const saved = await fetch(`${node.baseUrl}/api/preferences`, { method: "PUT", headers, body: JSON.stringify({ canvasLayout: stored }) });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json() as { canvasLayout: unknown }).canvasLayout, stored);

    for (const invalid of [
      { ...stored, activePageId: "missing" },
      { ...stored, pages: [{ ...stored.pages[0], focusedPaneId: "missing" }] },
      { ...stored, pages: [{ ...stored.pages[0], root: { kind: "split", id: "split", axis: "row", ratio: .9, first: pane("pane-a", "s-a"), second: pane("pane-b", "s-b") } }] },
      { ...stored, pages: [{ ...stored.pages[0], root: { kind: "split", id: "pane-a", axis: "row", ratio: .5, first: pane("pane-a", "s-a"), second: pane("pane-b", "s-b") } }] },
      { ...stored, pages: [...Array.from({ length: 10 }, (_, index) => ({ id: `p${index}`, name: `P${index}`, root: null, focusedPaneId: null, projectFilter: "" }))] },
      { ...stored, pages: [{ ...stored.pages[0], root: { kind: "split", id: "s2", axis: "row", ratio: .5, first: pane("pane-a", "s-a"), second: pane("pane-b", "s-a") } }] },
    ]) {
      const response = await fetch(`${node.baseUrl}/api/preferences`, { method: "PUT", headers, body: JSON.stringify({ canvasLayout: invalid }) });
      assert.equal(response.status, 400, JSON.stringify(invalid).slice(0, 120));
    }

    // Weighted v5 rows keep their proportions as nested splits on one page.
    const put = async (canvasLayout: unknown) => {
      const response = await fetch(`${node.baseUrl}/api/preferences`, { method: "PUT", headers, body: JSON.stringify({ canvasLayout }) });
      return { status: response.status, body: await response.json() as { canvasLayout?: { version?: number; pages?: Array<{ name?: string; root?: unknown; focusedPaneId?: string | null }> } } };
    };
    const legacyPane = (id: string, sessionId: string) => ({ kind: "pane" as const, id, projectId: "p", sessionPath: `/tmp/${sessionId}.jsonl`, sessionId, executionNodeId: null });
    const weighted = await put({ version: 5, rows: [{ id: "row-a", height: null, weights: [0.25, 0.75], panes: [legacyPane("pane-a", "s-a"), legacyPane("pane-b", "s-b")] }], focusedPaneId: "pane-b" });
    assert.equal(weighted.status, 200);
    assert.equal(weighted.body.canvasLayout?.version, 6);
    assert.equal(weighted.body.canvasLayout?.pages?.length, 1);
    assert.equal((weighted.body.canvasLayout?.pages?.[0].root as { ratio?: number }).ratio, 0.25);
    assert.equal(weighted.body.canvasLayout?.pages?.[0].focusedPaneId, "pane-b");

    // A v1 split tree migrates unchanged onto its first page.
    const legacyTree = await put({ version: 1, root: { kind: "split", id: "split", axis: "row", ratio: .3, first: legacyPane("legacy-a", "legacy-a"), second: legacyPane("legacy-b", "legacy-b") }, focusedPaneId: "legacy-a" });
    assert.equal(legacyTree.status, 200);
    assert.equal((legacyTree.body.canvasLayout?.pages?.[0].root as { ratio?: number }).ratio, .3);
    assert.equal(legacyTree.body.canvasLayout?.pages?.[0].focusedPaneId, "legacy-a");

    // Nine conversations no longer fit one page; they spread in reading order.
    const nine = await put({ version: 5, rows: [
      { id: "row-9a", height: null, weights: Array.from({ length: 5 }, () => 1 / 5), panes: Array.from({ length: 5 }, (_, index) => legacyPane(`p${index}`, `s${index}`)) },
      { id: "row-9b", height: null, weights: [.25, .25, .25, .25], panes: Array.from({ length: 4 }, (_, index) => legacyPane(`p${index + 5}`, `s${index + 5}`)) },
    ], focusedPaneId: "p8" });
    assert.equal(nine.status, 200);
    assert.deepEqual(nine.body.canvasLayout?.pages?.map((page) => page.name), ["Page 1", "Page 2"]);
    assert.equal(nine.body.canvasLayout?.pages?.[1].focusedPaneId, "p8", "focus follows its pane onto its own page");

    // The largest layout v5 allowed (10 rows x 8 panes) is still accepted: pages cap
    // at nine and overflow panes are dropped rather than corrupting the account.
    const oversize = await put({ version: 5, rows: Array.from({ length: 10 }, (_, row) => ({ id: `row-${row}`, height: null, weights: Array.from({ length: 8 }, () => 1 / 8), panes: Array.from({ length: 8 }, (_, column) => legacyPane(`p-${row}-${column}`, `s-${row}-${column}`)) })), focusedPaneId: "p-9-7" });
    assert.equal(oversize.status, 200);
    assert.equal(oversize.body.canvasLayout?.pages?.length, 9);
    const pageCount = (oversize.body.canvasLayout?.pages ?? []).map((page) => JSON.stringify(page.root).match(/"kind":"pane"/g)?.length ?? 0);
    assert.deepEqual(pageCount, Array.from({ length: 9 }, () => 8));
    assert.equal(pageCount.reduce((sum, count) => sum + count, 0), 72, "overflow panes are dropped, not stored");

    // Restore the value the restart assertion below expects.
    const restored = await fetch(`${node.baseUrl}/api/preferences`, { method: "PUT", headers, body: JSON.stringify({ canvasLayout: stored }) });
    assert.equal(restored.status, 200);

    await node.close();
    node = await listen(app.createApp());
    const persisted = await fetch(`${node.baseUrl}/api/preferences`, { headers: { Cookie: cookie } });
    assert.equal(persisted.status, 200);
    assert.deepEqual((await persisted.json() as { canvasLayout: unknown }).canvasLayout, stored);

    // A hand-edited or corrupt stored tree must degrade to an empty canvas, never a broken one.
    await node.close();
    const store = new DatabaseSync(path.join(root, "node.db"));
    // A stored version 1 tree holding more than eight conversations still spreads
    // over pages, so a restart can never resurrect an unsaveable layout.
    let legacySplits = 0;
    const balancedV1 = (panes: unknown[]): unknown => panes.length === 1 ? panes[0]
      : { kind: "split", id: `legacy-split-${legacySplits++}`, axis: "row", ratio: Math.ceil(panes.length / 2) / panes.length, first: balancedV1(panes.slice(0, Math.ceil(panes.length / 2))), second: balancedV1(panes.slice(Math.ceil(panes.length / 2))) };
    const nineLegacy = Array.from({ length: 9 }, (_, index) => pane(`v1-${index}`, `v1-s-${index}`));
    store.prepare("UPDATE user_preferences SET canvas_layout = ?").run(JSON.stringify({ version: 1, root: balancedV1(nineLegacy), focusedPaneId: "v1-8" }));
    node = await listen(app.createApp());
    const spread = await fetch(`${node.baseUrl}/api/preferences`, { headers: { Cookie: cookie } });
    assert.equal(spread.status, 200);
    const spreadLayout = (await spread.json() as { canvasLayout: { pages?: unknown[] } }).canvasLayout;
    assert.equal(spreadLayout.pages?.length, 2, "a stored nine-pane v1 tree spreads across two pages");

    await node.close();
    store.prepare("UPDATE user_preferences SET canvas_layout = ?").run(JSON.stringify({ version: 6, pages: [{ id: "page-1", name: "Page 1", root: { kind: "split", id: "split", axis: "row", ratio: 2, first: pane("pane-a", "s-a"), second: pane("pane-b", "s-b") }, focusedPaneId: null, projectFilter: "" }], activePageId: "page-1" }));
    store.close();
    node = await listen(app.createApp());
    const degraded = await fetch(`${node.baseUrl}/api/preferences`, { headers: { Cookie: cookie } });
    assert.equal(degraded.status, 200);
    assert.deepEqual((await degraded.json() as { canvasLayout: unknown }).canvasLayout,
      { version: 6, pages: [{ id: "page-1", name: "Page 1", root: null, focusedPaneId: null, projectFilter: "" }], activePageId: "page-1" });
  } finally {
    if (node) await node.close();
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
    if (previousUsername === undefined) delete process.env.MASTER_BOB_ADMIN_USERNAME;
    else process.env.MASTER_BOB_ADMIN_USERNAME = previousUsername;
    if (previousPassword === undefined) delete process.env.MASTER_BOB_INITIAL_PASSWORD;
    else process.env.MASTER_BOB_INITIAL_PASSWORD = previousPassword;
    await rm(root, { recursive: true, force: true });
  }
});
