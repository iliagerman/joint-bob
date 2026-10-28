import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { cp, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type * as Pi from "@earendil-works/pi-coding-agent";
import { resolveDataDirectory } from "./data-directory.js";

/**
 * Pi conversations run on the app-managed Pi harness (`<data>/harnesses/pi`), which the daily
 * harness update keeps current without a Joint Bob release. Each version runs from its own
 * frozen copy under `<data>/pi-sdk/<version>`: Pi loads parts of itself on first use, so running
 * straight from the harness folder would mix two versions once the next update replaces it.
 * A missing or broken harness falls back to the Pi bundled with this release, and says why.
 */
/** `harnessVersion` is what the managed harness held when this process started, loaded or not. */
export interface PiSdkStatus { source: "harness" | "built-in"; version: string; reason: string | null; harnessVersion: string | null }
type PiModule = typeof Pi;
interface LoadedPiSdk { sdk: PiModule; status: PiSdkStatus; entry: string | null }

const PACKAGE = path.join("@earendil-works", "pi-coding-agent");
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export function managedPiNodeModules(dataDir: string): string {
  return path.join(dataDir, "harnesses", "pi", "node_modules");
}

/** The version and entry file of an installed Pi package; throws when the folder holds none. */
export async function readPiPackage(nodeModules: string): Promise<{ version: string; entry: string }> {
  const manifest = JSON.parse(await readFile(path.join(nodeModules, PACKAGE, "package.json"), "utf8")) as { name?: unknown; version?: unknown; exports?: Record<string, { import?: unknown }> };
  const entry = manifest.exports?.["."]?.import;
  if (manifest.name !== "@earendil-works/pi-coding-agent" || typeof manifest.version !== "string" || !VERSION_PATTERN.test(manifest.version) || typeof entry !== "string") {
    throw new Error("The folder does not hold a Pi package");
  }
  return { version: manifest.version, entry: path.join(nodeModules, PACKAGE, entry) };
}

async function exists(target: string): Promise<boolean> {
  try { await stat(target); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

/** The harness's packages copied once per version. Copies of other versions are removed. */
async function frozenCopy(dataDir: string, version: string): Promise<string> {
  const base = path.join(dataDir, "pi-sdk");
  const target = path.join(base, version);
  await mkdir(base, { recursive: true });
  for (const name of await readdir(base)) if (name !== version) await rm(path.join(base, name), { recursive: true, force: true });
  if (await exists(target)) return path.join(target, "node_modules");
  const staging = path.join(base, `.${version}.${randomUUID()}`);
  try {
    await cp(managedPiNodeModules(dataDir), path.join(staging, "node_modules"), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    await rename(staging, target);
  } finally { await rm(staging, { recursive: true, force: true }); }
  return path.join(target, "node_modules");
}

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0].slice(0, 300);
}

async function builtIn(reason: string, harnessVersion: string | null): Promise<LoadedPiSdk> {
  const sdk = await import("@earendil-works/pi-coding-agent");
  console.warn(`Pi conversations use Joint Bob's built-in Pi ${sdk.VERSION}: ${reason}`);
  return { sdk, status: { source: "built-in", version: sdk.VERSION, reason, harnessVersion }, entry: null };
}

/** A worker never looks for a harness: it runs the copy its server chose, or the built-in Pi
    when the server does, so both sides of a conversation run the same Pi. */
export async function loadPiSdk(dataDir: string, worker?: { entry: string | undefined }): Promise<LoadedPiSdk> {
  if (worker) {
    if (!worker.entry) {
      const sdk = await import("@earendil-works/pi-coding-agent");
      return { sdk, status: { source: "built-in", version: sdk.VERSION, reason: "the server runs the built-in Pi", harnessVersion: null }, entry: null };
    }
    try {
      const sdk = await import(pathToFileURL(worker.entry).href) as PiModule;
      return { sdk, status: { source: "harness", version: sdk.VERSION, reason: null, harnessVersion: sdk.VERSION }, entry: worker.entry };
    } catch (error) { return builtIn(`the server's Pi copy could not load in this worker: ${reasonOf(error)}`, null); }
  }
  let installed: { version: string; entry: string };
  try { installed = await readPiPackage(managedPiNodeModules(dataDir)); }
  catch (error) {
    return builtIn((error as NodeJS.ErrnoException).code === "ENOENT" ? "the managed Pi harness is not installed yet" : `the managed Pi harness is unreadable: ${reasonOf(error)}`, null);
  }
  try {
    const copy = await frozenCopy(dataDir, installed.version);
    const entry = path.join(copy, path.relative(managedPiNodeModules(dataDir), installed.entry));
    const sdk = await import(pathToFileURL(entry).href) as PiModule;
    return { sdk, status: { source: "harness", version: installed.version, reason: null, harnessVersion: installed.version }, entry };
  } catch (error) { return builtIn(`Pi ${installed.version} from the managed harness could not load: ${reasonOf(error)}`, installed.version); }
}

const loaded = await loadPiSdk(resolveDataDirectory(), process.env.JOINT_BOB_PI_WORKER === "1" ? { entry: process.env.JOINT_BOB_PI_SDK_ENTRY } : undefined);
export const piSdkStatus: PiSdkStatus = loaded.status;
/** Passed to this server's Pi workers so they run the same copy. */
export const piSdkEntry: string | null = loaded.entry;

const sdk = loaded.sdk;
export const createAgentSession = sdk.createAgentSession;
export const createBashTool = sdk.createBashTool;
export const getAgentDir = sdk.getAgentDir;
export const loadSkills = sdk.loadSkills;
export const migrateSessionEntries = sdk.migrateSessionEntries;
export const readStoredCredential = sdk.readStoredCredential;
export const DefaultPackageManager = sdk.DefaultPackageManager;
export type DefaultPackageManager = Pi.DefaultPackageManager;
export const DefaultResourceLoader = sdk.DefaultResourceLoader;
export type DefaultResourceLoader = Pi.DefaultResourceLoader;
export const ModelRuntime = sdk.ModelRuntime;
export type ModelRuntime = Pi.ModelRuntime;
export const SessionManager = sdk.SessionManager;
export type SessionManager = Pi.SessionManager;
export const SettingsManager = sdk.SettingsManager;
export type SettingsManager = Pi.SettingsManager;
