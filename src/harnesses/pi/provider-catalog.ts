import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createPiResourceLoader } from "./resource-loader.js";

export interface PiProviderCatalog {
  refreshIfChanged(): Promise<void>;
  dispose(): void;
}

interface PiProviderCatalogOptions {
  agentDir: string;
  strictResourceIsolation: boolean;
  packagesFile?: string;
  extensionPaths: string[];
}

function readOptional(file: string): string {
  try { return readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}

function configurationSnapshot(options: PiProviderCatalogOptions): string {
  return [
    readOptional(path.join(options.agentDir, "settings.json")),
    options.packagesFile ? readOptional(options.packagesFile) : "",
    JSON.stringify(options.extensionPaths),
    String(options.strictResourceIsolation),
  ].join("\0");
}

export async function createPiProviderCatalog(modelRuntime: ModelRuntime, options: PiProviderCatalogOptions): Promise<PiProviderCatalog> {
  const { agentDir, strictResourceIsolation, packagesFile, extensionPaths } = options;
  const settingsManager = SettingsManager.create(agentDir, agentDir, { projectTrusted: false });
  const resourceLoader = createPiResourceLoader({ cwd: agentDir, agentDir, settingsManager, additionalExtensionPaths: extensionPaths }, strictResourceIsolation, packagesFile);
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: agentDir,
    agentDir,
    modelRuntime,
    sessionManager: SessionManager.inMemory(agentDir),
    settingsManager,
    resourceLoader,
    noTools: "all",
  });
  await session.bindExtensions({});
  await modelRuntime.getAvailable();
  let snapshot = configurationSnapshot(options);
  return {
    refreshIfChanged: async () => {
      const current = configurationSnapshot(options);
      if (current === snapshot) return;
      await session.reload();
      await modelRuntime.getAvailable();
      snapshot = current;
    },
    dispose: () => session.dispose(),
  };
}
