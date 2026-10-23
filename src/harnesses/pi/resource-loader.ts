import { readFileSync } from "node:fs";
import path from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0] & { agentDir: string };

function readOptional(file: string): string | undefined {
  try { return readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function globalResourceSettings(packagesFile?: string): string {
  const content = packagesFile ? readOptional(packagesFile) : undefined;
  const packages: unknown = content === undefined ? [] : JSON.parse(content).packages;
  if (!Array.isArray(packages)) throw new Error("Managed Pi packages must be an array");
  return JSON.stringify({ packages, extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"] });
}

/** Suppress native discovery before extension factories or package installers run.
 * The loader's settings are read-only; session preferences and auth keep their native paths.
 * The project is untrusted, so Pi reads no `.pi/settings.json`, installs none of its packages and
 * discovers no `.pi/*` or parent `.agents/skills`; the app passes the project's skills and prompts in.
 */
export function createPiResourceLoader(options: LoaderOptions, strict: boolean, packagesFile?: string): DefaultResourceLoader {
  if (!strict) return new DefaultResourceLoader(options);
  // Parse before SDK storage: it tolerates read errors by falling back to defaults.
  const globalSettings = globalResourceSettings(packagesFile);
  const settingsManager = SettingsManager.fromStorage({
    withLock(scope, read) {
      read(scope === "global" ? globalSettings : undefined);
    },
  }, { projectTrusted: false });
  return new DefaultResourceLoader({
    ...options,
    settingsManager,
    systemPrompt: "",
    appendSystemPrompt: [],
    systemPromptOverride: () => readOptional(path.join(options.cwd, ".pi/SYSTEM.md")),
    appendSystemPromptOverride: () => {
      const content = readOptional(path.join(options.cwd, ".pi/APPEND_SYSTEM.md"));
      return content === undefined ? [] : [content];
    },
    // Pi would read AGENTS.md and CLAUDE.md from the agent folder and every parent of the project.
    // None of those load: the app's instruction files, the project's own included, are the only ones.
    agentsFilesOverride: () => options.agentsFilesOverride ? options.agentsFilesOverride({ agentsFiles: [] }) : { agentsFiles: [] },
  });
}
