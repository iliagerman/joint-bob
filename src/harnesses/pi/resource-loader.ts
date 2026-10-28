import { readFileSync } from "node:fs";
import path from "node:path";
import { DefaultResourceLoader, SettingsManager } from "../../pi-sdk.js";

type LoaderOptions = ConstructorParameters<typeof DefaultResourceLoader>[0] & { agentDir: string };

export interface PiExtensionPackage {
  source: string;
  autoload?: boolean;
  extensions?: string[];
  skills: never[];
  prompts: never[];
  themes: never[];
}

function readOptional(file: string): string | undefined {
  try { return readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function installedPackages(settingsFile: string): unknown[] {
  const content = readOptional(settingsFile);
  if (content === undefined) return [];
  const settings: unknown = JSON.parse(content);
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) throw new Error("Pi settings must be an object");
  const packages = (settings as Record<string, unknown>).packages;
  if (packages === undefined) return [];
  if (!Array.isArray(packages)) throw new Error("Pi packages must be an array");
  return packages;
}

function extensionOnlyPackage(value: unknown): PiExtensionPackage {
  if (typeof value === "string") {
    if (!value) throw new Error("Pi package source must be a nonempty string");
    return { source: value, skills: [], prompts: [], themes: [] };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Pi package declaration must be a string or object");
  const declaration = value as Record<string, unknown>;
  if (typeof declaration.source !== "string" || !declaration.source) throw new Error("Pi package source must be a nonempty string");
  if (declaration.autoload !== undefined && typeof declaration.autoload !== "boolean") throw new Error("Pi package autoload must be a boolean");
  if (declaration.extensions !== undefined && (!Array.isArray(declaration.extensions) || declaration.extensions.some((item) => typeof item !== "string"))) throw new Error("Pi package extensions must be an array of strings");
  return {
    source: declaration.source,
    ...(declaration.autoload === undefined ? {} : { autoload: declaration.autoload }),
    ...(declaration.extensions === undefined ? {} : { extensions: declaration.extensions as string[] }),
    skills: [], prompts: [], themes: [],
  };
}

export function readInstalledPiPackages(settingsFile: string): PiExtensionPackage[] {
  return installedPackages(settingsFile).map(extensionOnlyPackage);
}

function globalResourceSettings(packagesFile: string | undefined, agentDir: string): string {
  const content = packagesFile ? readOptional(packagesFile) : undefined;
  const managed: unknown = content === undefined ? [] : JSON.parse(content).packages;
  if (!Array.isArray(managed)) throw new Error("Managed Pi packages must be an array");
  const installed = readInstalledPiPackages(path.join(agentDir, "settings.json"));
  return JSON.stringify({ packages: [...managed, ...installed], extensions: ["!**/*"], skills: ["!**/*"], prompts: ["!**/*"], themes: ["!**/*"] });
}

function configureCursorProviderPolicy(): void {
  process.env.PI_CURSOR_NATIVE_TOOLS = "0";
  process.env.PI_CURSOR_PI_TOOL_BRIDGE = "1";
  process.env.PI_CURSOR_SETTING_SOURCES = "none";
  process.env.PI_CURSOR_EXPOSE_BUILTIN_TOOLS = "1";
}

/** Suppress native discovery before extension factories or package installers run.
 * The loader's settings are read-only; session preferences and auth keep their native paths.
 * The project is untrusted, so Pi reads no `.pi/settings.json` or project packages. Only packages
 * explicitly installed in the personal settings are included, with skills/prompts/themes filtered out.
 */
export function createPiResourceLoader(options: LoaderOptions, strict: boolean, packagesFile?: string): DefaultResourceLoader {
  configureCursorProviderPolicy();
  if (!strict) return new DefaultResourceLoader(options);
  // Validate before SDK storage; it tolerates read errors by falling back to defaults.
  globalResourceSettings(packagesFile, options.agentDir);
  const settingsManager = SettingsManager.fromStorage({
    withLock(scope, read) {
      read(scope === "global" ? globalResourceSettings(packagesFile, options.agentDir) : undefined);
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
