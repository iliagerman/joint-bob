import { spawn as spawnPty } from "node-pty";
import WebSocket from "ws";
import { z } from "zod";
import { watchSubprocess } from "../scripts/subprocess-lifetime.mjs";
import { resolveDataDirectory } from "./data-directory.js";
const terminalMessageSchema = z.union([
  z.object({
    type: z.literal("terminalInput"),
    data: z.string().max(16e3)
  }),
  z.object({
    type: z.literal("terminalResize"),
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(2).max(500)
  })
]);
function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}
function attachTerminalSession(socket, cwd, nodeId, lifetimeOptions) {
  const shell = process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
  const terminal = spawnPty(shell, [], {
    name: "xterm-256color",
    cwd,
    cols: 80,
    rows: 24,
    env: { ...process.env, TERM: "xterm-256color" }
  });
  let exited = false;
  const lifetime = watchSubprocess({ pid: terminal.pid, kill: (signal) => {
    if (exited) return false;
    terminal.kill(signal);
    return true;
  } }, { dataDirectory: resolveDataDirectory(), ...lifetimeOptions });
  terminal.onData((data) => send(socket, { type: "terminalOutput", data }));
  terminal.onExit(({ exitCode, signal }) => {
    exited = true;
    lifetime.exited();
    send(socket, { type: "terminalExit", code: exitCode, signal });
    socket.close(1e3, "Shell exited");
  });
  socket.on("message", (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      send(socket, { type: "terminalError", error: "Invalid terminal input" });
      return;
    }
    const parsed = terminalMessageSchema.safeParse(payload);
    if (!parsed.success) {
      send(socket, { type: "terminalError", error: "Invalid terminal input" });
      return;
    }
    if (exited) return;
    if (parsed.data.type === "terminalInput") terminal.write(parsed.data.data);
    else terminal.resize(parsed.data.cols, parsed.data.rows);
  });
  socket.once("close", () => {
    if (exited) return;
    try {
      terminal.kill();
    } catch {
    }
  });
  send(socket, { type: "terminalReady", cwd, nodeId });
}
export {
  attachTerminalSession
};
