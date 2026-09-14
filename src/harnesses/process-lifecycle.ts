import type { ChildProcess } from "node:child_process";
import { UpdateRefusalError } from "../updater.js";

function stopFailure(label: string): UpdateRefusalError {
  return new UpdateRefusalError(`${label} did not stop within 60 seconds. Update refused; recovery records retained. Verify tools have stopped before restarting the service.`);
}

function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

export async function stopProcessGroup(child: ChildProcess, label: string): Promise<void> {
  if (!child.pid || process.platform === "win32") {
    throw new UpdateRefusalError(`Cannot verify ${label} process group shutdown on this platform`);
  }
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;
  if (exited() && !signalGroup(child.pid, 0)) return;
  signalGroup(child.pid, "SIGTERM");
  const started = Date.now();
  let escalated = false;
  while (!exited() || signalGroup(child.pid, 0)) {
    const elapsed = Date.now() - started;
    if (elapsed >= 60_000) throw stopFailure(label);
    if (!escalated && elapsed >= 10_000) {
      signalGroup(child.pid, "SIGKILL");
      escalated = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
