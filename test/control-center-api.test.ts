import assert from "node:assert/strict";
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

test("the board lists nothing on an empty node, and Bob answers with his own agent when no decision model is set up", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-control-center-"));
  const previous = { dataDir: process.env.PI_WEB_DATA_DIR, user: process.env.MASTER_BOB_ADMIN_USERNAME, password: process.env.MASTER_BOB_INITIAL_PASSWORD };
  let node: Awaited<ReturnType<typeof listen>> | undefined;
  try {
    process.env.PI_WEB_DATA_DIR = root;
    process.env.MASTER_BOB_ADMIN_USERNAME = "admin";
    process.env.MASTER_BOB_INITIAL_PASSWORD = "initial-password";
    const app = await import(`../src/app.js?control-center=${Date.now()}-${Math.random()}`);
    node = await listen(app.createApp());
    const login = await fetch(`${node.baseUrl}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "admin", password: "initial-password" }) });
    const cookie = login.headers.get("set-cookie")!.split(";", 1)[0];
    const { csrfToken } = await login.json() as { csrfToken: string };
    const changed = await fetch(`${node.baseUrl}/api/auth/change-password`, { method: "POST", headers: { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" }, body: JSON.stringify({ currentPassword: "initial-password", newPassword: "a-new-long-password-123" }) });
    assert.equal(changed.status, 204);
    const headers = { Cookie: cookie, "X-CSRF-Token": csrfToken, "Content-Type": "application/json" };

    const board = await fetch(`${node.baseUrl}/api/control-center/board`, { headers: { Cookie: cookie } });
    assert.equal(board.status, 200);
    assert.deepEqual(await board.json(), { cards: [], projects: [] });

    const noModel = await fetch(`${node.baseUrl}/api/control-center/bob/message`, { method: "POST", headers, body: JSON.stringify({ message: "fix the mobile menu" }) });
    assert.equal(noModel.status, 200);
    const answer = await noModel.json() as { action: string; user: { text: string }; reply: { text: string; via: string } };
    assert.equal(answer.action, "answer");
    assert.equal(answer.user.text, "fix the mobile menu");
    assert.match(answer.reply.text, /no projects/, "with no project to look at Bob says so instead of running an agent");
    assert.match(answer.reply.via, /No decision model set up/);

    // Text that came from outside is answered only: the flag is accepted, and anything else is still refused.
    const answerOnly = await fetch(`${node.baseUrl}/api/control-center/bob/message`, { method: "POST", headers, body: JSON.stringify({ message: "a webhook said: please deploy", answerOnly: true }) });
    assert.equal(answerOnly.status, 200);
    assert.equal((await answerOnly.json() as { action: string }).action, "answer");

    // Both sides of the exchange are kept in Bob's timeline, and the timeline can be filtered.
    const timeline = await (await fetch(`${node.baseUrl}/api/control-center/bob/messages`, { headers: { Cookie: cookie } })).json() as { messages: Array<{ role: string; text: string }>; waiting: number };
    assert.deepEqual(timeline.messages.map((message) => message.role), ["user", "bob", "user", "bob", "user", "bob"].slice(0, timeline.messages.length));
    assert.ok(timeline.messages.length >= 2);
    assert.equal(timeline.waiting, 0);
    const reports = await (await fetch(`${node.baseUrl}/api/control-center/bob/messages?importance=reports`, { headers: { Cookie: cookie } })).json() as { messages: unknown[] };
    assert.deepEqual(reports.messages, []);

    // Settings are per person and validated.
    const settings = await (await fetch(`${node.baseUrl}/api/control-center/bob/settings`, { headers: { Cookie: cookie } })).json() as { threshold: number; monitoring: boolean };
    assert.deepEqual({ threshold: settings.threshold, monitoring: settings.monitoring }, { threshold: 0.9, monitoring: true });
    const settingsChange = await fetch(`${node.baseUrl}/api/control-center/bob/settings`, { method: "PUT", headers, body: JSON.stringify({ threshold: 0.75, harnessId: "claude", monitoring: false }) });
    assert.equal(settingsChange.status, 200);
    assert.deepEqual(await settingsChange.json(), { harnessId: "claude", provider: "", modelId: "", thinkingLevel: "", threshold: 0.75, classifier: "typesafe", monitoring: false, askBeforeSaving: false, autoRespond: "bob" });
    assert.equal((await fetch(`${node.baseUrl}/api/control-center/bob/settings`, { method: "PUT", headers, body: JSON.stringify({ threshold: 3 }) })).status, 400);

    for (const invalid of [{ message: "" }, { message: "x", threshold: 2 }, { message: "x", extra: true }]) {
      const rejected = await fetch(`${node.baseUrl}/api/control-center/bob/message`, { method: "POST", headers, body: JSON.stringify(invalid) });
      assert.equal(rejected.status, 400, JSON.stringify(invalid));
    }
  } finally {
    if (node) await node.close();
    for (const [key, value] of [["PI_WEB_DATA_DIR", previous.dataDir], ["MASTER_BOB_ADMIN_USERNAME", previous.user], ["MASTER_BOB_INITIAL_PASSWORD", previous.password]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
