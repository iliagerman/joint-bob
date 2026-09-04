import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { isHarnessId } from "../types.js";
import type { HarnessAdapter } from "./contract.js";

type UnknownRecord = Record<string, unknown>;

interface DiscoveredHarness {
  adapter: HarnessAdapter;
  fileName: string;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null;
}

function isHarnessAdapter(value: unknown): value is HarnessAdapter {
  if (!isRecord(value) || !isHarnessId(value.id) || typeof value.label !== "string" || !value.label.trim()) return false;
  if (value.order !== undefined && (typeof value.order !== "number" || !Number.isFinite(value.order))) return false;
  if (!isRecord(value.paths) || typeof value.paths.newSession !== "string" || !value.paths.newSession.trim()) return false;
  if (typeof value.paths.ownsSession !== "function" || typeof value.paths.ownsTranscript !== "function") return false;
  if (!isRecord(value.sessions)) return false;
  return [value.sessions.files, value.sessions.list, value.sessions.refresh, value.sessions.loadMessages].every((callback) => typeof callback === "function");
}

function isHarnessFile(name: string): boolean {
  return (name.endsWith(".harness.ts") || name.endsWith(".harness.js")) && !name.endsWith(".d.ts");
}

export async function discoverHarnesses(directory: string): Promise<HarnessAdapter[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const fileNames = entries.filter((entry) => entry.isFile() && isHarnessFile(entry.name)).map((entry) => entry.name).sort();
  const discovered = await Promise.all(fileNames.map(async (fileName): Promise<DiscoveredHarness> => {
    const filePath = path.join(directory, fileName);
    let module: { default?: unknown };
    try {
      module = await import(pathToFileURL(filePath).href);
    } catch (error) {
      throw new Error(`Malformed harness module: ${filePath}`, { cause: error });
    }
    if (!isHarnessAdapter(module.default)) throw new Error(`Malformed harness module: ${filePath}`);
    return { adapter: module.default, fileName };
  }));
  const ids = new Set<string>();
  for (const { adapter } of discovered) {
    if (ids.has(adapter.id)) throw new Error(`Duplicate harness ID: ${adapter.id}`);
    ids.add(adapter.id);
  }
  return discovered
    .sort((left, right) => (left.adapter.order ?? Infinity) - (right.adapter.order ?? Infinity) || left.fileName.localeCompare(right.fileName))
    .map(({ adapter }) => adapter);
}

export function resolveHarnessForSessionPath(adapters: readonly HarnessAdapter[], sessionPath: string): HarnessAdapter {
  const matches = adapters.filter((candidate) => candidate.paths.ownsSession(sessionPath));
  if (!matches.length) throw new Error(`No harness owns session path: ${sessionPath}`);
  if (matches.length > 1) throw new Error(`Multiple harnesses own session path: ${sessionPath}`);
  return matches[0];
}

const builtInAdapters = await discoverHarnesses(path.dirname(fileURLToPath(import.meta.url)));

export function listDiscoveredHarnesses(): HarnessAdapter[] {
  return [...builtInAdapters];
}
