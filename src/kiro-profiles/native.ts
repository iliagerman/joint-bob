import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { currentRuntime, grantProjectFolder, runtimeExec, spawnInRuntime } from "../account-runtime.js";
import { resolveDataDirectory } from "../data-directory.js";
import { configuredRuntime } from "../harnesses/runtime-configuration.js";
import { stopProcessGroup } from "../harnesses/process-lifecycle.js";
import { getSettings } from "../settings.js";
import { execFile } from "../subprocess.js";
import type { ProviderProfile } from "../provider-profiles/store.js";
import type { ProfileLoginStatus } from "../provider-profiles/login.js";
import { profileBusy } from "../provider-profiles/execution.js";

const execute = promisify(execFile);
const logins = new Map<string, { status: ProfileLoginStatus; child?: ChildProcessWithoutNullStreams }>();
const signingOut = new Set<string>();
export function kiroProfileAuthBusy(profile: ProviderProfile): boolean {
  return signingOut.has(profile.id) || logins.get(profile.id)?.status.state === "waiting";
}
export function kiroProfileDirectory(profile: ProviderProfile): string {
  if (profile.provider !== "kiro" || !profile.kiro) throw new Error("Expected Kiro IAM Identity Center profile");
  return path.join(resolveDataDirectory(), "kiro-profile-auth", profile.id);
}
export async function prepareKiroProfile(profile: ProviderProfile) {
  const runtime = currentRuntime();
  if (runtime.name && runtime.key !== profile.owner) throw new Error("A Kiro profile must run in its owner's account, not another account or cluster runtime");
  const root = kiroProfileDirectory(profile);
  const paths = { HOME: path.join(root, "home"), KIRO_HOME: path.join(root, "kiro"), KIRO_DATA_DIR: path.join(root, "data"),
    XDG_DATA_HOME: path.join(root, "xdg-data"), XDG_CONFIG_HOME: path.join(root, "xdg-config"), XDG_CACHE_HOME: path.join(root, "cache"), TMPDIR: path.join(root, "tmp") };
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const directory of Object.values(paths)) await mkdir(directory, { recursive: true, mode: 0o700 });
  await grantProjectFolder(currentRuntime(), root);
  return paths;
}
export function kiroProfileEnvironment(inherited: NodeJS.ProcessEnv, paths: Awaited<ReturnType<typeof prepareKiroProfile>>): NodeJS.ProcessEnv {
  const { KIRO_API_KEY: _apiKey, KIRO_TEST_DB_PATH: _testDatabase, ...environment } = inherited;
  return { ...environment, ...paths, BROWSER: "true", KIRO_NO_AUTO_UPDATE: "1" };
}
export async function kiroProfileLaunch(profile: ProviderProfile, inherited: NodeJS.ProcessEnv, args: string[]) {
  if (!getSettings().kiroEnabled) throw new Error("Kiro is disabled on this node");
  const paths = await prepareKiroProfile(profile);
  const executable = configuredRuntime("kiro", getSettings().runtimes.kiro).executable || "kiro-cli";
  // The OS-account helper deliberately sets HOME. Override it inside that account,
  // not outside the machine wall; no authentication values are command arguments.
  return { command: "/usr/bin/env", args: [...Object.entries(paths).map(([key, value]) => `${key}=${value}`), executable, ...args],
    env: kiroProfileEnvironment(inherited, paths), paths };
}
async function run(profile: ProviderProfile, args: string[]): Promise<void> {
  const launch = await kiroProfileLaunch(profile, process.env, args);
  const wrapped = runtimeExec(launch.command, launch.args, launch.env);
  await execute(wrapped.command, wrapped.args, { env: wrapped.env, timeout: 10_000, maxBuffer: 16_384 });
}
export async function kiroProfileLoginState(profile: ProviderProfile): Promise<{ signedIn: boolean; message: string }> {
  if (!getSettings().kiroEnabled) return { signedIn: false, message: "Kiro is disabled on this node" };
  try {
    await run(profile, ["whoami", "--format", "json"]);
    return { signedIn: true, message: "Kiro IAM Identity Center is signed in on this node" };
  } catch (error) {
    if ((error as { code: unknown }).code === 1) return { signedIn: false, message: "Sign in on this node" };
    throw new Error("Kiro profile status unavailable on this node");
  }
}
export function kiroProfileLoginStatus(profile: ProviderProfile): ProfileLoginStatus | undefined {
  const login = logins.get(profile.id);
  return login ? structuredClone(login.status) : undefined;
}
function readDeviceUrl(text: string): string | undefined {
  for (const match of text.matchAll(/https:\/\/[^\s<>"'\x1b]+/g)) {
    if (!URL.canParse(match[0])) continue;
    const url = new URL(match[0]);
    if (!(url.hostname.endsWith(".amazonaws.com") || url.hostname.endsWith(".awsapps.com") || url.hostname.endsWith(".signin.aws"))) continue;
    if (url.username || url.password || [...url.searchParams.keys()].some((key) => key !== "user_code")) continue;
    if (url.hash && !/^#\/device(?:\?user_code=[A-Z0-9-]+)?$/i.test(url.hash)) continue;
    if (url.href.includes("device") || url.searchParams.has("user_code")) return url.href;
  }
  return undefined;
}
export async function startKiroProfileLogin(profile: ProviderProfile): Promise<ProfileLoginStatus> {
  if (profileBusy(profile.id)) throw new Error("This Kiro profile is busy. Wait for its current turn to finish.");
  if (kiroProfileAuthBusy(profile)) throw new Error("Kiro authentication is already in progress");
  const login: { status: ProfileLoginStatus; child?: ChildProcessWithoutNullStreams } = { status: { state: "waiting", message: "Preparing Kiro IAM Identity Center sign-in" } };
  logins.set(profile.id, login);
  let launch: Awaited<ReturnType<typeof kiroProfileLaunch>>;
  try {
    launch = await kiroProfileLaunch(profile, process.env, ["login", "--license", "pro", "--identity-provider", profile.kiro!.startUrl,
      "--region", profile.kiro!.region, "--use-device-flow"]);
  } catch {
    login.status = { state: "failed", message: "Kiro sign-in could not start on this node" };
    return structuredClone(login.status);
  }
  if (login.status.state !== "waiting") return structuredClone(login.status);
  const child = spawnInRuntime(currentRuntime(), launch.command, launch.args, { cwd: launch.paths.HOME, env: launch.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  login.child = child;
  child.stdin.end();
  let output = "";
  const receive = (chunk: Buffer) => {
    if (login.status.state !== "waiting") return;
    output = (output + chunk.toString()).slice(-8192);
    const url = readDeviceUrl(output);
    const code = output.match(/(?:user[_ ]code|device code|confirmation code|\bcode)\s*[:=]\s*([A-Z0-9]{4}-[A-Z0-9]{4})\b/i)?.[1];
    if (code) login.status.deviceCode = code.toUpperCase();
    if (url) { login.status.url = url; login.status.message = "Open the AWS sign-in page, complete sign-in, then return here"; }
  };
  child.stdout.on("data", receive); child.stderr.on("data", receive);
  const timeout = setTimeout(() => {
    login.status = { state: "failed", message: "Kiro sign-in timed out. Start again." };
    void stopProcessGroup(child, "Kiro profile sign-in").catch(() => { login.status.message = "Kiro sign-in did not stop. Restart the node before trying again."; });
  }, 15 * 60_000);
  timeout.unref();
  child.once("error", () => { clearTimeout(timeout); login.status = { state: "failed", message: "Kiro sign-in could not start on this node" }; });
  child.once("close", (code) => {
    clearTimeout(timeout);
    if (login.status.state !== "waiting") return;
    login.status = code === 0 ? { state: "complete", message: "Kiro signed in on this node" } : { state: "failed", message: "Kiro sign-in failed on this node. Start again." };
  });
  return structuredClone(login.status);
}
export async function cancelKiroProfileLogin(profile: ProviderProfile): Promise<void> {
  const login = logins.get(profile.id);
  if (!login || login.status.state !== "waiting") throw new Error("No Kiro sign-in is in progress");
  login.status = { state: "cancelled", message: "Kiro sign-in cancelled" };
  if (login.child) await stopProcessGroup(login.child, "Kiro profile sign-in");
}
export async function logoutKiroProfile(profile: ProviderProfile): Promise<void> {
  if (profileBusy(profile.id)) throw new Error("This Kiro profile is busy. Wait for its current turn to finish.");
  if (kiroProfileAuthBusy(profile)) throw new Error("Kiro authentication is already in progress");
  signingOut.add(profile.id);
  try { await run(profile, ["logout"]); logins.delete(profile.id); }
  catch { throw new Error("Could not sign out of this Kiro profile on this node"); }
  finally { signingOut.delete(profile.id); }
}
