import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, statfs } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { resolveDataDirectory } from "../data-directory.js";

// Laya runs on this machine's CPU or GPU in its own Python environment. It is installed only on
// request and only where it fits: the checkpoint and PyTorch need memory, cores and disk.
export const LAYA_MIN_MEMORY_BYTES = 8 * 2 ** 30;
export const LAYA_MIN_CORES = 4;
export const LAYA_MIN_FREE_DISK_BYTES = 10 * 2 ** 30;
const LAYA_PACKAGE = "laya[serve]==0.4.20";
const START_TIMEOUT_MS = 180_000;

const gigabytes = (bytes: number) => Math.round(bytes / 2 ** 30 * 10) / 10;
const runtimeDirectory = () => path.join(resolveDataDirectory(), "laya-runtime");
const venvBin = (name: string) => path.join(runtimeDirectory(), "venv", process.platform === "win32" ? "Scripts" : "bin", name);

/** The newest `python3` that is 3.10 or later, or null. */
function python(): string | null {
  for (const candidate of ["python3.13", "python3.12", "python3.11", "python3.10", "python3"]) {
    const result = spawnSync(candidate, ["-I", "-c", "import sys; print(sys.version_info[0] * 100 + sys.version_info[1])"], { encoding: "utf8" });
    if (result.status === 0 && Number(result.stdout.trim()) >= 310) return candidate;
  }
  return null;
}

/** Whether this machine can run Laya, and why not when it cannot. */
export function layaAllowed(memoryBytes: number, cores: number, freeDiskBytes: number, hasPython: boolean): { allowed: boolean; reason: string | null } {
  const missing = [
    memoryBytes < LAYA_MIN_MEMORY_BYTES ? `${gigabytes(LAYA_MIN_MEMORY_BYTES)} GB of memory (it has ${gigabytes(memoryBytes)} GB)` : "",
    cores < LAYA_MIN_CORES ? `${LAYA_MIN_CORES} cores (it has ${cores})` : "",
    freeDiskBytes < LAYA_MIN_FREE_DISK_BYTES ? `${gigabytes(LAYA_MIN_FREE_DISK_BYTES)} GB of free disk (it has ${gigabytes(freeDiskBytes)} GB)` : "",
    hasPython ? "" : "Python 3.10 or later",
  ].filter(Boolean);
  return missing.length
    ? { allowed: false, reason: `Laya needs ${missing.join(", ")}, so it is not offered on this machine. Use Laya on another machine instead.` }
    : { allowed: true, reason: null };
}

let installing: Promise<void> | undefined;
let installError: string | null = null;
let server: { child: ChildProcess; url: Promise<string> } | undefined;

export interface LayaStatus { allowed: boolean; reason: string | null; installed: boolean; installing: boolean; installError: string | null; running: boolean }

async function freeDisk(): Promise<number> {
  const stats = await statfs(resolveDataDirectory());
  return stats.bavail * stats.bsize;
}

export async function layaStatus(): Promise<LayaStatus> {
  const { allowed, reason } = layaAllowed(os.totalmem(), os.cpus().length, await freeDisk(), python() !== null);
  return { allowed, reason, installed: existsSync(venvBin("laya-serve")), installing: installing !== undefined, installError, running: server !== undefined };
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} stopped with code ${code}. ${stderr.trim().split("\n").at(-1) ?? ""}`)));
  });
}

/** Creates the Python environment and installs Laya into it. The Settings tab polls the status. */
export async function startLayaInstall(): Promise<void> {
  const status = await layaStatus();
  if (!status.allowed) throw Object.assign(new Error(status.reason!), { status: 409 });
  if (installing) return;
  installError = null;
  await mkdir(runtimeDirectory(), { recursive: true });
  const interpreter = python()!;
  installing = run(interpreter, ["-m", "venv", path.join(runtimeDirectory(), "venv")])
    .then(() => run(venvBin("python"), ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", LAYA_PACKAGE]))
    .catch((error: Error) => { installError = error.message; })
    .finally(() => { installing = undefined; });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

async function waitUntilServing(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Laya stopped while starting (code ${child.exitCode})`);
    try { if ((await fetch(`${url}/models`, { signal: AbortSignal.timeout(2_000) })).ok) return; } catch { /* Not listening yet. */ }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  child.kill();
  throw new Error("Laya did not start within three minutes");
}

/** The address of this machine's Laya server, starting it on first use. Only this machine can reach it. */
export async function localLayaUrl(): Promise<string> {
  if (server) return server.url;
  if (!existsSync(venvBin("laya-serve"))) throw new Error("Laya is not installed on this machine. Install it in Settings → Classifiers");
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(venvBin("laya-serve"), [], {
    env: {
      ...process.env, LAYA_HOST: "127.0.0.1", LAYA_PORT: String(port), LAYA_MODELS: "multilingual", LAYA_DEFAULT_MODEL: "multilingual",
      HF_HOME: path.join(resolveDataDirectory(), "laya-models"), LAYA_THREADS: String(Math.max(1, Math.floor(os.cpus().length / 2))),
    },
    stdio: "ignore",
  });
  const current = { child, url: waitUntilServing(url, child).then(() => url) };
  server = current;
  // A child is not ended with its parent; the server must not outlive Joint Bob.
  process.once("exit", () => child.kill());
  child.on("exit", () => { if (server === current) server = undefined; });
  current.url.catch(() => { if (server === current) server = undefined; });
  return current.url;
}
