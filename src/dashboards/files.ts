import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveDataDirectory } from "../data-directory.js";
import { dashboardManifestSchema, type DashboardManifest, type DashboardPayload } from "./contract.js";

/**
 * A dashboard's files on this node, outside every project folder:
 *   draft/              what the creator agent is editing
 *   versions/<digest>/  saved definitions; `current` names the live one
 *   payload.json        the last successful refresh
 *   run.log             the last refresh's output
 *   state/              the refresh script's own storage between runs
 * A definition is every file in its folder: manifest.json, index.html and any script files.
 */
const MAX_FILES = 50;
const MAX_BYTES = 4 * 1024 * 1024;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const segmentPattern = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

export interface DefinitionFile { path: string; content: Buffer }
export interface LiveDefinition { digest: string; manifest: DashboardManifest; html: string; files: DefinitionFile[]; directory: string }

export function dashboardRoot(id: string): string {
  if (!idPattern.test(id)) throw new Error("Invalid dashboard id");
  return path.join(resolveDataDirectory(), "dashboards", id);
}

const draftPath = (id: string) => path.join(dashboardRoot(id), "draft");
const versionPath = (id: string, digest: string) => path.join(dashboardRoot(id), "versions", digest);

function assertRelativePath(relative: string): void {
  const segments = relative.split("/");
  if (!segments.every((segment) => segmentPattern.test(segment))) throw new Error(`Invalid definition file path: ${relative}`);
}

function readFolder(directory: string, prefix = ""): DefinitionFile[] {
  const files: DefinitionFile[] = [];
  for (const name of readdirSync(directory).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    assertRelativePath(relative);
    const absolute = path.join(directory, name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Definition files cannot be links: ${relative}`);
    if (stat.isDirectory()) files.push(...readFolder(absolute, relative));
    else if (stat.isFile()) files.push({ path: relative, content: readFileSync(absolute) });
    else throw new Error(`Definition files must be regular files: ${relative}`);
  }
  return files;
}

function digestOf(files: DefinitionFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(`${file.path}\0${file.content.length}\0`);
    hash.update(file.content);
  }
  return hash.digest("hex");
}

/** Validates a complete definition and returns its manifest. */
function checkDefinition(files: DefinitionFile[]): DashboardManifest {
  if (files.length > MAX_FILES) throw new Error(`A dashboard can have at most ${MAX_FILES} files`);
  if (files.reduce((total, file) => total + file.content.length, 0) > MAX_BYTES) throw new Error("The dashboard definition is too large (4 MiB at most)");
  for (const file of files) assertRelativePath(file.path);
  const manifestFile = files.find((file) => file.path === "manifest.json");
  if (!manifestFile) throw new Error("The dashboard needs a manifest.json");
  if (!files.some((file) => file.path === "index.html")) throw new Error("The dashboard needs an index.html");
  let manifest: unknown;
  try { manifest = JSON.parse(manifestFile.content.toString("utf8")); }
  catch { throw new Error("manifest.json is not valid JSON"); }
  const parsed = dashboardManifestSchema.safeParse(manifest);
  if (!parsed.success) throw new Error(`Invalid dashboard manifest: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "manifest"} ${issue.message}`).join("; ")}`);
  return parsed.data;
}

/** Writes a version folder whole, then points `current` at it; a reader never sees half of one. */
function installVersion(id: string, files: DefinitionFile[]): { digest: string; manifest: DashboardManifest } {
  const manifest = checkDefinition(files);
  const digest = digestOf(files);
  const root = dashboardRoot(id);
  const target = versionPath(id, digest);
  if (!existsSync(target)) {
    mkdirSync(path.join(root, "versions"), { recursive: true, mode: 0o700 });
    const staging = mkdtempSync(path.join(root, "versions", ".staging-"));
    for (const file of files) {
      mkdirSync(path.dirname(path.join(staging, file.path)), { recursive: true });
      writeFileSync(path.join(staging, file.path), file.content);
    }
    renameSync(staging, target);
  }
  const previous = currentDigest(id);
  const pointer = path.join(root, `.current-${process.pid}-${Date.now()}`);
  writeFileSync(pointer, digest);
  renameSync(pointer, path.join(root, "current"));
  // The previous version stays one generation, for a refresh that started before the save.
  for (const name of readdirSync(path.join(root, "versions"))) {
    if (name !== digest && name !== previous) rmSync(path.join(root, "versions", name), { recursive: true, force: true });
  }
  return { digest, manifest };
}

function currentDigest(id: string): string | undefined {
  const pointer = path.join(dashboardRoot(id), "current");
  return existsSync(pointer) ? readFileSync(pointer, "utf8").trim() : undefined;
}

