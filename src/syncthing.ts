import { access, mkdir, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSettings, syncthingApiKey } from "./settings.js";
import { AGENT_RESOURCES_FOLDER_ID, AGENT_RESOURCES_FOLDER_LABEL } from "./agent-resources.js";
import { TICKET_FOLDER_PREFIX, TICKET_WORKSPACE_FOLDER_ID, TICKET_WORKSPACE_FOLDER_LABEL, ticketWorkspaceRoot } from "./task-workspaces.js";
import type { ProjectSyncStatus } from "./types.js";
import { WORKTREE_FOLDER_PREFIX, worktreeBinaryExtensions, worktreeHeavyDirectories, worktreeLinkedDirectories } from "./worktree-filters.js";

interface SyncthingDevice {
  deviceID: string;
  name?: string;
  addresses?: string[];
}

export interface SyncthingFolder {
  id: string;
  label: string;
  path: string;
  type: string;
  devices: SyncthingDevice[];
  paused?: boolean;
  [key: string]: unknown;
}

interface SyncthingStatus {
  myID: string;
}

interface SyncthingIgnores {
  ignore: string[] | null;
}

export interface SyncthingFolderStatus {
  state: string;
  needTotalItems: number;
  needBytes: number;
  errors?: unknown[] | number;
  error?: string;
  paused?: boolean;
}

const PI_ENGINE_SYNC_FOLDER_ID = "dot-pi";
const CLAUDE_ENGINE_SYNC_FOLDER_ID = "dot-claude";

export interface ConversationSyncFolder { id: string; label: string; path: string; }

export interface SyncthingConnection {
  url: string;
  apiKey: string;
  configPath?: string;
}

/* `(?d)` marks regenerable files Syncthing may delete when another device removes
   their folder; without it the delete fails with "contains ignored files" and the
   folder never finishes syncing. Secrets and nested repositories never get it. */
const projectIgnorePatterns = [
  ".git",
  ".git/**",
  "**/.git",
  "**/.git/**",
  "(?d)node_modules/",
  "(?d)node_modules/**",
  "(?d)**/node_modules",
  "(?d)**/node_modules/**",
  "(?d).venv/",
  "(?d)venv/",
  "(?d)site-packages",
  "(?d)dist-packages",
  "(?d)__pypackages__",
  "(?d).tox",
  "(?d).nox",
  "(?d).eggs",
  "(?d)*.egg-info",
  "(?d).npm",
  "(?d).pnpm-store",
  "(?d).yarn/cache",
  "(?d).yarn/unplugged",
  "(?d).cache/pip",
  "(?d).cache/uv",
  "(?d).nuget",
  "(?d).gradle",
  "(?d).m2",
  "(?d)(?i)*.pyc",
  "(?d)(?i)*.pyo",
  "(?d)(?i)*.whl",
  "(?d)(?i)*.egg",
  "(?d)(?i)*.nupkg",
  "(?d)(?i)*.snupkg",
  "(?d)dist/",
  "(?d)build/",
  // Build output, Terraform provider binaries (hundreds of MB each) and scratch trees.
  "(?d).build",
  "(?d)target",
  "(?d).next",
  "(?d)DerivedData",
  "(?d).terraform",
  "(?d).nx/cache",
  "(?d)tmp",
  "(?d).tmp",
  // Agents' own worktrees are full copies of the repository.
  "(?d).claude/worktrees",
  "(?d).pi/*worktrees",
  "(?d)coverage/",
  "(?d)test-results/",
  "(?d)**/test-results/",
  "(?d)playwright-report/",
  "(?d)**/playwright-report/",
  "(?d).pytest_cache/",
  "(?d)**/.pytest_cache/",
  "(?d).mypy_cache/",
  "(?d)**/.mypy_cache/",
  "(?d).ruff_cache/",
  "(?d)**/.ruff_cache/",
  "(?d)__pycache__/",
  "(?d).DS_Store",
  // The first matching rule wins. A dev node's secret.key under .dev-env must meet
  // this rule before `*.key`, or the scratch directory can never be deleted.
  "(?d).dev-env/",
  "(?d)**/.dev-env/",
  // Test runs build into .test-build-<hash> in the checkout; two machines running tests left conflict copies of it.
  "(?d).test-build-*",
  // Half-written files: worktree staging copies, atomic writes (<name>.<uuid>.tmp), merge journal
  // writes and rollbacks, and file-sync downloads.
  "(?d).creating-*",
  "(?d)*.????????-????-????-????-????????????.tmp",
  "(?d)*.jb-merge-*.tmp",
  "(?d)*.jb-rollback-*.tmp",
  "(?d).joint-bob-sync.*.tmp",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  "id_rsa*",
  "id_ed25519*",
  "id_ecdsa*",
  ".joint-bob/",
  "**/.joint-bob/",
  // Legacy branch-ticket worktrees beside a project: node-local checkouts, never shared.
  ".joint-bob-worktrees",
  ".pi-mobile-web/",
  "**/.pi-mobile-web/",
  "(?d)aidlc/.aidlc-*",
  "(?d)**/aidlc/.aidlc-*",
  "(?d)aidlc/spaces/*/intents/.aidlc-*",
  "(?d)**/aidlc/spaces/*/intents/.aidlc-*",
  "(?d)aidlc/spaces/*/intents/*/.aidlc-*",
  "(?d)**/aidlc/spaces/*/intents/*/.aidlc-*",
  "(?d)logs/",
  "(?d)**/logs/",
  "(?d)*.log",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials.json",
  "service-account*.json",
  "(?d)test_database_*.db",
  "(?d)**/test_database_*.db",
  // SQLite side files are only valid next to their open database; test runs left hundreds behind.
  "(?d)*.db-wal",
  "(?d)*.db-shm",
  "(?d)*.db-journal",
  "(?d)*.sqlite-wal",
  "(?d)*.sqlite-shm",
  "(?d)*.sqlite-journal",
  "(?d)*.sqlite3-wal",
  "(?d)*.sqlite3-shm",
  "(?d)*.sqlite3-journal",
];

