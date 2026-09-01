import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

import { configure, environment, gatedClaude, login, openChat, queuedTexts, startServer, stopServer, temporaryRoot, waitFor, waitForInvocations } from "./queued-prompt-harness.js";

test("a prompt queued behind a running turn survives a dropped socket", async () => {
  const root = await temporaryRoot("joint-bob-queue-drop-");
  const previous = { ...process.env };
  Object.assign(process.env, environment(root));
  let server: Server | undefined;
  let first: WebSocket | undefined;
  let second: WebSocket | undefined;
  try {
    const executable = await gatedClaude(root);
    const started = await startServer();
    server = started.server;
    const fixture = await configure(started.baseUrl, root, executable);

    const opened = openChat(started.baseUrl, fixture.cookie, fixture.projectId, "claude:new");
    first = opened.socket;
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "ready"));
    first.send(JSON.stringify({ type: "prompt", message: "first" }));
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "sessionFile"));
    const sessionFile = String(opened.messages.find((message) => message.type === "sessionFile")!.sessionFile);
    first.send(JSON.stringify({ type: "prompt", message: "second" }));
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "queueUpdate" && Number(message.pending) >= 1));

    first.terminate();
    const reopened = openChat(started.baseUrl, fixture.cookie, fixture.projectId, sessionFile);
    second = reopened.socket;
    await waitFor(reopened.messages, () => reopened.messages.some((message) => message.type === "queuedPrompts"));
    assert.deepEqual(queuedTexts(reopened.messages), ["second"]);

    await writeFile(`${process.env.JOINT_BOB_FAKE_GATE}.first`, "");
    await writeFile(`${process.env.JOINT_BOB_FAKE_GATE}.second`, "");
    await waitForInvocations(["first", "second"]);
    // Once it is handed to the agent it is no longer pending, so a later reader
    // must not see it queued a second time.
    const third = openChat(started.baseUrl, fixture.cookie, fixture.projectId, sessionFile);
    try {
      await waitFor(third.messages, () => third.messages.some((message) => message.type === "queuedPrompts"));
      assert.deepEqual(queuedTexts(third.messages), []);
    } finally { third.socket.terminate(); }
  } finally {
    first?.terminate();
    second?.terminate();
    await stopServer(server);
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  }
});

