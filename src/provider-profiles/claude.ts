import path from "node:path";
import { randomUUID } from "node:crypto";
import { currentRuntime, spawnInRuntime, runInRuntime, ensureOsAccount, type RuntimeAccount } from "../account-runtime.js";
import { runtimeForAccount } from "../project-runtime.js";
import { resolveDataDirectory } from "../data-directory.js";
import { getSettings } from "../settings.js";
import type { ProviderProfile } from "./store.js";

export function profileRuntime(profile: ProviderProfile): RuntimeAccount { return runtimeForAccount(profile.owner); }
function runtimeDirectory(runtime: RuntimeAccount): string {
  return runtime.name ? path.join(runtime.home, ".joint-bob") : resolveDataDirectory();
}
export function profileDirectory(profile: ProviderProfile): string {
  return path.join(runtimeDirectory(profileRuntime(profile)), "provider-profiles", profile.id);
}
export type ClaudeIdentity = { accountUuid: string; emailAddress: string; organizationUuid: string };
export type NativeClaudeCredential = { accessToken: string; refreshToken: string; expiresAt: number; scopes?: string[] };

// Private, bounded IPC. Neither secrets nor child error output enter argv or logs.
const script = `
const fs = require('node:fs/promises');
const path = require('node:path');
(async () => {
  let text = ''; for await (const chunk of process.stdin) text += chunk;
  const { action, directory, projects, identity } = JSON.parse(text);
  const credentials = path.join(directory, '.credentials.json');
  const configFile = path.join(directory, '.claude.json');
  async function read(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return {}; throw e; } }
  if (action === 'read') { process.stdout.write(JSON.stringify((await read(credentials)).claudeAiOauth || null)); return; }
  if (action === 'identity') {
    const value = (await read(configFile)).oauthAccount;
    process.stdout.write(JSON.stringify(value ? { accountUuid: value.accountUuid, emailAddress: value.emailAddress, organizationUuid: value.organizationUuid } : null)); return;
  }
  if (action === 'remove') { await fs.rm(credentials, { force: true }); await fs.rm(credentials + '.new', { force: true }); return; }
  if (action === 'destroy') { await fs.rm(directory, { recursive: true, force: true }); return; }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  if (projects) {
    await fs.mkdir(projects, { recursive: true, mode: 0o700 });
    const link = path.join(directory, 'projects');
    try { await fs.symlink(projects, link, 'dir'); }
    catch (e) { if (e.code !== 'EEXIST' || await fs.readlink(link) !== projects) throw e; }
  }
  const config = { hasCompletedOnboarding: true, theme: 'dark' };
  if (identity) config.oauthAccount = identity;
  await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  await fs.chmod(configFile, 0o600);
})().catch(() => { process.exitCode = 1; });
`;
async function ipc(runtime: RuntimeAccount, request: object): Promise<string> {
  if (runtime.name) await ensureOsAccount(runtime);
  const child = spawnInRuntime(runtime, process.execPath, ["-e", script], { cwd: runtime.home, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(request));
  let output = "";
  let oversized = false;
  child.stdout.on("data", chunk => { output += String(chunk); if (output.length > 64 * 1024) { oversized = true; output = ""; child.kill(); } });
  child.stderr.resume();
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000); timer.unref();
  return new Promise((resolve, reject) => {
    child.on("error", () => { clearTimeout(timer); reject(new Error("Claude profile storage unavailable")); });
    child.on("close", code => { clearTimeout(timer); code === 0 && !oversized ? resolve(output) : reject(new Error("Claude profile storage unavailable")); });
  });
}
export async function readLegacyClaudeCredential(profile: ProviderProfile): Promise<NativeClaudeCredential | null> {
  return JSON.parse(await ipc(profileRuntime(profile), { action: "read", directory: profileDirectory(profile) }));
}
export async function removeLegacyClaudeCredential(profile: ProviderProfile): Promise<void> {
  await ipc(profileRuntime(profile), { action: "remove", directory: profileDirectory(profile) });
}
export async function prepareClaudeProfile(profile: ProviderProfile, identity?: ClaudeIdentity): Promise<void> {
  await ipc(profileRuntime(profile), { action: "prepare", directory: profileDirectory(profile), identity });
}
export async function prepareClaudeExecution(profile: ProviderProfile): Promise<{ directory: string; dispose: () => Promise<void> }> {
  const runtime = currentRuntime();
  if (runtime.name) await ensureOsAccount(runtime);
  const identity = JSON.parse(await ipc(profileRuntime(profile), { action: "identity", directory: profileDirectory(profile) }));
  const directory = path.join(runtimeDirectory(runtime), "provider-profile-turns", randomUUID());
  const settings = runInRuntime(runtime, () => getSettings().claude);
  const projects = settings.sessionPath || path.join(settings.configPath || path.join(runtime.home, ".claude"), "projects");
  await ipc(runtime, { action: "prepare", directory, projects, identity });
  return { directory, dispose: async () => { await ipc(runtime, { action: "destroy", directory }); } };
}
export function claudeProfileEnvironment(environment: NodeJS.ProcessEnv, directory: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...environment, CLAUDE_CONFIG_DIR: directory };
  for (const name of ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"]) delete result[name];
  return result;
}
