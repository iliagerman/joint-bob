import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Express } from "express";
import os from "node:os";
import path from "node:path";
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

interface Change { id: string; topic: string; kind: string; status: string; author: string; why: string; edited: boolean; diff: Array<{ type: string; text: string }>; source: { kind: string; text: string; messageId: string | null } }

test("Bob's memory over the API: topics, links and history, changes to keep, edit and revert, Bob's buttons, and one memory per account", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-control-memory-"));
  const previous = { dataDir: process.env.PI_WEB_DATA_DIR, user: process.env.MASTER_BOB_ADMIN_USERNAME, password: process.env.MASTER_BOB_INITIAL_PASSWORD };
  let node: Awaited<ReturnType<typeof listen>> | undefined;
  try {
    process.env.PI_WEB_DATA_DIR = root;
    process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
    process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
    const app = await import(`../src/app.js?control-memory=${Date.now()}-${Math.random()}`);
    node = await listen(app.createApp());
    const login = await fetch(`${node.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    const { csrfToken } = await login.json() as { csrfToken: string };
    await fetch(`${node.baseUrl}/api/auth/change-password`, { method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "a-new-long-password-123" }) });
    const headers = { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };
    const call = async (method: string, route: string, body?: unknown) => {
      const response = await fetch(`${node!.baseUrl}/api/control-center/${route}`, { method, headers, ...body === undefined ? {} : { body: JSON.stringify(body) } });
      return { status: response.status, json: await response.json() as any };
    };

    const { memoryContextFor } = await import("../src/control-center/memory-runtime.js");
    const { listLocalUsers } = await import("../src/auth.js");
    const { cleanTopic, writeTopic, memoryRoot, readTopic } = await import("../src/control-center/memory-store.js");
    const { learnFromExchange } = await import("../src/control-center/memory.js");
    const { collectBobContext } = await import("../src/control-center/bob-hooks.js");
    const { DEFAULT_BOB_SETTINGS } = await import("../src/control-center/bob-store.js");
    const accountId = listLocalUsers().find((user) => user.username === "admin")!.accountId;
    const ctx = await memoryContextFor(accountId);
    const bob = (why: string) => ({ author: "bob" as const, why, source: { kind: "chat" as const, text: "from the chat", messageId: null, conversationId: null, projectId: null, projectName: null } });

    // Nothing yet.
    const empty = await call("GET", "memory/topics");
    assert.deepEqual(empty.json, { topics: [], total: 0, lastRead: null, waiting: 0 });

    // The person creates topics; each is a kept change of their own.
    const gate = await call("POST", "memory/topics", { name: "release-gate", description: "Pushes need the token", body: "Push with the iliagerman token. See [[how-ilia-works]].", project: "jb" });
    assert.equal(gate.status, 201);
    assert.equal(gate.json.change.status, "kept");
    assert.equal(gate.json.change.author, "person");
    assert.deepEqual(gate.json.topic.links, ["how-ilia-works"]);
    assert.equal((await call("POST", "memory/topics", { name: "how-ilia-works", description: "Plans first", body: "Plans before building." })).status, 201);
    assert.equal((await call("POST", "memory/topics", { name: "how-ilia-works", description: "again", body: "again" })).status, 409);
    for (const bad of [{ name: "Bad Name", description: "d", body: "b" }, { name: "ok", description: "d", body: "b", extra: 1 }, { name: "ok", description: "  ", body: "b" }, { name: "ok", description: "d", body: "" }, { name: "ok", description: "d", body: "b", project: "../x" }]) {
      assert.equal((await call("POST", "memory/topics", bad)).status, 400, JSON.stringify(bad));
    }
    const file = readFileSync(path.join(memoryRoot(accountId), "release-gate.md"), "utf8");
    assert.match(file, /^---\nname: release-gate\ndescription: Pushes need the token\nproject: jb\n---/, "a plain markdown file under this account's folder in the data directory");
    assert.match(readFileSync(path.join(memoryRoot(accountId), "INDEX.md"), "utf8"), /- \[\[release-gate\]\] — Pushes need the token/);

    // Reading, searching, links both ways.
    const list = await call("GET", "memory/topics");
    assert.deepEqual(list.json.topics.map((topic: { name: string }) => topic.name).sort(), ["how-ilia-works", "release-gate"]);
    assert.equal(list.json.total, 2);
    assert.deepEqual((await call("GET", "memory/topics?query=push")).json.topics.map((topic: { name: string }) => topic.name), ["release-gate"]);
    assert.deepEqual((await call("GET", "memory/topics?query=zzzz")).json.topics, []);
    assert.equal((await call("GET", "memory/topics?bogus=1")).status, 400);
    const detail = (await call("GET", "memory/topics/how-ilia-works")).json.topic;
    assert.deepEqual({ links: detail.links, linkedFrom: detail.linkedFrom, project: detail.project }, { links: [], linkedFrom: ["release-gate"], project: null });
    assert.equal(detail.history.length, 1);
    assert.equal((await call("GET", "memory/topics/nope")).status, 404);
    assert.equal((await call("GET", "memory/topics/Bad%20Name")).status, 400);

    // Editing is a change too; saving the same text is not.
    const edited = await call("PUT", "memory/topics/how-ilia-works", { description: "Plans first", body: "Plans before building.\nApproves plans himself." });
    assert.deepEqual(edited.json.change.diff, [{ type: "add", text: "Approves plans himself." }]);
    assert.equal((await call("PUT", "memory/topics/how-ilia-works", { description: "Plans first", body: "Plans before building.\nApproves plans himself." })).json.change, null);
    assert.equal((await call("PUT", "memory/topics/nope", { description: "d", body: "b" })).status, 404);

    // Bob proposes a change while "ask first" is on: it waits, then the person keeps it.
    const proposal = writeTopic(ctx, cleanTopic("release-gate", { description: "Pushes need the token", body: "Push with the iliagerman token. See [[how-ilia-works]].\nNever force-push main.", project: "jb" }), bob("You said never force-push"), true)!;
    const changes = await call("GET", "memory/changes?limit=2");
    assert.equal(changes.json.total, 4);
    assert.equal(changes.json.waiting, 1);
    assert.equal(changes.json.changes.length, 2);
    const waiting = changes.json.changes.find((change: Change) => change.id === proposal.id) as Change;
    assert.deepEqual({ status: waiting.status, author: waiting.author, why: waiting.why, topic: waiting.topic }, { status: "pending", author: "bob", why: "You said never force-push", topic: "release-gate" });
    assert.deepEqual(waiting.diff, [{ type: "add", text: "Never force-push main." }]);
    assert.doesNotMatch(readFileSync(path.join(memoryRoot(accountId), "release-gate.md"), "utf8"), /force-push/);
    assert.equal((await call("GET", "memory/changes?offset=2&limit=2")).json.changes.length, 2, "the list pages");
    for (const bad of ["limit=0", "limit=500", "offset=-1", "page=2"]) assert.equal((await call("GET", `memory/changes?${bad}`)).status, 400, bad);

    const keptChange = (await call("POST", `memory/changes/${proposal.id}/keep`)).json.change as Change;
    assert.equal(keptChange.status, "kept");
    assert.match(readFileSync(path.join(memoryRoot(accountId), "release-gate.md"), "utf8"), /Never force-push main/);
    assert.equal((await call("POST", `memory/changes/${proposal.id}/keep`)).status, 409);
    assert.equal((await call("POST", "memory/changes/nope/keep")).status, 404);

    // Bob wrote a change directly: the person edits it, then reverts the edit's predecessor path.
    const written = writeTopic(ctx, cleanTopic("how-ilia-works", { description: "Plans first", body: "Plans before building.\nApproves plans himself.\nNo unrequested worktrees." }), bob("You asked for no worktrees"))!;
    assert.equal(written.status, "applied");
    const editedWritten = await call("POST", `memory/changes/${written.id}/edit`, { description: "Plans first", body: "Plans before building.\nApproves plans himself.\nNever creates worktrees unless asked." });
    assert.equal(editedWritten.json.change.status, "kept");
    assert.match(readFileSync(path.join(memoryRoot(accountId), "how-ilia-works.md"), "utf8"), /Never creates worktrees unless asked/);
    assert.equal((await call("POST", `memory/changes/${written.id}/edit`, { description: "d", body: "b" })).status, 409, "a settled change cannot be edited again");

    const created = writeTopic(ctx, cleanTopic("mobile-ui", { description: "Menu favourites", body: "Mark done." }), bob("From the mobile menu chat"))!;
    const reverted = await call("POST", `memory/changes/${created.id}/revert`);
    assert.equal(reverted.json.change.status, "reverted");
    assert.equal(existsSync(path.join(memoryRoot(accountId), "mobile-ui.md")), false, "reverting a new topic removes it");
    assert.equal((await call("POST", `memory/changes/${created.id}/revert`)).status, 409);

    // Delete is the person's, and can be taken back.
    const deleted = await call("DELETE", "memory/topics/how-ilia-works");
    assert.equal(deleted.json.change.kind, "delete");
    assert.equal((await call("GET", "memory/topics/how-ilia-works")).status, 404);
    assert.equal((await call("DELETE", "memory/topics/how-ilia-works")).status, 404);
    await call("POST", `memory/changes/${deleted.json.change.id}/revert`);
    assert.match((await call("GET", "memory/topics/how-ilia-works")).json.topic.body, /Never creates worktrees unless asked/);

    // Bob's buttons: with "ask before saving" on, a learned change waits behind Keep and Revert in Bob's chat.
    assert.equal((await call("PUT", "bob/settings", { askBeforeSaving: true })).json.askBeforeSaving, true);
    const turn = { session: { accountId } as never, message: "daily reports run on the homeserver at 7", recentChat: [], project: null, options: [], settings: { ...DEFAULT_BOB_SETTINGS, askBeforeSaving: true } };
    const learned = JSON.stringify({ remember: true, topic: "automations-conventions", description: "Reports run on the homeserver", body: "Daily reports run on the homeserver at 07:00.", why: "You set up the slow query report" });
    const deps = { stateCharacters: 100_000, ask: async () => ({ learn: { choice: "preference", confidence: 0.97 } }), agent: async () => learned };
    const pending = (await learnFromExchange(ctx, deps, turn, "Noted."))!;
    assert.equal(pending.status, "pending");
    assert.equal(readTopic(memoryRoot(accountId), "automations-conventions"), null);
    const timeline = (await call("GET", "bob/messages")).json.messages as Array<{ id: string; importance: string; actions: Array<{ id: string }> }>;
    const asked = timeline.find((message) => message.actions.some((action) => action.id === "memory-keep"))!;
    assert.equal(asked.importance, "needs-you");
    const pressed = await call("POST", "bob/action", { messageId: asked.id, actionId: "memory-keep" });
    assert.equal(pressed.status, 200);
    assert.match(pressed.json.messages[0].text, /Kept "automations-conventions"/);
    assert.equal(readTopic(memoryRoot(accountId), "automations-conventions")!.body, "Daily reports run on the homeserver at 07:00.");
    assert.equal((await call("POST", "bob/action", { messageId: asked.id, actionId: "memory-keep" })).status, 404, "a button runs once");

    // Switched off, the same lesson is written at once and the chat offers Revert.
    await call("PUT", "bob/settings", { askBeforeSaving: false });
    const nextLesson = JSON.stringify({ remember: true, topic: "automations-conventions", description: "Reports run on the homeserver", body: "Daily reports run on the homeserver at 07:00.\nHourly checks look back one hour only.", why: "You set up the hourly check" });
    const written2 = (await learnFromExchange(ctx, { ...deps, agent: async () => nextLesson }, { ...turn, settings: DEFAULT_BOB_SETTINGS }, "Noted."))!;
    assert.equal(written2.status, "applied");
    const revertMessage = ((await call("GET", "bob/messages")).json.messages as Array<{ id: string; actions: Array<{ id: string }> }>).find((message) => message.actions.some((action) => action.id === "memory-revert"))!;
    assert.equal((await call("POST", "bob/action", { messageId: revertMessage.id, actionId: "memory-revert" })).status, 200);
    assert.doesNotMatch(readTopic(memoryRoot(accountId), "automations-conventions")!.body, /Hourly/);

    // What Bob reads: the topic list always reaches Bob; with no decision model and no project there is nothing else to ask.
    const contributed = await collectBobContext({ ...turn, message: "how do I push?", settings: DEFAULT_BOB_SETTINGS });
    assert.match(contributed.text, /- release-gate \(jb\): Pushes need the token/);
    assert.match(contributed.text, /- automations-conventions: Reports run on the homeserver/);
    assert.equal((await call("GET", "memory/topics")).json.lastRead.message, "how do I push?");

    // One memory per account.
    const other = await memoryContextFor("f".repeat(32));
    writeTopic(other, cleanTopic("secret-of-someone-else", { description: "Not yours", body: "Private." }), { author: "person", why: "x", source: { kind: "person", text: "", messageId: null, conversationId: null, projectId: null, projectName: null } });
    assert.ok(!(await call("GET", "memory/topics")).json.topics.some((topic: { name: string }) => topic.name === "secret-of-someone-else"));
    assert.equal((await call("GET", "memory/topics/secret-of-someone-else")).status, 404);
    assert.equal(contributed.text.includes("secret-of-someone-else"), false);
  } finally {
    if (node) await node.close();
    for (const [key, value] of [["PI_WEB_DATA_DIR", previous.dataDir], ["MASTER_BOB_ADMIN_USERNAME", previous.user], ["MASTER_BOB_INITIAL_PASSWORD", previous.password]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
