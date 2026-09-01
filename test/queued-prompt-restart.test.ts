import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";

import { freePort } from "./dev-nodes.js";
import { configure, environment, gatedClaude, killNode, login, openChat, queuedTexts, spawnNode, temporaryRoot, waitFor, waitForInvocations } from "./queued-prompt-harness.js";

test("a queued prompt survives a node crash and runs when the node comes back", async () => {
  const root = await temporaryRoot("joint-bob-queue-restart-");
  const previous = { ...process.env };
  Object.assign(process.env, environment(root));
  let node: ChildProcess | undefined;
  let socket: WebSocket | undefined;
  try {
    const executable = await gatedClaude(root);
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    node = await spawnNode(root, port);
    const fixture = await configure(baseUrl, root, executable);

    const opened = openChat(baseUrl, fixture.cookie, fixture.projectId, "claude:new");
    socket = opened.socket;
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "ready"));
    socket.send(JSON.stringify({ type: "prompt", message: "first" }));
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "sessionFile"));
    const sessionFile = String(opened.messages.find((message) => message.type === "sessionFile")!.sessionFile);
    socket.send(JSON.stringify({ type: "prompt", message: "second" }));
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "queueUpdate" && Number(message.pending) >= 1));

    // Kill the node with the prompt still pending, exactly as a crash would.
    socket.terminate();
    await killNode(node);
    node = undefined;

    const restartPort = await freePort();
    const restartUrl = `http://127.0.0.1:${restartPort}`;
    node = await spawnNode(root, restartPort);
    const { cookie } = await login(restartUrl, "replacement-password");
    const reopened = openChat(restartUrl, cookie, fixture.projectId, sessionFile);
    socket = reopened.socket;
    await waitFor(reopened.messages, () => reopened.messages.some((message) => message.type === "queuedPrompts"));
    assert.deepEqual(queuedTexts(reopened.messages), ["second"]);

    await writeFile(`${process.env.JOINT_BOB_FAKE_GATE}.second`, "");
    await waitForInvocations(["first", "second"]);
  } finally {
    socket?.terminate();
    await killNode(node);
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a prompt queued before the conversation has an id survives a crash under its real id", async () => {
  const root = await temporaryRoot("joint-bob-queue-rekey-");
  const previous = { ...process.env };
  const rekeyEnv = { JOINT_BOB_FAKE_INIT_GATE: path.join(root, "init-gate"), JOINT_BOB_FAKE_REPORT_ID: "8f21c0de-4b77-4a15-9c33-7e5d0a2b6f10" };
  Object.assign(process.env, environment(root), rekeyEnv);
  let node: ChildProcess | undefined;
  let socket: WebSocket | undefined;
  try {
    const executable = await gatedClaude(root);
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    node = await spawnNode(root, port, rekeyEnv);
    const fixture = await configure(baseUrl, root, executable);

    const opened = openChat(baseUrl, fixture.cookie, fixture.projectId, "claude:new");
    socket = opened.socket;
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "ready"));
    socket.send(JSON.stringify({ type: "prompt", message: "first" }));
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "agent_start"));

    // The conversation still has no id, so this queues under the placeholder key.
    socket.send(JSON.stringify({ type: "prompt", message: "second" }));
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "userMessage" && message.queued === true));
    assert.equal(opened.messages.some((message) => message.type === "sessionFile"), false, "the conversation has no id yet");

    await writeFile(path.join(root, "init-gate"), "");
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "sessionFile"));
    const sessionFile = String(opened.messages.find((message) => message.type === "sessionFile")!.sessionFile);
    assert.match(sessionFile, /8f21c0de-4b77-4a15-9c33-7e5d0a2b6f10/, "the conversation adopted the id Claude reported");

    socket.terminate();
    await killNode(node);
    node = undefined;

    const restartPort = await freePort();
    node = await spawnNode(root, restartPort, rekeyEnv);
    const { cookie } = await login(`http://127.0.0.1:${restartPort}`, "replacement-password");
    const reopened = openChat(`http://127.0.0.1:${restartPort}`, cookie, fixture.projectId, sessionFile);
    socket = reopened.socket;
    await waitFor(reopened.messages, () => reopened.messages.some((message) => message.type === "queuedPrompts"));
    assert.deepEqual(queuedTexts(reopened.messages), ["second"]);

    await writeFile(`${process.env.JOINT_BOB_FAKE_GATE}.second`, "");
    await waitForInvocations(["first", "second"]);
  } finally {
    socket?.terminate();
    await killNode(node);
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  }
});
