import { accessSync, constants as fsConstants } from "node:fs";
import path from "node:path";
import { value } from "../settings-store.js";
function runtimeOverrides(id) {
  return { executable: value(`${id}.executable`), configPath: value(`${id}.configPath`), sessionPath: value(`${id}.sessionPath`) };
}
function configuredRuntime(id, defaults) {
  const overrides = runtimeOverrides(id);
  return {
    executable: overrides.executable || defaults.executable,
    configPath: overrides.configPath || defaults.configPath,
    sessionPath: overrides.sessionPath || defaults.sessionPath
  };
}
const DETECT_TTL_MS = 3e4;
const detected = /* @__PURE__ */ new Map();
function detectExecutable(command) {
  const key = `${command}
${process.env.PATH ?? ""}`;
  const cached = detected.get(key);
  if (cached && Date.now() - cached.at < DETECT_TTL_MS) return cached.executable;
  let executable = command;
  for (const directory of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      executable = candidate;
      break;
    } catch (error) {
      if (!["EACCES", "ENOENT", "ENOTDIR"].includes(error.code ?? "")) throw error;
    }
  }
  detected.set(key, { executable, at: Date.now() });
  return executable;
}
function localizeTranscript(sessionPath, homePath, root, prefix, label) {
  const sourcePath = (prefix ? sessionPath.slice(prefix.length) : sessionPath).replace(/\\/g, "/");
  const segments = sourcePath.split("/");
  const rootIndex = segments.lastIndexOf(root);
  if (rootIndex === -1) throw new Error(`${label} conversation path is outside the synchronized ${root} root`);
  const suffix = segments.slice(rootIndex + 1);
  if (!suffix.length) throw new Error(`${label} conversation path has no session file`);
  if (suffix.some((segment) => !segment || segment === "." || segment === "..")) throw new Error(`${label} conversation path has an invalid session segment`);
  return prefix + path.join(path.resolve(homePath), root, ...suffix);
}
export {
  configuredRuntime,
  detectExecutable,
  localizeTranscript,
  runtimeOverrides
};
