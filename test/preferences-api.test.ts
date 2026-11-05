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

test("preferences store the keymap, ignore the removed canvas layout and map a saved canvas view", async () => {
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
    assert.equal("canvasLayout" in (await defaults.json() as object), false, "the canvas layout is gone from the preferences");

    const terminalDefaultsResponse = await fetch(`${node.baseUrl}/api/preferences`, { headers: { Cookie: cookie } });
    const terminalDefaults = await terminalDefaultsResponse.json() as { terminalDock: unknown };
    assert.deepEqual(terminalDefaults.terminalDock, { orientation: "horizontal", horizontalSize: 320, verticalSize: 440 });
    const terminalDock = { orientation: "vertical", horizontalSize: 360, verticalSize: 512 };
    const savedTerminalDock = await fetch(`${node.baseUrl}/api/preferences`, { method: "PUT", headers, body: JSON.stringify({ terminalDock }) });
    assert.equal(savedTerminalDock.status, 200);
    assert.deepEqual((await savedTerminalDock.json() as { terminalDock: unknown }).terminalDock, terminalDock);
    const readTerminalDock = await fetch(`${node.baseUrl}/api/preferences`, { headers: { Cookie: cookie } });
    assert.deepEqual((await readTerminalDock.json() as { terminalDock: unknown }).terminalDock, terminalDock);
    const invalidTerminalDock = await fetch(`${node.baseUrl}/api/preferences`, {
      method: "PUT", headers, body: JSON.stringify({ terminalDock: { ...terminalDock, verticalSize: 179 } }),
    });
    assert.equal(invalidTerminalDock.status, 400);

    const focusDefaults = await fetch(`${node.baseUrl}/api/preferences`, { headers });
    assert.equal((await focusDefaults.json()).focusUiEnabled, false, "existing accounts keep the classic interface");
    for (const focusUiEnabled of [true, false]) {
      const response = await fetch(`${node.baseUrl}/api/preferences`, { method: "PUT", headers, body: JSON.stringify({ focusUiEnabled }) });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).focusUiEnabled, focusUiEnabled);
      const read = await fetch(`${node.baseUrl}/api/preferences`, { headers });
      assert.equal((await read.json()).focusUiEnabled, focusUiEnabled);
    }
    const invalidFocus = await fetch(`${node.baseUrl}/api/preferences`, { method: "PUT", headers, body: JSON.stringify({ focusUiEnabled: "true" }) });
    assert.equal(invalidFocus.status, 400);

    // An older page still sends the canvas layout: it is accepted, and never stored or returned.
    const legacyLayout = await fetch(`${node.baseUrl}/api/preferences`, { method: "PUT", headers, body: JSON.stringify({ canvasLayout: { version: 6, pages: [], activePageId: "page-1" } }) });
    assert.equal(legacyLayout.status, 200);
    assert.equal("canvasLayout" in (await legacyLayout.json() as object), false);

    const keymap = { version: 4, base: ["meta", "shift"], commands: { newPiChat: ["ctrl", "SPACE", "\\"], splitRight: ["ctrl", "SPACE", "-"] } };
    const savedKeymap = await fetch(`${node.baseUrl}/api/preferences`, { method: "PUT", headers, body: JSON.stringify({ canvasKeymap: keymap }) });
    assert.equal(savedKeymap.status, 200);
    const savedKeymapBody = await savedKeymap.json() as { canvasKeymap: { version?: number; commands: Record<string, string[] | null> } };
    assert.equal(savedKeymapBody.canvasKeymap.version, 4);
    assert.deepEqual(savedKeymapBody.canvasKeymap.commands.newPiChat, ["ctrl", "SPACE", "\\"]);
    assert.equal("splitRight" in savedKeymapBody.canvasKeymap.commands, false, "pane commands left with the canvas");

    // The control center keeps card colors, free positions, the layout and the project filter with the account.
    const controlCenter = { colors: { "p:c": "#ff6b9a" }, filter: ["p"], chatSide: "left", chatWidth: 520 };
    // An older page still sends the free layout it had; it is accepted and not kept.
    const savedBoard = await fetch(`${node.baseUrl}/api/preferences`, { method: "PUT", headers, body: JSON.stringify({ controlCenter: { ...controlCenter, positions: { "p:c": { x: 10, y: 20 } }, layout: "free" } }) });
    assert.equal(savedBoard.status, 200);
    assert.deepEqual((await savedBoard.json() as { controlCenter: unknown }).controlCenter, controlCenter);
    const badColor = await fetch(`${node.baseUrl}/api/preferences`, { method: "PUT", headers, body: JSON.stringify({ controlCenter: { ...controlCenter, colors: { "p:c": "red" } } }) });
    assert.equal(badColor.status, 400);

    // The canvas view no longer exists: a saved canvas view opens the control center that replaced it.
    const rejectedView = await fetch(`${node.baseUrl}/api/preferences`, { method: "PUT", headers, body: JSON.stringify({ mobileView: "canvas" }) });
    assert.equal(rejectedView.status, 400);
    await node.close();
    const store = new DatabaseSync(path.join(root, "node.db"));
    store.prepare("UPDATE user_preferences SET mobile_view = 'canvas'").run();
    store.close();
    node = await listen(app.createApp());
    const mapped = await fetch(`${node.baseUrl}/api/preferences`, { headers: { Cookie: cookie } });
    assert.equal((await mapped.json() as { mobileView: string }).mobileView, "control");
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

