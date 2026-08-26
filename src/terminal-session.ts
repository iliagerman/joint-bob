import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import WebSocket from "ws";
import { z } from "zod";

const terminalMessageSchema = z.object({
  type: z.literal("terminalInput"),
  data: z.string().max(16_000),
});

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function stopShell(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  child.kill("SIGTERM");
}

export function attachTerminalSession(socket: WebSocket, cwd: string, nodeId: string): void {
  const shell = process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "/bin/sh");
  const child = spawn(shell, [], {
    cwd,
    detached: process.platform !== "win32",
    env: { ...process.env, TERM: "dumb", NO_COLOR: "1", PAGER: "cat" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.once("spawn", () => send(socket, { type: "terminalReady", cwd, nodeId }));
  child.stdout.on("data", (chunk: Buffer) => send(socket, { type: "terminalOutput", data: chunk.toString() }));
  child.stderr.on("data", (chunk: Buffer) => send(socket, { type: "terminalOutput", data: chunk.toString() }));
  child.once("error", (error) => {
    send(socket, { type: "terminalError", error: `Could not start shell: ${error.message}` });
    socket.close(1011, "Could not start shell");
  });
  child.once("close", (code, signal) => {
    send(socket, { type: "terminalExit", code, signal });
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
    child.stdin.write(parsed.data.data);
  });
  socket.once("close", () => stopShell(child));
}