/* Worktrees are disposable copies: every rule is deletable so removing a worktree on one
   node removes it everywhere, and heavy trees and binaries never travel. */
const worktreeIgnorePatterns = [...new Set([
  ...projectIgnorePatterns.map((rule) => rule.startsWith("(?d)") ? rule : `(?d)${rule}`),
  ...worktreeHeavyDirectories.filter((name) => !name.startsWith(".st")).map((name) => `(?d)${name}`),
  // Each node links its own project's dependencies; a link never travels to a peer.
  ...worktreeLinkedDirectories.filter((name) => !(worktreeHeavyDirectories as readonly string[]).includes(name)).map((name) => `(?d)${name}`),
  "(?d).joint-bob-merge",
  ...worktreeBinaryExtensions.map((extension) => `(?d)(?i)*.${extension}`),
])];

const agentResourceIgnorePatterns = [
  ...projectIgnorePatterns,
  "cache/",
  "cache/**",
  "**/cache",
  "**/cache/**",
  "caches/",
  "caches/**",
  "**/caches",
  "**/caches/**",
  "*.sync-conflict-*",
];

type IgnorePolicy = "project" | "resources" | "none";

function defaultConfigPaths(): string[] {
  return process.platform === "darwin"
    ? [path.join(os.homedir(), "Library/Application Support/Syncthing/config.xml")]
    : [
        path.join(os.homedir(), ".local/state/syncthing/config.xml"),
        path.join(os.homedir(), ".config/syncthing/config.xml"),
      ];
}

function elementText(xml: string, element: string): string | undefined {
  return new RegExp(`<${element}[^>]*>([^<]+)</${element}>`).exec(xml)?.[1]?.trim();
}

function loopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function guiUrl(address: string, tls: boolean): string {
  if (/^https?:\/\//.test(address)) return address.replace(/\/$/, "");
  const normalized = address === "default"
    ? "127.0.0.1:8384"
    : address.replace(/^0\.0\.0\.0:/, "127.0.0.1:").replace(/^\[::\]:/, "127.0.0.1:");
  return `${tls ? "https" : "http"}://${normalized}`;
}

export async function discoverSyncthingConfig(configPaths = defaultConfigPaths()): Promise<SyncthingConnection | undefined> {
  for (const configPath of configPaths) {
    let xml: string;
    try {
      xml = await readFile(configPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const gui = /<gui\b([^>]*)>([\s\S]*?)<\/gui>/.exec(xml);
    if (!gui || /enabled="false"/.test(gui[1])) continue;
    const address = elementText(gui[2], "address");
    const apiKey = elementText(gui[2], "apikey");
    if (!address || !apiKey) continue;
    return { url: guiUrl(address, /tls="true"/.test(gui[1])), apiKey, configPath };
  }
  return undefined;
}

let connectionPromise: Promise<SyncthingConnection | undefined> | undefined;

async function connection(): Promise<SyncthingConnection | undefined> {
  if (!connectionPromise) {
    connectionPromise = discoverSyncthingConfig().then((discovered) => {
      const settings = getSettings();
      const url = (process.env.JOINT_BOB_SYNCTHING_URL ?? process.env.PI_MOBILE_WEB_SYNCTHING_URL)?.trim() || settings.syncthing.endpoint || discovered?.url;
      const apiKey = (process.env.JOINT_BOB_SYNCTHING_API_KEY ?? process.env.PI_MOBILE_WEB_SYNCTHING_API_KEY)?.trim() || syncthingApiKey() || discovered?.apiKey;
      return url && apiKey && loopbackUrl(url) ? { url, apiKey, configPath: discovered?.configPath } : undefined;
    });
  }
  return connectionPromise;
}

async function request<T>(pathname: string, init: RequestInit = {}): Promise<T> {
  const configured = await connection();
  if (!configured) throw new Error("Syncthing is not configured on this node");
  const response = await fetch(new URL(pathname, configured.url), {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(10_000),
    headers: { ...init.headers, "Content-Type": "application/json", "X-API-Key": configured.apiKey },
  });
  if (!response.ok) throw new Error(`Syncthing request failed: ${response.status} ${response.statusText}`);
  const body = await response.text();
  return body ? JSON.parse(body) as T : undefined as T;
}

const unreachableCodes = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);
/** No answer at all: the daemon is not configured, down, still binding its port, or hung. Every transport
    failure says "fetch failed", and a TLS error or a reset comes from a daemon that may be running, so only the cause decides. */
export function syncthingUnreachable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === "Syncthing is not configured on this node") return true;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  return unreachableCodes.has((error.cause as NodeJS.ErrnoException | undefined)?.code ?? "");
}

let connectionGeneration = 0;
/** fix (P4+P5): told when the connection is reset, so the file sync switch checks its built-in projects against this Syncthing's folders again. */
const resetListeners = new Set<() => void>();
export function resetSyncthingConnection(): void {
  connectionPromise = undefined;
  connectionGeneration += 1;
  for (const listener of resetListeners) { try { listener(); } catch { /* a listener's failure is its own */ } }
}

export function onSyncthingConnectionReset(listener: () => void): () => void {
  resetListeners.add(listener);
  return () => { resetListeners.delete(listener); };
}

/** Changes whenever this node is pointed at a different Syncthing, so work done against the old one is redone. */
export function syncthingConnectionGeneration(): number { return connectionGeneration; }

export async function syncthingDeviceId(): Promise<string | undefined> {
  if (!await connection()) return undefined;
  return (await request<SyncthingStatus>("/rest/system/status")).myID;
}

export async function listSyncthingFolders(): Promise<SyncthingFolder[]> {
  if (!await connection()) return [];
  return request<SyncthingFolder[]>("/rest/config/folders");
}

/** The folder list from a daemon that answered; a node without Syncthing throws instead of listing nothing. */
export async function requireSyncthingFolders(): Promise<SyncthingFolder[]> {
  return request<SyncthingFolder[]>("/rest/config/folders");
}

/** A folder's .stignore lines as Syncthing reports them, managed and user rules alike. */
export async function syncthingIgnoreLines(folderId: string): Promise<string[]> {
  return (await request<SyncthingIgnores>(`/rest/db/ignores?folder=${encodeURIComponent(folderId)}`)).ignore ?? [];
}

export async function rescanSyncthingFolder(folderId: string): Promise<void> {
  await request<void>(`/rest/db/scan?folder=${encodeURIComponent(folderId)}`, { method: "POST" });
}

/** Earlier releases wrote some managed rules without `(?d)`; those forms are still ours to replace. */
function withoutDeletable(rule: string): string { return rule.replace(/^\(\?d\)/, ""); }

