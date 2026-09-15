import { spawn } from "node:child_process";

let command = null;

function send(message) {
  if (process.connected) process.send(message);
}

process.on("SIGTERM", () => {
  // The supervisor signals the whole group. Stay alive to retain group ownership.
});

process.on("disconnect", () => {
  try {
    process.kill(-process.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
});

process.once("message", message => {
  if (!message || message.type !== "launch") throw new Error("Invalid worker launch message");
  const { spec } = message;
  command = spawn(spec.executable, spec.args, {
    cwd: spec.cwd,
    env: spec.env,
    detached: false,
    shell: false,
    stdio: ["ignore", 1, 2],
  });
  command.once("spawn", () => send({ type: "spawned", pid: command.pid }));
  command.once("error", error => send({ type: "spawn-error", error: error.message }));
  command.once("close", (code, signal) => send({ type: "exited", code, signal }));
});
