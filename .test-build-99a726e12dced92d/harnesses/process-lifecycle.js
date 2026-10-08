import { UpdateRefusalError } from "../updater.js";
function stopFailure(label) {
  return new UpdateRefusalError(`${label} did not stop within 60 seconds. Update refused; recovery records retained. Verify tools have stopped before restarting the service.`);
}
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
async function stopProcessGroup(child, label) {
  if (!child.pid || process.platform === "win32") {
    throw new UpdateRefusalError(`Cannot verify ${label} process group shutdown on this platform`);
  }
  const exited = () => child.exitCode !== null || child.signalCode !== null;
  if (exited() && !signalGroup(child.pid, 0)) return;
  signalGroup(child.pid, "SIGTERM");
  const started = Date.now();
  let escalated = false;
  while (!exited() || signalGroup(child.pid, 0)) {
    const elapsed = Date.now() - started;
    if (elapsed >= 6e4) throw stopFailure(label);
    if (!escalated && elapsed >= 1e4) {
      signalGroup(child.pid, "SIGKILL");
      escalated = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
export {
  stopProcessGroup
};