async function setIgnores(folderId: string, patterns: readonly string[], preserveUserRules: boolean): Promise<void> {
  const endpoint = `/rest/db/ignores?folder=${encodeURIComponent(folderId)}`;
  const existing = await request<SyncthingIgnores>(endpoint);
  const existingIgnore = existing.ignore ?? [];
  const managed = new Set([...patterns, ...patterns.map(withoutDeletable)]);
  const userRules = preserveUserRules ? [...new Set(existingIgnore.filter((rule) => !managed.has(rule)))] : [];
  const ignore = [...patterns, ...userRules];
  if (ignore.length === existingIgnore.length && ignore.every((rule, index) => rule === existingIgnore[index])) return;
  await request<void>(endpoint, { method: "POST", body: JSON.stringify({ ignore }) });
}

async function setProjectIgnores(folderId: string): Promise<void> {
  const endpoint = `/rest/db/ignores?folder=${encodeURIComponent(folderId)}`;
  const existing = await request<SyncthingIgnores>(endpoint);
  const existingIgnore = existing.ignore ?? [];
  const folderPatterns = folderId.startsWith(WORKTREE_FOLDER_PREFIX) ? worktreeIgnorePatterns : projectIgnorePatterns;
  const managedPatterns = new Set([...projectIgnorePatterns, ...worktreeIgnorePatterns].flatMap((rule) => [rule, withoutDeletable(rule)]));
  const userRules = [...new Set(existingIgnore.filter((rule) => !managedPatterns.has(rule)))];
  const ignore = [...folderPatterns, ...userRules];
  if (ignore.length === existingIgnore.length && ignore.every((rule, index) => rule === existingIgnore[index])) return;
  await request<void>(endpoint, { method: "POST", body: JSON.stringify({ ignore }) });
}

export async function reconcileSyncthingProjectFolders(projects: Array<{ syncFolderId?: string }>): Promise<void> {
  const folderIds = [...new Set(projects.flatMap((project) => project.syncFolderId ? [project.syncFolderId] : []))];
  if (!folderIds.length) return;
  // Syncthing rejects ignores for an unknown folder, and one project whose folder was never
  // created must not hold startup readiness; the sync check reports the missing folder.
  const folders = await request<SyncthingFolder[]>("/rest/config/folders");
  const configured = new Set(folders.map((folder) => folder.id));
  const worktreeFolders = folders.filter((folder) => folder.id.startsWith(WORKTREE_FOLDER_PREFIX));
  // Ticket folders take project rules too; readiness checks no longer refresh them, so this does.
  const ticketFolders = folders.filter((folder) => folder.id.startsWith(TICKET_FOLDER_PREFIX));
  const managedIds = new Set([...folderIds.filter((id) => configured.has(id)), ...[...worktreeFolders, ...ticketFolders].map((folder) => folder.id)]);
  await Promise.all([...managedIds].map(setProjectIgnores));
  // Only the order changes: a PUT of this snapshot would drop a device enrollment added meanwhile.
  await Promise.all(worktreeFolders.filter((folder) => folder.order !== "smallestFirst").map((folder) =>
    request<void>(`/rest/config/folders/${encodeURIComponent(folder.id)}`, { method: "PATCH", body: JSON.stringify({ order: "smallestFirst" }) })));
}

