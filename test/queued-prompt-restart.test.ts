import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "sessionFile") && opened.messages.some((message) => message.type === "promptStarted"));
    const sessionFile = String(opened.messages.find((message) => message.type === "sessionFile")!.sessionFile);
    socket.send(JSON.stringify({ type: "prompt", message: "second" }));
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "userMessage" && message.queued === true && message.text === "second"));

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
    await waitFor(reopened.messages, () => reopened.messages.some((message) => message.type === "promptCompleted"));
    assert.ok(reopened.messages.filter((message) => message.type === "textDelta").map((message) => message.text).join("").includes("second"));
  } finally {
    socket?.terminate();
    await killNode(node);
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("a prompt queued before native initialization survives a crash under its ready id", async () => {
  const root = await temporaryRoot("joint-bob-queue-pre-init-");
  const previous = { ...process.env };
  const initEnv = { JOINT_BOB_FAKE_INIT_GATE: path.join(root, "init-gate") };
  Object.assign(process.env, environment(root), initEnv);
  let node: ChildProcess | undefined;
  let socket: WebSocket | undefined;
  try {
    const executable = await gatedClaude(root);
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    node = await spawnNode(root, port, initEnv);
    const fixture = await configure(baseUrl, root, executable);

    const opened = openChat(baseUrl, fixture.cookie, fixture.projectId, "claude:new");
    socket = opened.socket;
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "ready"));
    const readyId = opened.messages.find((message) => message.type === "ready")!.sessionId;
    assert.equal(typeof readyId, "string");
    assert.notEqual(readyId, "", "ready provides the conversation identity before native init");
    assert.equal(opened.messages.some((message) => message.type === "sessionFile"), false, "native init has not reported a session file");
    socket.send(JSON.stringify({ type: "prompt", message: "first" }));
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "agent_start"));

    socket.send(JSON.stringify({ type: "prompt", message: "second" }));
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "userMessage" && message.queued === true && message.text === "second"));
    assert.equal(opened.messages.some((message) => message.type === "sessionFile"), false, "native init has not reported a session file");

    const database = new DatabaseSync(path.join(root, "data", "node.db"));
    const queueRows = database.prepare("SELECT queue_key FROM queued_prompts ORDER BY sequence").all() as Array<{ queue_key: string }>;
    database.close();
    assert.deepEqual(queueRows.map(({ queue_key }) => queue_key), [
      `${fixture.projectId}:${readyId}`,
      `${fixture.projectId}:${readyId}`,
    ]);

    await writeFile(path.join(root, "init-gate"), "");
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "sessionFile") && opened.messages.some((message) => message.type === "promptStarted"));
    const sessionFile = String(opened.messages.find((message) => message.type === "sessionFile")!.sessionFile);
    assert.ok(sessionFile.includes(String(readyId)), "native init retains the ready conversation id");

    socket.terminate();
    await killNode(node);
    node = undefined;

    const restartPort = await freePort();
    node = await spawnNode(root, restartPort, initEnv);
    const { cookie } = await login(`http://127.0.0.1:${restartPort}`, "replacement-password");
    const reopened = openChat(`http://127.0.0.1:${restartPort}`, cookie, fixture.projectId, sessionFile);
    socket = reopened.socket;
    await waitFor(reopened.messages, () => reopened.messages.some((message) => message.type === "ready") && reopened.messages.some((message) => message.type === "queuedPrompts"));
    assert.equal(reopened.messages.find((message) => message.type === "ready")!.sessionId, readyId);
    assert.deepEqual(queuedTexts(reopened.messages), ["second"]);

    await writeFile(`${process.env.JOINT_BOB_FAKE_GATE}.second`, "");
    await waitForInvocations(["first", "second"]);
    await waitFor(reopened.messages, () => reopened.messages.some((message) => message.type === "promptCompleted"));
    assert.ok(reopened.messages.filter((message) => message.type === "textDelta").map((message) => message.text).join("").includes("second"));
  } finally {
    socket?.terminate();
    await killNode(node);
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  }
});
