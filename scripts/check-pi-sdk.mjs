#!/usr/bin/env node
// Checks that a freshly installed Pi harness can run Joint Bob's Pi conversations before it
// replaces the working one: it loads, offers models and opens an agent session.
// Usage: check-pi-sdk.mjs <node_modules of the staged Pi install>
// Runs in its own temporary agent folder, so no real setting, sign-in or session is touched.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The values src/pi-sdk.ts takes from Pi.
const REQUIRED = ["createAgentSession", "createBashTool", "getAgentDir", "loadSkills", "migrateSessionEntries", "readStoredCredential",
  "DefaultPackageManager", "DefaultResourceLoader", "ModelRuntime", "SessionManager", "SettingsManager"];

const [nodeModules] = process.argv.slice(2);
if (!nodeModules) throw new Error("Usage: check-pi-sdk.mjs <node_modules>");
const packageDir = path.join(path.resolve(nodeModules), "@earendil-works", "pi-coding-agent");
const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
const agentDir = mkdtempSync(path.join(os.tmpdir(), "joint-bob-pi-check-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
try {
  const sdk = await import(pathToFileURL(path.join(packageDir, manifest.exports["."].import)).href);
  const missing = REQUIRED.filter((name) => typeof sdk[name] !== "function");
  if (missing.length) throw new Error(`Pi ${manifest.version} no longer provides ${missing.join(", ")}`);
  const credentials = { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} };
  const modelRuntime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false });
  if (!modelRuntime.getModels().length) throw new Error(`Pi ${manifest.version} offers no models`);
  const { session } = await sdk.createAgentSession({
    cwd: agentDir, agentDir, modelRuntime, noTools: "all",
    sessionManager: sdk.SessionManager.inMemory(agentDir),
    settingsManager: sdk.SettingsManager.inMemory(),
  });
  session.dispose();
  process.stdout.write(`Pi ${manifest.version} passed Joint Bob's check\n`);
} finally {
  rmSync(agentDir, { recursive: true, force: true });
}