function remaining(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function statusErrors(errors: unknown): number {
  return typeof errors === "number" ? Math.max(0, errors) : Array.isArray(errors) ? errors.length : 0;
}

function unavailableStatus(message: string): ProjectSyncStatus {
  return { state: "unavailable", remainingFiles: 0, remainingBytes: 0, message };
}

/** A folder Joint Bob expects that Syncthing's configuration does not have (file sync: one being added back after a move back). */
export const SYNCTHING_FOLDER_MISSING = "Syncthing folder is missing from configuration";

export async function syncthingFolderStatuses(folderIds: string[]): Promise<Record<string, ProjectSyncStatus>> {
  const ids = [...new Set(folderIds.filter(Boolean))];
  if (!ids.length) return {};
  if (!await connection()) return Object.fromEntries(ids.map((id) => [id, unavailableStatus("Syncthing is not configured on this node")]));
  let folders: SyncthingFolder[];
  try {
    folders = await request<SyncthingFolder[]>("/rest/config/folders");
  } catch {
    return Object.fromEntries(ids.map((id) => [id, unavailableStatus("Syncthing folder list is unavailable")]));
  }
  const configured = new Map(folders.map((folder) => [folder.id, folder]));
  const entries = await Promise.all(ids.map(async (id): Promise<[string, ProjectSyncStatus]> => {
    const folder = configured.get(id);
    if (!folder) return [id, { state: "error", remainingFiles: 0, remainingBytes: 0, message: SYNCTHING_FOLDER_MISSING }];
    if (folder.paused) return [id, { state: "paused", remainingFiles: 0, remainingBytes: 0, message: "Syncthing folder is paused" }];
    try {
      const status = await request<SyncthingFolderStatus>(`/rest/db/status?folder=${encodeURIComponent(id)}`);
      const remainingFiles = remaining(status.needTotalItems);
      const remainingBytes = remaining(status.needBytes);
      const errors = statusErrors(status.errors);
      if (status.paused || status.state === "paused") return [id, { state: "paused", remainingFiles, remainingBytes, message: "Syncthing folder is paused" }];
      if (errors || status.state === "error") return [id, { state: "error", remainingFiles, remainingBytes, message: status.error?.trim() || (errors ? "Syncthing reported folder errors" : "Syncthing folder is in an error state") }];
      if (status.state === "idle" && remainingFiles === 0 && remainingBytes === 0) return [id, { state: "synced", remainingFiles, remainingBytes, message: "Safe to start work" }];
      return [id, { state: "syncing", remainingFiles, remainingBytes, message: "Syncthing is synchronizing this folder" }];
    } catch {
      return [id, { state: "error", remainingFiles: 0, remainingBytes: 0, message: "Syncthing folder status is unavailable" }];
    }
  }));
  return Object.fromEntries(entries);
}

/**
 * auto-transition (file sync): how many files Syncthing knows in each folder; a folder it does not
 * answer for is left out. /rest/db/status is an expensive call for Syncthing, so a few at a time,
 * and none once `signal` aborts.
 */
export async function syncthingFolderFileCounts(folderIds: string[], options: { signal?: AbortSignal; concurrency?: number } = {}): Promise<Record<string, number>> {
  if (!await connection()) return {};
  const counts: Record<string, number> = {};
  const queue = [...new Set(folderIds.filter(Boolean))];
  const worker = async (): Promise<void> => {
    for (let id = queue.shift(); id !== undefined && !options.signal?.aborted; id = queue.shift()) {
      try {
        const status = await request<{ globalFiles?: number; localFiles?: number }>(`/rest/db/status?folder=${encodeURIComponent(id)}`, options.signal ? { signal: AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) } : {});
        const files = status.globalFiles ?? status.localFiles;
        if (typeof files === "number" && Number.isFinite(files)) counts[id] = files;
      } catch { /* unknown: ordered by name */ }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, options.concurrency ?? 2) }, worker));
  return counts;
}

/** fix (file sync): a Syncthing configuration at its usual place on this machine, so a daemon may run here even when Joint Bob has no connection to it. */
export async function syncthingConfigPresent(): Promise<boolean> {
  for (const configPath of defaultConfigPaths()) {
    try { await access(configPath); return true; } catch { /* not here */ }
  }
  return false;
}

export interface SyncthingEvent { id: number; type: string; time?: string; data?: unknown }

/**
 * auto-transition (file sync): Syncthing's event stream, long-polled. Events of `events` after
 * `since`, waiting up to `timeoutSeconds` for one; `limit` keeps only the newest. Throws like every
 * request here, "Syncthing is not configured on this node" included.
 */
export async function syncthingEvents(options: { since: number; events: readonly string[]; timeoutSeconds: number; limit?: number; signal?: AbortSignal }): Promise<SyncthingEvent[]> {
  const query = new URLSearchParams({ since: String(options.since), events: options.events.join(","), timeout: String(options.timeoutSeconds), ...(options.limit ? { limit: String(options.limit) } : {}) });
  const wait = AbortSignal.timeout((options.timeoutSeconds + 15) * 1000);
  const events = await request<SyncthingEvent[] | null>(`/rest/events?${query}`, { signal: options.signal ? AbortSignal.any([options.signal, wait]) : wait });
  return Array.isArray(events) ? events.filter((event) => Number.isInteger(event?.id) && typeof event.type === "string") : [];
}