// Runs against the same in-process stores as the canvas test above: the data
// directory and admin password bind on first import, so this signs in with the
// password that test established rather than pretending to be isolated.
test("conversation read watermarks round-trip through preferences and reject bad shapes", async () => {
  let node: Awaited<ReturnType<typeof listen>> | undefined;
  try {
    const app = await import(`../src/app.js?read-marks=${Date.now()}-${Math.random()}`);
    node = await listen(app.createApp());

    const login = await fetch(`${node.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "replacement-password" }) });
    const cookie = sessionCookie(login);
    const { csrfToken } = await login.json() as { csrfToken: string };
    const headers = { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };

    const defaults = await fetch(`${node.baseUrl}/api/preferences`, { headers: { Cookie: cookie } });
    assert.equal(defaults.status, 200);
    assert.deepEqual((await defaults.json() as { conversationLastRead: unknown }).conversationLastRead, {}, "a fresh account has no read marks");

    const marks = { "conversation-a": 1756544280000, "conversation-b": 1756544340000 };
    const saved = await fetch(`${node.baseUrl}/api/preferences`, { method: "PUT", headers, body: JSON.stringify({ conversationLastRead: marks }) });
    assert.equal(saved.status, 200);
    assert.deepEqual((await saved.json() as { conversationLastRead: unknown }).conversationLastRead, marks);

    const roundTrip = await fetch(`${node.baseUrl}/api/preferences`, { headers: { Cookie: cookie } });
    assert.deepEqual((await roundTrip.json() as { conversationLastRead: unknown }).conversationLastRead, marks, "read marks survive a reload");

    for (const invalid of [
      { "conversation-a": "not-a-number" },
      { "conversation-a": -5 },
      ["conversation-a"],
      Object.fromEntries(Array.from({ length: 401 }, (_, index) => [`conversation-${index}`, index + 1])),
    ]) {
      const rejected = await fetch(`${node.baseUrl}/api/preferences`, { method: "PUT", headers, body: JSON.stringify({ conversationLastRead: invalid }) });
      assert.equal(rejected.status, 400, `rejects ${JSON.stringify(invalid).slice(0, 60)}`);
    }
    const afterRejected = await fetch(`${node.baseUrl}/api/preferences`, { headers: { Cookie: cookie } });
    assert.deepEqual((await afterRejected.json() as { conversationLastRead: unknown }).conversationLastRead, marks, "rejected payloads change nothing");

    // The stored map is bounded: the conversations read longest ago fall off first.
    const oversized = Object.fromEntries(Array.from({ length: 350 }, (_, index) => [`conversation-${index}`, index + 1]));
    const bounded = await fetch(`${node.baseUrl}/api/preferences`, { method: "PUT", headers, body: JSON.stringify({ conversationLastRead: oversized }) });
    assert.equal(bounded.status, 200);
    const storedBounded = (await bounded.json() as { conversationLastRead: Record<string, number> }).conversationLastRead;
    assert.equal(Object.keys(storedBounded).length, 300, "the map is capped");
    assert.equal(storedBounded["conversation-0"], undefined, "the oldest mark fell off");
    assert.equal(storedBounded["conversation-349"], 350, "the newest mark survives");
  } finally {
    if (node) await node.close();
  }
});
