#!/usr/bin/env node
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [appRoot, stateDir] = process.argv.slice(2);
if (!appRoot || !stateDir || !path.isAbsolute(appRoot) || !path.isAbsolute(stateDir)) {
  throw new Error("Usage: install-pi-runtime ABSOLUTE_APP_ROOT ABSOLUTE_STATE_DIR");
}
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const settingsPath = path.join(agentDir, "settings.json");
let settings = {};
try { settings = JSON.parse(readFileSync(settingsPath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Pi settings must be an object");
if (settings.extensions !== undefined && (!Array.isArray(settings.extensions) || settings.extensions.some((entry) => typeof entry !== "string"))) {
  throw new Error("Pi settings extensions must be an array of strings");
}
// Machine-specific import paths must not enter the synchronized extensions folder.
const extensionPath = path.join(stateDir, "pi-runtime-extension.ts");
const moduleUrl = pathToFileURL(path.join(appRoot, "dist", "pi-runtime-extension.js")).href;
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
writeFileSync(extensionPath, `import { createPiRuntimeExtension } from ${JSON.stringify(moduleUrl)};\nexport default createPiRuntimeExtension(${JSON.stringify(stateDir)});\n`, { mode: 0o600 });
settings.extensions = [...new Set([...(settings.extensions ?? []), extensionPath])];
mkdirSync(agentDir, { recursive: true, mode: 0o700 });
const temporary = `${settingsPath}.${process.pid}.tmp`;
writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
renameSync(temporary, settingsPath);