export function readLiveDefinition(id: string): LiveDefinition | undefined {
  const digest = currentDigest(id);
  if (!digest) return undefined;
  const directory = versionPath(id, digest);
  const files = readFolder(directory);
  const manifest = checkDefinition(files);
  const html = files.find((file) => file.path === "index.html")!.content.toString("utf8");
  return { digest, manifest, html, files, directory };
}

/** The folder the creator agent edits; an edit starts from the live definition. */
export function prepareDraft(id: string): string {
  const draft = draftPath(id);
  if (existsSync(draft)) return draft;
  mkdirSync(path.dirname(draft), { recursive: true, mode: 0o700 });
  const live = readLiveDefinition(id);
  if (live) cpSync(live.directory, draft, { recursive: true });
  else mkdirSync(draft, { mode: 0o700 });
  return draft;
}

export function draftExists(id: string): boolean {
  return existsSync(draftPath(id));
}

export function readDraftFiles(id: string): DefinitionFile[] {
  return readFolder(draftPath(id));
}

export function discardDraft(id: string): void {
  rmSync(draftPath(id), { recursive: true, force: true });
  rmSync(payloadPath(id, "draft"), { force: true });
}

/** Whether the draft would save, without saving it. */
export function checkDraft(id: string): { ok: true; manifest: DashboardManifest } | { ok: false; error: string } {
  try { return { ok: true, manifest: checkDefinition(readFolder(draftPath(id))) }; }
  catch (error) { return { ok: false, error: (error as Error).message }; }
}

/**
 * What the creator view needs while the agent writes: whether there is a page to show yet, and a
 * version that changes whenever a draft file does, so the preview reloads only then.
 */
export function draftState(id: string): { hasPage: boolean; version: number } {
  const draft = draftPath(id);
  if (!existsSync(draft)) return { hasPage: false, version: 0 };
  let version = 0;
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const stat = lstatSync(path.join(directory, name));
      version = Math.max(version, stat.mtimeMs);
      if (stat.isDirectory()) walk(path.join(directory, name));
    }
  };
  walk(draft);
  return { hasPage: existsSync(path.join(draft, "index.html")), version };
}

export function draftDirectory(id: string): string {
  return draftPath(id);
}

/** The creator chat for this dashboard on this node, oldest first. */
export interface CreatorMessage { role: "user" | "assistant"; text: string; at: string }
export function readCreatorMessages(id: string): CreatorMessage[] {
  const file = path.join(dashboardRoot(id), "creator.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as CreatorMessage[] : [];
}

export function appendCreatorMessage(id: string, message: { role: CreatorMessage["role"]; text: string }): void {
  const root = dashboardRoot(id);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const messages = [...readCreatorMessages(id), { ...message, at: new Date().toISOString() }];
  const temporary = path.join(root, `.creator-${process.pid}-${Date.now()}`);
  writeFileSync(temporary, JSON.stringify(messages));
  renameSync(temporary, path.join(root, "creator.json"));
}

export function promoteDraft(id: string): { digest: string; manifest: DashboardManifest } {
  const installed = installVersion(id, readFolder(draftPath(id)));
  discardDraft(id);
  return installed;
}

export function writeReceivedDefinition(id: string, files: DefinitionFile[]): { digest: string; manifest: DashboardManifest } {
  return installVersion(id, files);
}

/** The live definition's data, or a draft's test refresh, which never replaces the live data. */
export type PayloadTarget = "live" | "draft";
export function payloadPath(id: string, target: PayloadTarget = "live"): string {
  return path.join(dashboardRoot(id), target === "live" ? "payload.json" : "draft-payload.json");
}

export function readPayload(id: string, target: PayloadTarget = "live"): DashboardPayload | undefined {
  const file = payloadPath(id, target);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as DashboardPayload : undefined;
}

export function writePayload(id: string, payload: DashboardPayload, target: PayloadTarget = "live"): void {
  const root = dashboardRoot(id);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const temporary = path.join(root, `.payload-${process.pid}-${Date.now()}`);
  writeFileSync(temporary, JSON.stringify(payload));
  renameSync(temporary, payloadPath(id, target));
}

export function writeRunLog(id: string, text: string): void {
  const root = dashboardRoot(id);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(root, "run.log"), text);
}

export function readRunLog(id: string): string {
  const file = path.join(dashboardRoot(id), "run.log");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

export function stateDirectory(id: string): string {
  const directory = path.join(dashboardRoot(id), "state");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

export function removeDashboardFiles(id: string): void {
  rmSync(dashboardRoot(id), { recursive: true, force: true });
}
