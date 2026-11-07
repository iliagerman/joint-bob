import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { z } from "zod";
import { resolveDataDirectory } from "./data-directory.js";
import { execFile } from "./subprocess.js";

const execute = promisify(execFile);
const RELEASES = "https://prod.download.cli.kiro.dev/stable/";
const TIMEOUT = 10 * 60_000;
const manifestSchema = z.object({
  version: z.string().regex(/^3\.\d+\.\d+$/, "Kiro CLI version 3 is required"),
  packages: z.array(z.object({ download: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })),
});

export function managedKiroExecutable(): string {
  return path.join(resolveDataDirectory(), "harnesses", "kiro", "bin", "kiro-cli");
}

export function kiroRelease(input: unknown, platform: NodeJS.Platform = process.platform, arch: string = process.arch) {
  if (!["darwin", "linux"].includes(platform) || !["arm64", "x64"].includes(arch)) throw new Error(`Unsupported Kiro platform: ${platform}/${arch}`);
  const manifest = manifestSchema.parse(input);
  // Static musl packages work on both supported Ubuntu architectures without a host glibc dependency.
  const filename = platform === "darwin" ? "kirocli-universal-darwin.tar.gz" : `kirocli-${arch === "arm64" ? "aarch64" : "x86_64"}-linux-musl.tar.gz`;
  const download = `${manifest.version}/${filename}`;
  const selected = manifest.packages.find(item => item.download === download);
  if (!selected) throw new Error(`Kiro release has no package for ${platform}/${arch}`);
  return { ...selected, version: manifest.version };
}

async function downloadPackage(release: ReturnType<typeof kiroRelease>, destination: string): Promise<void> {
  const response = await fetch(new URL(release.download, RELEASES), { signal: AbortSignal.timeout(TIMEOUT) });
  if (!response.ok || !response.body) throw new Error(`Kiro download failed: HTTP ${response.status}`);
  const hash = createHash("sha256");
  const digest = new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(null, chunk); } });
  await pipeline(response.body, digest, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
  if (hash.digest("hex") !== release.sha256) throw new Error("Kiro download checksum mismatch; previous installation was not changed");
}

async function verifyInstall(staging: string, version: string): Promise<void> {
  const executable = path.join(staging, "bin", "kiro-cli");
  const info = await lstat(executable);
  if (!info.isFile() || !(info.mode & 0o111)) throw new Error("Kiro package has no executable binary");
  const home = path.join(staging, "verification-home");
  await mkdir(home);
  // Verification must never inherit the person's credentials or start interactive setup.
  const env = { PATH: process.env.PATH, HOME: home, KIRO_HOME: home, KIRO_NO_AUTO_UPDATE: "1" };
  const { stdout } = await execute(executable, ["--version"], { env, timeout: 15_000 });
  if (stdout.trim() !== `kiro-cli ${version}`) throw new Error(`Kiro package version does not match ${version}`);
  await execute(executable, ["acp", "--agent-engine=v3", "--help"], { env, timeout: 15_000 });
  await rm(home, { recursive: true });
}

/** Installs only the native binaries. The vendor installer edits shell profiles and may open a desktop app. */
export async function installManagedKiro(): Promise<void> {
  const response = await fetch(new URL("latest/manifest.json", RELEASES), { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Kiro release lookup failed: HTTP ${response.status}`);
  const release = kiroRelease(await response.json());
  const root = path.dirname(path.dirname(managedKiroExecutable()));
  await mkdir(path.dirname(root), { recursive: true });
  const staging = await mkdtemp(`${root}-staging-`);
  const backup = `${staging}-previous`;
  try {
    const archive = path.join(staging, "release.tar.gz");
    await downloadPackage(release, archive);
    await execute("tar", ["-xzf", archive, "-C", staging, "kirocli/bin"], { timeout: TIMEOUT });
    await rename(path.join(staging, "kirocli/bin"), path.join(staging, "bin"));
    await rm(path.join(staging, "kirocli"), { recursive: true });
    await rm(archive);
    await verifyInstall(staging, release.version);
    const hadPrevious = existsSync(root);
    if (hadPrevious) await rename(root, backup);
    try { await rename(staging, root); }
    catch (error) { if (hadPrevious) await rename(backup, root); throw error; }
    if (hadPrevious) await rm(backup, { recursive: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
