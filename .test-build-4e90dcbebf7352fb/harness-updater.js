import { execFile } from "./subprocess.js";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { listDiscoveredHarnesses } from "./harnesses/registry.js";
import { configuredRuntime } from "./harnesses/runtime-configuration.js";
import { resolveDataDirectory } from "./data-directory.js";
import { save, settingsDatabase, value } from "./settings-store.js";
const execute = promisify(execFile);
const UPDATE_INTERVAL_MS = 24 * 60 * 6e4;
const UPDATE_TIMEOUT_MS = 10 * 6e4;
const PUBLIC_NPM_REGISTRY = "https://registry.npmjs.org";
function status(adapter, state, error = null) {
  return { id: adapter.id, label: adapter.label, state, checkedAt: ["idle", "unsupported"].includes(state) ? null : (/* @__PURE__ */ new Date()).toISOString(), error };
}
function updateError(error) {
  const failure = error;
  return (failure.stderr?.trim() || failure.message || String(error)).slice(0, 2e3);
}
function managedHarnessRoot(id) {
  return path.join(resolveDataDirectory(), "harnesses", id);
}
function managedHarnessExecutable(id, binaryName) {
  return path.join(managedHarnessRoot(id), "node_modules", ".bin", `${binaryName}${process.platform === "win32" ? ".cmd" : ""}`);
}
function usesBundledExecutable(executable, binaryName, managedExecutable) {
  if (!executable || executable === binaryName || path.resolve(executable) === managedExecutable) return true;
  const installRoot = process.env.JOINT_BOB_INSTALL_ROOT;
  if (!installRoot || !path.isAbsolute(executable)) return false;
  const relative = path.relative(path.resolve(installRoot), path.resolve(executable));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}
function activateManagedHarness(id, binaryName) {
  const executable = managedHarnessExecutable(id, binaryName);
  if (!existsSync(executable)) return;
  const bin = path.dirname(executable);
  const currentPath = (process.env.PATH ?? "").split(path.delimiter).filter((entry) => entry && entry !== bin);
  process.env.PATH = [bin, ...currentPath].join(path.delimiter);
  if (usesBundledExecutable(value(`${id}.executable`), binaryName, executable)) {
    save(settingsDatabase(), `${id}.executable`, executable);
  }
}
function activateManagedHarnesses(adapters = listDiscoveredHarnesses()) {
  for (const adapter of adapters) {
    const update = adapter.configuration?.update;
    if (update?.type === "npm") activateManagedHarness(adapter.id, update.binaryName);
  }
}
function harnessUpdateCommand(id, executable, instructions) {
  if (instructions.type === "self") return { executable, args: instructions.args, cwd: os.homedir() };
  const installRoot = managedHarnessRoot(id);
  return {
    executable: "npm",
    args: ["install", "--prefix", installRoot, "--no-save", "--package-lock=false", "--omit=dev", `--registry=${PUBLIC_NPM_REGISTRY}`, `${instructions.packageName}@latest`],
    cwd: installRoot
  };
}
async function runHarnessUpdates(adapters = listDiscoveredHarnesses()) {
  const results = [];
  for (const adapter of adapters) {
    const configuration = adapter.configuration;
    if (!configuration?.update) {
      results.push(status(adapter, "unsupported"));
      continue;
    }
    const runtime = configuredRuntime(adapter.id, configuration.defaults(os.homedir()));
    try {
      const command = harnessUpdateCommand(adapter.id, runtime.executable, configuration.update);
      if (configuration.update.type === "npm") {
        const root = command.cwd;
        mkdirSync(path.dirname(root), { recursive: true });
        const staging = mkdtempSync(`${root}-staging-`);
        const backup = `${staging}-previous`;
        try {
          const args = command.args.map((arg) => arg === root ? staging : arg);
          await execute(command.executable, args, {
            cwd: staging,
            env: process.env,
            timeout: UPDATE_TIMEOUT_MS,
            maxBuffer: 1024 * 1024
          });
          accessSync(path.join(staging, "node_modules", ".bin", `${configuration.update.binaryName}${process.platform === "win32" ? ".cmd" : ""}`), constants.X_OK);
          const hadPrevious = existsSync(root);
          if (hadPrevious) renameSync(root, backup);
          try {
            renameSync(staging, root);
          } catch (error) {
            if (hadPrevious) renameSync(backup, root);
            throw error;
          }
          if (hadPrevious) rmSync(backup, { recursive: true, force: true });
        } finally {
          rmSync(staging, { recursive: true, force: true });
        }
        activateManagedHarness(adapter.id, configuration.update.binaryName);
      } else {
        await execute(command.executable, command.args, {
          cwd: command.cwd,
          env: process.env,
          timeout: UPDATE_TIMEOUT_MS,
          maxBuffer: 1024 * 1024
        });
      }
      results.push(status(adapter, "succeeded"));
    } catch (error) {
      results.push(status(adapter, "failed", updateError(error)));
    }
  }
  return results;
}
let current = listDiscoveredHarnesses().map((adapter) => status(adapter, adapter.configuration?.update ? "idle" : "unsupported"));
let active = null;
function harnessUpdateStatus() {
  return { running: Boolean(active), harnesses: current.map((entry) => ({ ...entry })) };
}
function startHarnessUpdates() {
  if (active) return harnessUpdateStatus();
  current = listDiscoveredHarnesses().map((adapter) => status(adapter, adapter.configuration?.update ? "running" : "unsupported"));
  active = runHarnessUpdates().then((results) => {
    current = results;
  }).finally(() => {
    active = null;
  });
  return harnessUpdateStatus();
}
let schedulerStarted = false;
function startHarnessUpdateScheduler() {
  if (!/^[0-9a-f]{40}$/i.test(process.env.JOINT_BOB_RELEASE ?? "") || schedulerStarted) return;
  schedulerStarted = true;
  const run = () => {
    if (!active) startHarnessUpdates();
  };
  setTimeout(run, 5 * 6e4).unref();
  setInterval(run, UPDATE_INTERVAL_MS).unref();
}
export {
  activateManagedHarnesses,
  harnessUpdateCommand,
  harnessUpdateStatus,
  runHarnessUpdates,
  startHarnessUpdateScheduler,
  startHarnessUpdates
};
