import { AsyncLocalStorage } from "node:async_hooks";
import { execFile, spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { accessSync, constants as fsConstants, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { value } from "./settings-store.js";

const execFileAsync = promisify(execFile);

/**
 * The machine wall. With multi-user mode on, every person's agents, shells, terminals and
 * tasks run under their own OS account (`jb-<name>`), with their own home holding their
 * transcripts, harness configuration, skills and temp files. The Joint Bob service only
 * serves; it reaches those homes through ACLs and starts processes through a root helper
 * that can do nothing but manage and run as jb-* accounts. With the mode off, everything
 * runs as the service account, as on a node with one person.
 */
export interface RuntimeAccount {
  /** What runs here: an account id, a cluster runtime, or the service itself. */
  key: string;
  /** The helper's name for the OS account (`noam` for jb-noam); null for the service. */
  name: string | null;
  home: string;
}

const storage = new AsyncLocalStorage<RuntimeAccount>();

export function helperPath(): string {
  return process.env.JOINT_BOB_USERCTL ?? "/usr/local/libexec/joint-bob-userctl";
}

/** Tests use a stand-in helper that keeps one OS user; there are no accounts to grant to. */
export function usingStandInHelper(): boolean {
  return Boolean(process.env.JOINT_BOB_USERCTL) && process.env.JOINT_BOB_USERCTL_SUDO === "0";
}

/** Tests drive a stand-in helper directly, which also runs where the server's environment
    doesn't reach (a supervised task); a real node goes through sudo. */
function helperInvocation(): { command: string; prefix: string[] } {
  if (usingStandInHelper()) return { command: "/usr/bin/env", prefix: [`JOINT_BOB_ACCOUNT_HOME_ROOT=${homeRoot()}`, helperPath()] };
  return { command: "sudo", prefix: ["-n", "-E", helperPath()] };
}

export function helperInstalled(): boolean {
  try { accessSync(helperPath(), fsConstants.X_OK); return true; } catch { return false; }
}

/** On only after the admin turned it on (which also moved the admin into their account). */
export function multiUserEnabled(): boolean {
  return value("multiUser.enabled", "false") === "true" && helperInstalled();
}

function homeRoot(): string {
  return process.env.JOINT_BOB_ACCOUNT_HOME_ROOT ?? (process.platform === "darwin" ? "/Users" : "/home");
}

/** The OS account name for a Joint Bob username: lowercase letters, digits, `_` and `-`. */
export function osNameFor(username: string): string {
  const name = username.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").replace(/-+$/, "").slice(0, 28);
  return name.length >= 3 ? name : `${name}user`.slice(0, 28);
}

export function serviceRuntime(): RuntimeAccount {
  return { key: "service", name: null, home: os.homedir() };
}

export function accountRuntime(key: string, username: string): RuntimeAccount {
  if (!multiUserEnabled()) return serviceRuntime();
  const name = osNameFor(username);
  return { key, name, home: path.join(homeRoot(), `jb-${name}`) };
}

/** A visitor (a person whose home is another node) runs here under an account named by
    their account id, never by username, which a local person may share. */
export function visitorRuntime(accountId: string): RuntimeAccount {
  if (!multiUserEnabled()) return serviceRuntime();
  const name = `v${accountId.replace(/[^0-9a-f]/gi, "").slice(0, 12).toLowerCase()}`;
  return { key: `visitor:${accountId}`, name, home: path.join(homeRoot(), `jb-${name}`) };
}

/** Projects received from a cluster run in that cluster's own account, never a person's. */
export function clusterRuntime(clusterId: string): RuntimeAccount {
  if (!multiUserEnabled()) return serviceRuntime();
  const name = `c${clusterId.replace(/[^0-9a-f]/gi, "").slice(0, 12).toLowerCase()}`;
  return { key: `cluster:${clusterId}`, name, home: path.join(homeRoot(), `jb-${name}`) };
}

export function runInRuntime<T>(runtime: RuntimeAccount, work: () => T): T {
  return storage.run(runtime, work);
}

export function currentRuntime(): RuntimeAccount {
  return storage.getStore() ?? serviceRuntime();
}

/** The home harness defaults resolve against: the running account's, or the service's. */
export function runtimeHome(): string {
  return currentRuntime().home;
}

/** Whether node-wide harness path overrides apply: only to the service's own runtime. */
export function usingServiceRuntime(): boolean {
  return currentRuntime().name === null;
}

/** The command and arguments that run `command` as `runtime` in `cwd`. */
export function runtimeCommand(runtime: RuntimeAccount, cwd: string, command: string, args: string[]): { command: string; args: string[] } {
  if (!runtime.name) return { command, args };
  const helper = helperInvocation();
  return { command: helper.command, args: [...helper.prefix, "run", runtime.name, path.resolve(cwd), "--", command, ...args] };
}

/**
 * spawn() for a runtime. The child is the sudo process, which keeps the service's real uid,
 * so killing it from here works and sudo passes the signal on to the command.
 */
export function spawnInRuntime(runtime: RuntimeAccount, command: string, args: string[], options: SpawnOptions & { cwd: string; stdio: ["pipe", "pipe", "pipe"] }): ChildProcessWithoutNullStreams;
export function spawnInRuntime(runtime: RuntimeAccount, command: string, args: string[], options: SpawnOptions & { cwd: string }): ChildProcess;
export function spawnInRuntime(runtime: RuntimeAccount, command: string, args: string[], options: SpawnOptions & { cwd: string }): ChildProcess {
  if (!runtime.name) return spawn(command, args, options);
  const wrapped = runtimeCommand(runtime, options.cwd, command, args);
  return spawn(wrapped.command, wrapped.args, { ...options, cwd: runtime.home, env: runtimeEnvironment(runtime, options.env ?? process.env) });
}

/** What the service keeps for itself: its data directory, agent sockets and session bus. */
const SERVICE_ONLY_ENVIRONMENT = ["JOINT_BOB_DATA_DIR", "PI_WEB_DATA_DIR", "JOINT_BOB_TASK_DATA_DIR", "JOINT_BOB_TASK_SOCKET", "SSH_AUTH_SOCK", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "JOINT_BOB_BROWSER_TOKEN_FILE"];

export function runtimeEnvironment(runtime: RuntimeAccount, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!runtime.name) return environment;
  const result: NodeJS.ProcessEnv = { ...environment, HOME: runtime.home, TMPDIR: path.join(runtime.home, ".tmp") };
  for (const key of SERVICE_ONLY_ENVIRONMENT) delete result[key];
  return result;
}

/** Model subscriptions are the node's. Claude reaches a person's account as a long-lived
    token from `claude setup-token` that the admin saves once; a copied login would refresh
    in one account and sign out the rest. The service's own runs keep its own login. */
export function claudeSubscriptionEnvironment(): NodeJS.ProcessEnv {
  if (usingServiceRuntime()) return {};
  const token = value("multiUser.claudeToken", "");
  return token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {};
}

export async function runHelper(args: string[]): Promise<string> {
  const helper = helperInvocation();
  const { stdout } = await execFileAsync(helper.command, [...helper.prefix, ...args], { timeout: 120_000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}

/** Creates the OS account (idempotent) and returns its home. */
export async function ensureOsAccount(runtime: RuntimeAccount): Promise<string> {
  if (!runtime.name) return runtime.home;
  return (await runHelper(["create", runtime.name])).split("\n").at(-1) || runtime.home;
}

export async function deleteOsAccount(name: string): Promise<void> {
  await runHelper(["delete", name]);
}

/** Signals a process the runtime's account owns, which the service can't do itself. */
export async function signalRuntimeProcess(runtime: RuntimeAccount, pid: number, signal: NodeJS.Signals, group = false): Promise<void> {
  if (!runtime.name) { process.kill(group ? -pid : pid, signal); return; }
  await runHelper(["kill", runtime.name, signal.replace(/^SIG/, ""), String(group ? -pid : pid)]);
}

/** Signals every process of the runtime's account in a process group the service leads. */
export async function signalRuntimeGroup(runtime: RuntimeAccount, groupId: number, signal: NodeJS.Signals): Promise<void> {
  if (!runtime.name) { try { process.kill(-groupId, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } return; }
  await runHelper(["killgroup", runtime.name, signal.replace(/^SIG/, ""), String(groupId)]);
}

export async function helperVersion(): Promise<string | null> {
  try { return await runHelper(["version"]); } catch { return null; }
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Confinement for what the service reads on a runtime's behalf: a path counts only while
    its real location stays inside that runtime's home, so a symlink can't point the server
    at another person's files or the service's own. Cached briefly; checked on hot paths. */
const realHomes = new Map<string, { real: string; at: number }>();
export function confinedToRuntime(runtime: RuntimeAccount, candidate: string): boolean {
  if (!runtime.name) return true;
  let home = realHomes.get(runtime.home);
  try {
    if (!home || Date.now() - home.at > 30_000) { home = { real: realpathSync(runtime.home), at: Date.now() }; realHomes.set(runtime.home, home); }
    let existing = path.resolve(candidate);
    for (;;) {
      try { return within(home.real, realpathSync(existing)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") return false;
        const parent = path.dirname(existing);
        if (parent === existing) return false;
        existing = parent;
      }
    }
  } catch {
    return false;
  }
}

export async function setAcl(target: string, entry: { kind: "user" | "group"; name: string }, rights: "read" | "write" | "traverse", recursive: boolean): Promise<void> {
  if (usingStandInHelper()) return;
  if (process.platform === "darwin") {
    const list = rights === "traverse" ? "search" : rights === "read"
      ? "list,search,read,execute,readattr,readextattr,readsecurity,file_inherit,directory_inherit"
      : "list,add_file,search,add_subdirectory,delete_child,read,write,append,execute,readattr,writeattr,readextattr,writeextattr,readsecurity,file_inherit,directory_inherit";
    await execFileAsync("chmod", [...(recursive ? ["-R"] : []), "+a", `${entry.kind}:${entry.name} allow ${list}`, target]);
    return;
  }
  const who = entry.kind === "user" ? "u" : "g";
  const mode = rights === "traverse" ? "x" : rights === "read" ? "rX" : "rwX";
  const spec = rights === "traverse" ? `${who}:${entry.name}:${mode}` : `${who}:${entry.name}:${mode},d:${who}:${entry.name}:${mode}`;
  await execFileAsync("setfacl", [...(recursive ? ["-R"] : []), "-m", spec, target]);
}

/** Every directory from the service's home down to `target`, so an account may pass through. */
export async function traverseTo(target: string, entry: { kind: "user" | "group"; name: string }): Promise<void> {
  const home = os.homedir();
  const relative = path.relative(home, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return;
  let current = home;
  await setAcl(current, entry, "traverse", false);
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    await setAcl(current, entry, "traverse", false);
  }
}

/** A project folder in the service's home becomes its runtime account's to work in. */
export async function grantProjectFolder(runtime: RuntimeAccount, folder: string): Promise<void> {
  if (!runtime.name || path.relative(os.homedir(), folder).startsWith("..")) return;
  const user = { kind: "user" as const, name: `jb-${runtime.name}` };
  await traverseTo(path.join(folder, "x"), user);
  await setAcl(folder, user, "write", true);
}
