import { readdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { isHarnessId, type SessionSummary } from "../types.js";
import { confinedToRuntime, currentRuntime } from "../account-runtime.js";
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
  if (value.runtime !== undefined && typeof value.models !== "function") return false;
  if (value.order !== undefined && (typeof value.order !== "number" || !Number.isFinite(value.order))) return false;
  if (!isRecord(value.paths) || typeof value.paths.newSession !== "string" || !value.paths.newSession.trim()) return false;
  if (typeof value.paths.ownsSession !== "function" || typeof value.paths.ownsTranscript !== "function" || typeof value.paths.sessionId !== "function") return false;
  if (!isRecord(value.sync) || typeof value.sync.transcriptRoot !== "function") return false;
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

/** Reading a project's transcripts reads them where its agents write them: the project's
    runtime account's home in multi-user mode. Loaded late, as it depends on the store. */
function inProjectRuntime(adapter: HarnessAdapter): HarnessAdapter {
  const run = async <T>(projectId: string, work: () => Promise<T>): Promise<T> => (await import("../project-runtime.js")).withProjectRuntime(projectId, work);
  const sessions = adapter.sessions;
  // A transcript the server reads for a person must really be in their home (see confinedToRuntime).
  const confinedFile = (file: string) => confinedToRuntime(currentRuntime(), file);
  const confinedSession = (sessionPath: string) => {
    let file: string | undefined;
    try { file = adapter.paths.transcriptFile?.(sessionPath); } catch { return true; }
    return !file || confinedFile(file);
  };
  const confinedSummary = (session: SessionSummary) => confinedSession(session.path) && (session.segments ?? []).every((segment) => confinedSession(segment.path));
  return {
    ...adapter,
    sessions: {
      ...sessions,
      files: (project) => run(project.id, async () => (await sessions.files(project)).filter(confinedFile)),
      list: (project) => run(project.id, async () => (await sessions.list(project)).filter(confinedSummary)),
      refresh: (project, previous, changedFiles) => run(project.id, async () => (await sessions.refresh(project, previous, changedFiles.filter(confinedFile))).filter(confinedSummary)),
      loadMessages: (project, sessionPath) => run(project.id, () => {
        if (!confinedSession(sessionPath)) throw new Error("Conversation transcript is outside its owner's home");
        return sessions.loadMessages(project, sessionPath);
      }),
    },
  };
}

const builtInAdapters = (await discoverHarnesses(path.dirname(fileURLToPath(import.meta.url)))).map(inProjectRuntime);

export function listDiscoveredHarnesses(): HarnessAdapter[] {
  return [...builtInAdapters];
}
