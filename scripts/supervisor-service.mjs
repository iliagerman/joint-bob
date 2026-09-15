#!/usr/bin/env node
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { startSupervisor } from "./joint-bob-supervisor.mjs";
import { readInstallation, releaseAppSpec } from "./supervisor-release.mjs";

const [installRoot, dataDirectory] = process.argv.slice(2).map(value => path.resolve(value));
if (!installRoot || !dataDirectory) throw new Error("Usage: supervisor-service.mjs <install-root> <data-directory>");
mkdirSync(path.dirname(dataDirectory), { recursive: true });
try { if (lstatSync(dataDirectory).isSymbolicLink()) throw new Error("Data directory must not be a symlink"); } catch (error) { if (error.code !== "ENOENT") throw error; }
const canonicalInstallRoot = realpathSync(installRoot);
const saved = readInstallation(dataDirectory);
const savedInstallRoot = saved ? realpathSync(saved.installRoot) : null;
if (savedInstallRoot && savedInstallRoot !== canonicalInstallRoot) throw new Error("Supervisor installation root does not match service root");
const activeRelease = realpathSync(saved?.activeRelease ?? canonicalInstallRoot);
const installation = { installRoot: canonicalInstallRoot, activeRelease };
const runtime = await startSupervisor({ dataDirectory, app: releaseAppSpec(canonicalInstallRoot, activeRelease, dataDirectory), installation });
console.log(`Joint Bob supervisor started for ${activeRelease}`);
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; await runtime.close(); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
