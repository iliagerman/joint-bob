import { realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asNode } from "./account-context.js";
import { accountRuntime, clusterRuntime, confinedToRuntime, ensureOsAccount, grantProjectFolder, multiUserEnabled, runInRuntime, serviceRuntime, visitorRuntime, type RuntimeAccount } from "./account-runtime.js";
import { save, settingsDatabase, value } from "./settings-store.js";
import { listLocalUsers } from "./auth.js";
import { resolveDataDirectory } from "./data-directory.js";
import { adminAccountId } from "./ownership.js";
import { getSettings } from "./settings.js";
import { getProject, projectRuntimeOwner } from "./store.js";

/** Accounts made on first use (cluster and visitor runtimes); each once per process. */
const ensured = new Map<string, Promise<void>>();
function ready(runtime: RuntimeAccount): Promise<void> {
  if (!runtime.name) return Promise.resolve();
  let pending = ensured.get(runtime.name);
  if (!pending) {
    pending = ensureOsAccount(runtime).then(() => undefined);
    pending.catch(() => ensured.delete(runtime.name!));
    ensured.set(runtime.name, pending);
  }
  return pending;
}

/** The OS account a project's agents, shells and terminals run as. */
export async function runtimeForProject(projectId: string): Promise<RuntimeAccount> {
  if (!multiUserEnabled()) return serviceRuntime();
  const owner = await asNode(() => projectRuntimeOwner(projectId));
  if (!owner) throw new Error("Project not found");
  const runtime = "clusterId" in owner ? clusterRuntime(owner.clusterId) : runtimeForAccount(owner.accountId ?? adminAccountId() ?? "");
  await ready(runtime);
  await granted(projectId, runtime);
  return runtime;
}

/** A cluster's or twin's project lives in the node's projects folder; its runtime account is
    given it once (new files inherit the grant), and the grant is remembered across restarts. */
const granting = new Map<string, Promise<void>>();
function granted(projectId: string, runtime: RuntimeAccount, existing = false): Promise<void> {
  if (!runtime.name) return Promise.resolve();
  const key = `multiUser.grant.${runtime.name}.${projectId}`;
  const memo = `${key}\n${existing}`;
  let pending = granting.get(memo);
  if (!pending) {
    pending = (async () => {
      const project = await asNode(() => getProject(projectId));
      if (!project || confinedToRuntime(runtime, project.path) || value(key, "") === project.path) return;
      if (!existing && !await projectFolderConfined(runtime, project.path)) return;
      if (existing) {
        const real = await realpath(project.path).catch(() => undefined);
        const data = await realFolder(resolveDataDirectory());
        if (!real || inside(real, data) || inside(data, real) || inside(real, os.homedir())) return;
      }
      await grantProjectFolder(runtime, project.path);
      save(settingsDatabase(), key, project.path);
    })();
    pending.catch((error: unknown) => { granting.delete(memo); console.warn(`Could not open a project folder to its runtime account`, error); });
    granting.set(memo, pending);
  }
  return pending.catch(() => undefined);
}

/** When multi-user mode turns on, every project already here is given to its runtime
    account wherever it lies, so the admin's existing projects keep working. */
export async function grantExistingProject(projectId: string): Promise<void> {
  const owner = await asNode(() => projectRuntimeOwner(projectId));
  if (!owner) return;
  const runtime = "clusterId" in owner ? clusterRuntime(owner.clusterId) : runtimeForAccount(owner.accountId ?? adminAccountId() ?? "");
  await ready(runtime);
  await granted(projectId, runtime, true);
}

/** A person here has their own account; a visitor from another node gets one by account id,
    so a visitor named like a local person never shares that person's account. */
export function runtimeForAccount(accountId: string): RuntimeAccount {
  if (!multiUserEnabled()) return serviceRuntime();
  const user = listLocalUsers().find((candidate) => candidate.accountId === accountId);
  if (user) return accountRuntime(accountId, user.username);
  if (!/^[0-9a-f]{32}$/.test(accountId)) throw new Error("Account has no OS account on this node");
  return visitorRuntime(accountId);
}

