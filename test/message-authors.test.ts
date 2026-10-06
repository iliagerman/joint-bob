import assert from "node:assert/strict";
import { rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import test from "node:test";
import type WebSocket from "ws";
import { configure, environment, gatedClaude, openChat, startServer, stopServer, temporaryRoot, waitFor, waitForInvocations } from "./queued-prompt-harness.js";

test("a message shows who wrote it, live and after a reload", async () => {
  const root = await temporaryRoot("joint-bob-authors-");
  const previous = { ...process.env };
  Object.assign(process.env, environment(root));
  let server: Server | undefined;
  const sockets: WebSocket[] = [];
  try {
    const executable = await gatedClaude(root);
    const started = await startServer();
    server = started.server;
    const fixture = await configure(started.baseUrl, root, executable);
    const email = await fetch(`${started.baseUrl}/api/auth/email`, { method: "PUT", headers: fixture.headers, body: JSON.stringify({ email: "Admin@Example.test" }) });
    assert.equal(email.status, 200);

    const opened = openChat(started.baseUrl, fixture.cookie, fixture.projectId, "claude:new");
    sockets.push(opened.socket);
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "ready"));
    opened.socket.send(JSON.stringify({ type: "prompt", message: "written by the admin" }));
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "userMessage"));
    const live = opened.messages.find((message) => message.type === "userMessage") as { author?: { email: string } };
    assert.equal(live.author?.email, "admin@example.test", "the live message carries its author");
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "sessionFile"));
    const sessionFile = String(opened.messages.find((message) => message.type === "sessionFile")!.sessionFile);
    await writeFile(`${process.env.JOINT_BOB_FAKE_GATE}.written by the admin`, "");
    await waitForInvocations(["written by the admin"]);
    await waitFor(opened.messages, () => opened.messages.some((message) => message.type === "promptCompleted"));

    const reopened = openChat(started.baseUrl, fixture.cookie, fixture.projectId, sessionFile);
    sockets.push(reopened.socket);
    await waitFor(reopened.messages, () => reopened.messages.some((message) => message.type === "ready"));
    const ready = reopened.messages.find((message) => message.type === "ready") as { messages: Array<{ role: string; text: string; author?: { email: string } }> };
    const user = ready.messages.find((message) => message.role === "user");
    assert.equal(user?.text, "written by the admin");
    assert.equal(user?.author?.email, "admin@example.test", "the reloaded message keeps its author");
  } finally {
    for (const socket of sockets) socket.terminate();
    await stopServer(server);
    process.env = previous;
    await rm(root, { recursive: true, force: true });
  }
});
