import { execFile } from "node:child_process";
import { cp, mkdir, realpath, stat, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { asNode } from "../account-context.js";
import { accountRuntime, deleteOsAccount, ensureOsAccount, grantProjectFolder, helperInstalled, helperVersion, multiUserEnabled, runInRuntime, runtimeCommand, serviceRuntime, setAcl, traverseTo, type RuntimeAccount } from "../account-runtime.js";
import { listLocalUsers } from "../auth.js";
import { resolveDataDirectory } from "../data-directory.js";
import { listDiscoveredHarnesses } from "../harnesses/registry.js";
import { configuredRuntime, detectExecutable } from "../harnesses/runtime-configuration.js";
import { multiUserStatus, recordSelfTest } from "../multi-user.js";
import { save, settingsDatabase } from "../settings-store.js";
import { getSettings } from "../settings.js";
import { listProjects } from "../store.js";
import { grantExistingProject } from "../project-runtime.js";

const execFileAsync = promisify(execFile);

async function inRuntime(runtime: RuntimeAccount, script: string, timeout = 20_000): Promise<{ ok: boolean; stdout: string }> {
  const { command, args } = runtimeCommand(runtime, runtime.home, "/bin/sh", ["-c", script]);
  try {
    const { stdout } = await execFileAsync(command, args, { timeout, cwd: runtime.home, env: { ...process.env, HOME: runtime.home } });
    return { ok: true, stdout };
  } catch (error) {
    return { ok: false, stdout: String((error as { stdout?: string }).stdout ?? "") };
  }
}

const SELF_TEST_ACCOUNTS = ["zzjbselftesta", "zzjbselftestb"];

/**
 * Proves the wall on this machine with two throwaway accounts: neither can read the other's
 * home, the service's database or secret key, see the other's process arguments, or reach a
 * port the other listens on. Both accounts are deleted afterwards. "Add user" waits for it.
 */
export async function runSelfTest(): Promise<{ passed: boolean; failures: string[]; warnings: string[] }> {
  const failures: string[] = [], warnings: string[] = [];
  if (!helperInstalled() || !await helperVersion()) {
    return { ...recordSelfTest(false, ["The multi-user helper isn't installed or can't run through sudo"], false).selfTest, warnings };
  }
  const [a, b] = SELF_TEST_ACCOUNTS.map((name) => ({ key: `selftest:${name}`, name, home: "" }) as RuntimeAccount);
  try {
    a.home = await ensureOsAccount(a);
    b.home = await ensureOsAccount(b);
    const dataDir = resolveDataDirectory();
    await inRuntime(b, `printf private-b > "$HOME/probe"`);
    if ((await inRuntime(a, `cat "${b.home}/probe"`)).ok) failures.push("One account can read another's home");
    for (const file of ["node.db", "secret.key", "supervisor.db"]) {
      if ((await inRuntime(a, `cat "${path.join(dataDir, file)}" >/dev/null`)).ok) failures.push(`An account can read the service's ${file}`);
    }
    await inRuntime(a, `printf from-a > "$HOME/out"`);
    try { if ((await readFile(path.join(a.home, "out"), "utf8")) !== "from-a") failures.push("The service can't read what an account writes"); }
    catch { failures.push("The service can't read what an account writes"); }
    await writeFile(path.join(a.home, "in"), "from-service", { mode: 0o660 });
    if ((await inRuntime(a, `cat "$HOME/in"`)).stdout !== "from-service") failures.push("An account can't read what the service writes into its home");

    const marker = `jb-selftest-marker-${process.pid}`;
    const sleeper = runtimeCommand(b, b.home, "/bin/sh", ["-c", `sleep 15; : ${marker}`]);
    const background = execFile(sleeper.command, sleeper.args, { cwd: b.home, env: { ...process.env, HOME: b.home } });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const ps = await inRuntime(a, "ps -A -o args 2>/dev/null || ps -eo args");
    if (ps.stdout.includes(marker)) (process.platform === "linux" ? failures : warnings).push("One account can see another's process arguments");

    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const listener = runtimeCommand(b, b.home, process.execPath, ["-e", `require("net").createServer((s)=>s.end("b")).listen(${port},"127.0.0.1");setTimeout(()=>process.exit(0),12000)`]);
    const listening = execFile(listener.command, listener.args, { cwd: b.home, env: { ...process.env, HOME: b.home } });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const probe = await inRuntime(a, `"${process.execPath}" -e 'const s=require("net").connect(${port},"127.0.0.1");s.setTimeout(2000,()=>{process.stdout.write("closed");process.exit(0)});s.on("data",()=>{process.stdout.write("open");process.exit(0)});s.on("error",()=>{process.stdout.write("closed");process.exit(0)})'`);
    if (probe.stdout.includes("open")) (process.platform === "linux" ? failures : warnings).push("One account can reach a local port another listens on");
    background.kill(); listening.kill();
  } catch (error) {
    failures.push(`The self-test could not run: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    for (const name of SELF_TEST_ACCOUNTS) await deleteOsAccount(name).catch(() => undefined);
  }
  const status = recordSelfTest(failures.length === 0, failures, true);
  return { passed: status.selfTest.passed, failures, warnings };
}

/** What every account must read and run: Node, the app, the harnesses and shared agent
    resources. The service owns them, so it grants this itself; nothing else of its home opens. */
export async function grantSharedRuntimeAccess(): Promise<void> {
  const group = { kind: "group" as const, name: "jointbob-users" };
  const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const node = path.resolve(path.dirname(process.execPath), "..");
  const harnesses = await Promise.all(listDiscoveredHarnesses().map(async (adapter) => {
    if (!adapter.configuration) return undefined;
    try { return path.resolve(path.dirname(await realpath(detectExecutable(adapter.id === "pi" ? "pi" : adapter.id === "kiro" ? "kiro-cli" : "claude"))), ".."); } catch { return undefined; }
  }));
  const resources = path.join(path.resolve(getSettings().projects.homePath), ".agent-resources");
  await mkdir(resources, { recursive: true });
  for (const target of [app, node, resources, ...harnesses.filter((entry): entry is string => Boolean(entry))]) {
    const inHome = !path.relative(os.homedir(), target).startsWith("..");
    if (!inHome) continue;
    await traverseTo(target, group);
    await setAcl(target, group, "read", true);
  }
}

export { grantProjectFolder } from "../account-runtime.js";

/** What of a harness's configuration folder moves with the admin, beside its transcripts. */
const CONFIGURATION_ENTRIES: Record<string, string[]> = {
  claude: ["commands", "skills", "agents", "settings.json"],
  pi: ["skills", "prompts", "extensions", "settings.json"],
  kiro: ["agents", "settings"],
};

async function copyInto(from: string, to: string): Promise<void> {
  try { await stat(from); } catch { return; }
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true });
}

/** The admin's agent runtime leaves the service account: their harness transcripts and
    configuration are copied (never moved) from where the service keeps them into their own
    home, and their projects stay put. Sign-ins stay with the service; they're the node's. */
async function moveAdminRuntime(admin: RuntimeAccount): Promise<void> {
  for (const adapter of listDiscoveredHarnesses()) {
    if (!adapter.configuration) continue;
    const service = runInRuntime(serviceRuntime(), () => configuredRuntime(adapter.id, adapter.configuration!.defaults(os.homedir())));
    const own = runInRuntime(admin, () => configuredRuntime(adapter.id, adapter.configuration!.defaults(admin.home)));
    await copyInto(service.sessionPath, own.sessionPath);
    for (const entry of CONFIGURATION_ENTRIES[adapter.id] ?? []) await copyInto(path.join(service.configPath, entry), path.join(own.configPath, entry));
  }
  // An account's Claude runs with CLAUDE_CONFIG_DIR set, which keeps .claude.json in that folder.
  const claude = runInRuntime(serviceRuntime(), () => getSettings().claude.configPath);
  const serviceClaudeJson = path.resolve(claude) === path.join(os.homedir(), ".claude") ? path.join(os.homedir(), ".claude.json") : path.join(claude, ".claude.json");
  await copyInto(serviceClaudeJson, path.join(admin.home, ".claude", ".claude.json"));
}

export class MultiUserSetupError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

export async function enableMultiUser(): Promise<void> {
  if (multiUserEnabled()) return;
  const status = multiUserStatus();
  if (!status.ready) throw new MultiUserSetupError(409, "Install the multi-user helper and pass the self-test first");
  const adminUser = listLocalUsers().find((user) => user.role === "admin");
  if (!adminUser) throw new MultiUserSetupError(409, "This node has no admin");
  const { harnessSessionBusy, harnessSessions } = await import("./harness-sessions.js");
  if ([...harnessSessions.values()].some((shared) => harnessSessionBusy(shared))) throw new MultiUserSetupError(409, "Wait for running turns to finish");
  const db = settingsDatabase();
  save(db, "multiUser.enabled", "true");
  try {
    const admin = accountRuntime(adminUser.accountId, adminUser.username);
    admin.home = await ensureOsAccount(admin);
    await moveAdminRuntime(admin);
    await grantSharedRuntimeAccess();
    // Each project goes to its own runtime: the admin's, or its cluster's account.
    for (const project of await asNode(() => listProjects())) await grantExistingProject(project.id).catch((error) => console.warn(`Could not open ${project.name} to its runtime account`, error));
    const { runHelper } = await import("../account-runtime.js");
    await runHelper(["repair", admin.name!]);
  } catch (error) {
    save(db, "multiUser.enabled", "false");
    throw error;
  }
}

/** A new person gets their OS account; a deleted person's goes with them. */
export async function createAccountRuntime(accountId: string, username: string): Promise<void> {
  if (!multiUserEnabled()) return;
  await ensureOsAccount(accountRuntime(accountId, username));
}

export async function deleteAccountRuntime(accountId: string, username: string): Promise<void> {
  if (!multiUserEnabled()) return;
  const runtime = accountRuntime(accountId, username);
  if (runtime.name) await deleteOsAccount(runtime.name);
}