/** Runs project work as the project's account; an unknown project runs as the node and fails
    in the work itself, as it would without the mode. */
export async function withProjectRuntime<T>(projectId: string, work: () => Promise<T>): Promise<T> {
  if (!multiUserEnabled()) return work();
  const runtime = await runtimeForProject(projectId).catch((error: unknown) => {
    if (error instanceof Error && error.message === "Project not found") return serviceRuntime();
    throw error;
  });
  return runInRuntime(runtime, work);
}

/**
 * A harness session keeps the runtime it was opened in: every later call, from whatever
 * socket or timer, resolves paths and starts processes as the project's account.
 */
export function bindToRuntime<T extends object>(target: T, runtime: RuntimeAccount): T {
  if (!runtime.name) return target;
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = runInRuntime(runtime, () => Reflect.get(object, property, receiver));
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => runInRuntime(runtime, () => (value as (...values: unknown[]) => unknown).apply(object, args));
    },
  });
}

/** Where a person's new projects go: their own home in multi-user mode, else the node's. */
export function projectHomeFor(account: { accountId: string; role: string | null; isRemoteLogin: boolean } | undefined, nodeHome: string): string {
  if (!account || !multiUserEnabled()) return nodeHome;
  return path.join(runtimeForAccount(account.accountId).home, "JointBob");
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The real path of a folder that may not exist yet: its nearest existing ancestor's. */
async function realFolder(folder: string): Promise<string> {
  let existing = path.resolve(folder);
  const missing: string[] = [];
  for (;;) {
    try { return path.join(await realpath(existing), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.push(path.basename(existing));
      existing = parent;
    }
  }
}

export class ProjectFolderError extends Error {
  readonly statusCode = 403;
}

/**
 * In multi-user mode the server reads project folders as the service, so a folder must
 * belong to the person: inside their own home. The admin may also bring a folder from the
 * node's projects folder, which their account is then given; never the service's data.
 * Returns the runtime to grant the folder to, when it lies outside that runtime's home.
 */
export async function assertProjectFolderAllowed(account: { accountId: string; role: string | null } | undefined, folder: string): Promise<RuntimeAccount | undefined> {
  if (!account || !multiUserEnabled()) return undefined;
  const runtime = runtimeForAccount(account.accountId);
  const real = await realFolder(folder);
  if (inside(await realFolder(runtime.home), real)) return undefined;
  const nodeProjects = await realFolder(getSettings().projects.homePath);
  const data = await realFolder(resolveDataDirectory());
  if (account.role === "admin" && inside(nodeProjects, real) && !inside(real, data) && !inside(data, real)) return runtime;
  throw new ProjectFolderError(account.role === "admin"
    ? "Choose a folder in your own home or in the node's projects folder"
    : "Choose a folder in your own home");
}

/** A project folder the server may serve: one confined to its runtime account's home; for
    the admin's and cluster runtimes also one in the node's projects folder, or one granted to
    that runtime when multi-user mode turned on. Never the service's data. */
export async function projectFolderConfined(runtime: RuntimeAccount, folder: string, projectId?: string): Promise<boolean> {
  if (!runtime.name) return true;
  if (confinedToRuntime(runtime, folder)) return true;
  if (runtime.key !== adminAccountId() && !runtime.key.startsWith("cluster:")) return false;
  let real: string;
  try { real = await realpath(folder); } catch { return true; } // A missing folder serves nothing; the route reports it.
  const data = await realFolder(resolveDataDirectory());
  if (inside(real, data) || inside(data, real)) return false;
  if (projectId && value(`multiUser.grant.${runtime.name}.${projectId}`, "") === folder) return true;
  return inside(await realFolder(getSettings().projects.homePath), real);
}