/** The items Syncthing could not pull for a folder, with its reason for each. */
export async function syncthingFolderErrors(folderId: string): Promise<Array<{ path: string; error: string }>> {
  const body = await request<{ errors?: Array<{ path: string; error: string }> | null }>(`/rest/folder/errors?folder=${encodeURIComponent(folderId)}`);
  return body.errors ?? [];
}

export async function syncthingPeerCaughtUp(deviceId: string, folderIds: string[]): Promise<boolean> {
  if (!await connection()) throw new Error("Syncthing is not configured on this node");
  const connections = await request<{ connections: Record<string, { connected: boolean }> }>("/rest/system/connections");
  if (!connections.connections[deviceId]?.connected) return false;
  const local = await syncthingFolderStatuses(folderIds);
  for (const id of folderIds) {
    if (local[id].state !== "synced") return false;
    const completion = await request<{ completion: number; needItems: number; needBytes: number; needDeletes: number; remoteState: string }>(
      `/rest/db/completion?folder=${encodeURIComponent(id)}&device=${encodeURIComponent(deviceId)}`);
    if (completion.completion !== 100 || completion.needItems !== 0 || completion.needBytes !== 0
      || completion.needDeletes !== 0 || completion.remoteState !== "valid") return false;
  }
  return true;
}

