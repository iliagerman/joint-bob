import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import test from "node:test";
import WebSocket from "ws";
import { attachTerminalSession } from "../src/terminal-session.js";

// A test-owned PTY and socket. No installed terminal or user profile is used.
test("PTY lifetime expires its shell and closes the terminal socket", { timeout: 10000 }, async () => {
  const messages: Array<{ type: string }> = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: WebSocket.OPEN as number,
    send: (value: string) => messages.push(JSON.parse(value)),
    close: () => { socket.readyState = WebSocket.CLOSED; socket.emit("close"); },
  });
  const previousShell = process.env.SHELL;
  process.env.SHELL = "/bin/sh";
  try {
    attachTerminalSession(socket as unknown as WebSocket, os.tmpdir(), "fixture", { lifetimeMs: () => 100, graceMs: 50, pollMs: 20 });
    const deadline = Date.now() + 5000;
    while (!messages.some(message => message.type === "terminalExit") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(messages.some(message => message.type === "terminalReady"));
    assert.ok(messages.some(message => message.type === "terminalExit"), "lifetime must terminate the real PTY shell");
    assert.equal(socket.readyState, WebSocket.CLOSED);
  } finally {
    socket.close();
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
  }
});
