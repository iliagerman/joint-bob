import { spawn as spawnPty, type IPty } from "node-pty";
import WebSocket from "ws";
import { z } from "zod";

const terminalMessageSchema = z.union([
  z.object({
    type: z.literal("terminalInput"),
    data: z.string().max(16_000),
  }),
  z.object({
    type: z.literal("terminalResize"),
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(2).max(500),
  }),
]);

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

// A real pseudo-terminal, so interactive programs, colours, job control, and
// xterm resize all behave exactly like a local terminal in the project folder.
export function attachTerminalSession(socket: WebSocket, cwd: string, nodeId: string): void {
  const shell = process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
  const terminal: IPty = spawnPty(shell, [], {
    name: "xterm-256color",
    cwd,
    cols: 80,
    rows: 24,
    env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
  });
  let exited = false;

  terminal.onData((data) => send(socket, { type: "terminalOutput", data }));
  terminal.onExit(({ exitCode, signal }) => {
    exited = true;
    send(socket, { type: "terminalExit", code: exitCode, signal });
    socket.close(1000, "Shell exited");
  });
  socket.on("message", (raw) => {
    let payload: unknown;
    try {
      payload = JSON.parse((raw as Buffer).toString());
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
    exited = true;
    try {
      terminal.kill();
    } catch {
      // The shell already exited between the close event and the kill.
    }
  });
  send(socket, { type: "terminalReady", cwd, nodeId });
}