export async function assertSyncthingFolderReady(folderId: string, projectIgnores = true): Promise<void> {
  if (!await connection()) throw new Error("Syncthing is not configured on this node");
  try {
    if (projectIgnores) await setProjectIgnores(folderId);
    const status = await request<SyncthingFolderStatus>(`/rest/db/status?folder=${encodeURIComponent(folderId)}`);
    const errors = typeof status.errors === "number" ? status.errors : status.errors?.length ?? 0;
    if (status.state !== "idle" || status.needTotalItems !== 0 || status.needBytes !== 0 || errors !== 0) {
      throw new Error("Syncthing folder is not synchronized on this node");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Syncthing folder is not synchronized on this node") throw error;
    throw new Error("Syncthing folder is not synchronized on this node");
  }
}

export async function ensureSyncthingDevice(deviceId: string, name: string): Promise<void> {
  if (!await connection()) throw new Error("Syncthing is not configured on this node");
  const devices = await request<SyncthingDevice[]>("/rest/config/devices");
  if (devices.some((device) => device.deviceID === deviceId)) return;
  await request<void>("/rest/config/devices", {
    method: "POST",
    body: JSON.stringify({ deviceID: deviceId, name, addresses: ["dynamic"] }),
  });
}

/**
 * Changes where Syncthing dials a device, given its current addresses. Relay tunnels add or
 * remove only their own loopback address and keep everything else (RELAY-PLAN.md §4.9).
 * Returns false when Syncthing or the device is not configured.
 */
export async function updateSyncthingDeviceAddresses(deviceId: string, change: (current: string[]) => string[]): Promise<boolean> {
  if (!await connection()) return false;
  const devices = await request<SyncthingDevice[]>("/rest/config/devices");
  const device = devices.find((item) => item.deviceID === deviceId);
  if (!device) return false;
  const current = device.addresses?.length ? device.addresses : ["dynamic"];
  const next = change(current);
  const addresses = next.length ? next : ["dynamic"];
  if (current.length === addresses.length && current.every((address, index) => address === addresses[index])) return true;
  await request<void>(`/rest/config/devices/${encodeURIComponent(deviceId)}`, { method: "PATCH", body: JSON.stringify({ addresses }) });
  return true;
}

/** The local TCP port Syncthing accepts device connections on. */
export async function syncthingListenPort(): Promise<number> {
  if (await connection()) {
    try {
      const status = await request<{ connectionServiceStatus?: Record<string, unknown> }>("/rest/system/status");
      for (const address of Object.keys(status.connectionServiceStatus ?? {})) {
        const match = /^tcp\d?:\/\/[^/]*:(\d+)$/.exec(address);
        if (match) return Number(match[1]);
      }
    } catch { /* fall back to Syncthing's default */ }
  }
  return 22000;
}

export async function removeSyncthingDevices(deviceIds: string[], folderIds: string[]): Promise<void> {
  if (!deviceIds.length || !folderIds.length || !await connection()) return;
  const removed = new Set(deviceIds);
  const ownedFolders = new Set(folderIds);
  for (const folder of await listSyncthingFolders()) {
    if (!ownedFolders.has(folder.id)) continue;
    const devices = folder.devices.filter((device) => !removed.has(device.deviceID));
    if (devices.length === folder.devices.length) continue;
    await request<void>(`/rest/config/folders/${encodeURIComponent(folder.id)}`, {
      method: "PUT",
      body: JSON.stringify({ ...folder, devices }),
    });
  }
}

export async function pauseSyncthingFolders(folderIds:string[], folders?:SyncthingFolder[]):Promise<void> {
  for(const folder of folders ?? await listSyncthingFolders()){
    if(!folderIds.includes(folder.id)||folder.paused)continue;
    await request<void>(`/rest/config/folders/${encodeURIComponent(folder.id)}`,{
      method:'PUT',body:JSON.stringify({...folder,paused:true}),
    });
  }
}

export async function ensureTicketWorkspaceFolder(folderPath = ticketWorkspaceRoot(), peerDeviceId?: string, peerName = peerDeviceId ?? ""): Promise<void> {
  if (peerDeviceId) await ensureSyncthingDevice(peerDeviceId, peerName);
  await ensureSyncthingFolder(TICKET_WORKSPACE_FOLDER_ID, TICKET_WORKSPACE_FOLDER_LABEL, folderPath, peerDeviceId);
}

export async function pauseEngineSyncFolders(): Promise<void> {
  const settings = getSettings();
  const resourcePaths = new Set([
    path.resolve(settings.pi.configPath),
    path.resolve(settings.claude.configPath),
    path.join(os.homedir(), ".agents"),
  ]);
  const legacyIds = new Set([PI_ENGINE_SYNC_FOLDER_ID, CLAUDE_ENGINE_SYNC_FOLDER_ID]);
  for (const folder of await listSyncthingFolders()) {
    const isLegacyResourceFolder = legacyIds.has(folder.id) || resourcePaths.has(path.resolve(folder.path));
    if (folder.id === AGENT_RESOURCES_FOLDER_ID || !isLegacyResourceFolder || folder.paused) continue;
    await request<void>(`/rest/config/folders/${encodeURIComponent(folder.id)}`, {
      method: "PUT",
      body: JSON.stringify({ ...folder, paused: true }),
    });
  }
}

async function ensureFolder(folderId: string, label: string, folderPath: string, peerDeviceId: string | undefined, ignorePolicy: IgnorePolicy, unpause: boolean): Promise<void> {
  if (!await connection()) throw new Error("Syncthing is not configured on this node");
  const requestedPath = path.resolve(folderPath);
  const folders = await listSyncthingFolders();
  const existing = folders.find((folder) => folder.id === folderId);
  const localDeviceId = await syncthingDeviceId();
  const deviceIds = [...new Set([
    ...(existing?.devices ?? []).map((device) => device.deviceID),
    localDeviceId,
    peerDeviceId,
  ].filter((deviceId): deviceId is string => Boolean(deviceId)))];
  const pathChanged = Boolean(existing && path.resolve(existing.path) !== requestedPath);
  // A new worktree arrives as thousands of files; its ~100-byte metadata (node paths, conversation
  // markers) must not wait behind them, or peers cannot see the conversation running in it.
  const order = folderId.startsWith(WORKTREE_FOLDER_PREFIX) ? { order: "smallestFirst" } : {};
  const folder = existing
    ? { ...existing, ...order, label, path: requestedPath, ...(unpause ? { paused: false } : {}), devices: deviceIds.map((deviceID) => ({ deviceID })) }
    : {
        id: folderId,
        label,
        path: requestedPath,
        type: "sendreceive",
        devices: deviceIds.map((deviceID) => ({ deviceID })),
        markerName: ".stfolder",
        ...order,
      };
  if (!existing) {
    await request<void>("/rest/config/folders", { method: "POST", body: JSON.stringify(folder) });
  } else if (pathChanged || deviceIds.length !== existing.devices.length || existing.label !== label || (unpause && existing.paused) || (order.order && existing.order !== order.order)) {
    await request<void>(`/rest/config/folders/${encodeURIComponent(folderId)}`, { method: "PUT", body: JSON.stringify(folder) });
  }
  if (ignorePolicy === "project") await setProjectIgnores(folderId);
  if (ignorePolicy === "resources") await setIgnores(folderId, agentResourceIgnorePatterns, false);
}

export async function ensureSharedProjectFolder(folderId: string, label: string, folderPath: string, peerDeviceId: string): Promise<void> {
  const folders = await listSyncthingFolders();
  const canonical = folders.find(folder => folder.id === folderId);
  if (canonical && path.resolve(canonical.path) !== path.resolve(folderPath)) throw new Error("Shared folder ID belongs to a different local path");
  const prior = folders.find(folder => path.resolve(folder.path) === path.resolve(folderPath) && folder.id !== folderId);
  // Syncthing configuration removal does not delete files. Preserve pause state on remapping.
  if (prior) {
    await request<void>(`/rest/config/folders/${encodeURIComponent(prior.id)}`, { method: "DELETE" });
    if (!canonical) await request<void>("/rest/config/folders", { method: "POST", body: JSON.stringify({ ...prior, id: folderId, label }) });
  }
  await ensureSyncthingFolder(folderId, label, folderPath, peerDeviceId);
}

export async function resumeSharedProjectFolder(folderId: string): Promise<void> {
  const folder = (await listSyncthingFolders()).find(candidate => candidate.id === folderId);
  if (!folder) return;
  if (folder.paused) await request<void>(`/rest/config/folders/${encodeURIComponent(folderId)}`, {
    method: "PUT", body: JSON.stringify({ ...folder, paused: false }),
  });
}

export async function ensureSyncthingFolder(folderId: string, label: string, folderPath: string, peerDeviceId?: string): Promise<void> {
  await ensureFolder(folderId, label, folderPath, peerDeviceId, "project", false);
}

export async function ensureAgentResourcesFolder(folderPath: string, peerDeviceId?: string, peerName = peerDeviceId ?? ""): Promise<void> {
  if (peerDeviceId) await ensureSyncthingDevice(peerDeviceId, peerName);
  await mkdir(path.resolve(folderPath), { recursive: true });
  await ensureFolder(AGENT_RESOURCES_FOLDER_ID, AGENT_RESOURCES_FOLDER_LABEL, folderPath, peerDeviceId, "resources", true);
}

export async function ensureConversationSyncFolders(folders: ConversationSyncFolder[], peerDeviceId?: string, peerName = peerDeviceId ?? ""): Promise<void> {
  if (peerDeviceId) await ensureSyncthingDevice(peerDeviceId, peerName);
  for (const folder of folders) {
    await mkdir(path.resolve(folder.path), { recursive: true });
    await ensureFolder(folder.id, folder.label, folder.path, peerDeviceId, "none", true);
  }
}

/* cutover-engine (P5): releasing a project's folders, matched by path (FILE-SYNC-PLAN.md §7.3). */

/** Where a path really is: `~` as Syncthing expands it, then the real path of its deepest existing part, so a symlinked folder or root matches its target. */
async function comparablePath(value: string): Promise<string> {
  const expanded = value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
  let current = path.resolve(expanded);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = path.join(await realpath(current), ...rest.reverse());
      // macOS and Windows volumes are usually case-insensitive: /Code/app and /code/app are one folder there.
      return process.platform === "darwin" || process.platform === "win32" ? real.toLowerCase() : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return process.platform === "darwin" || process.platform === "win32" ? path.resolve(expanded).toLowerCase() : path.resolve(expanded);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/** `inner` is `outer` or lies inside it. A sibling that only shares a prefix (/a/proj, /a/project) does not. */
function within(inner: string, outer: string): boolean {
  const relative = path.relative(outer, inner);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Folders whose path equals, contains or lies inside one of `roots`, compared by real path, never by ID. */
export async function syncthingFoldersCovering<T extends { path: string }>(folders: readonly T[], roots: readonly string[]): Promise<T[]> {
  const real = await Promise.all(roots.map(comparablePath));
  const covering: T[] = [];
  for (const folder of folders) {
    if (typeof folder.path !== "string" || !folder.path) continue;
    const at = await comparablePath(folder.path);
    if (real.some((root) => within(at, root) || within(root, at))) covering.push(folder);
  }
  return covering;
}

/** Takes one folder out of this node's Syncthing configuration. Syncthing keeps its files on disk: nothing is deleted. */
export async function removeSyncthingFolderConfig(folderId: string): Promise<void> {
  await request<void>(`/rest/config/folders/${encodeURIComponent(folderId)}`, { method: "DELETE" });
}
