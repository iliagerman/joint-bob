import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSettings, syncthingApiKey } from "./settings.js";
import { TICKET_WORKSPACE_FOLDER_ID, TICKET_WORKSPACE_FOLDER_LABEL, ticketWorkspaceRoot } from "./task-workspaces.js";
import type { ProjectSyncStatus } from "./types.js";

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

export const PI_ENGINE_SYNC_FOLDER_ID = "dot-pi";
export const CLAUDE_ENGINE_SYNC_FOLDER_ID = "dot-claude";

export interface EngineSyncFolder {
  id: typeof PI_ENGINE_SYNC_FOLDER_ID | typeof CLAUDE_ENGINE_SYNC_FOLDER_ID;
  label: string;
  path: string;
}

export interface SyncthingConnection {
  url: string;
  apiKey: string;
  configPath?: string;
}

const enginePrivateIgnorePatterns: Record<EngineSyncFolder["id"], string[]> = {
  [PI_ENGINE_SYNC_FOLDER_ID]: ["/.update-check", "/agent/auth.json", "/agent/models.json", "/agent/models-store.json", "/agent/bin/"],
  [CLAUDE_ENGINE_SYNC_FOLDER_ID]: [
    "/.credentials.json", "/.oauth_refresh.lock", "/.last-*", "/settings.json", "/settings.local.json", "/.mcp.json", "/mcp.json", "/mcp-needs-auth-cache.json",
    "/backups/", "/cache/", "/chrome/", "/daemon/", "/debug/", "/file-history/", "/ide/", "/image-cache/", "/jobs/", "/paste-cache/", "/shell-snapshots/", "/statsig/", "/telemetry/", "/history.jsonl", "/history.*",
  ],
};

const projectIgnorePatterns = [
  ".git",
  ".git/**",
  "**/.git",
  "**/.git/**",
  "node_modules/",
  "node_modules/**",
  "**/node_modules",
  "**/node_modules/**",
  ".venv/",
  "venv/",
  "dist/",
  "build/",
  "coverage/",
  "__pycache__/",
  ".DS_Store",
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
  ".pi-mobile-web/",
  "**/.pi-mobile-web/",
  "logs/",
  "**/logs/",
  "*.log",
  ".npmrc",
  ".pypirc",
  ".netrc",
  "credentials.json",
  "service-account*.json",
];

export function engineSyncFolders(homePath = os.homedir()): EngineSyncFolder[] {
  return [
    { id: PI_ENGINE_SYNC_FOLDER_ID, label: "Pi configuration and sessions", path: path.join(homePath, ".pi") },
    { id: CLAUDE_ENGINE_SYNC_FOLDER_ID, label: "Claude configuration and sessions", path: path.join(homePath, ".claude") },
  ];
}

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
    headers: { ...init.headers, "Content-Type": "application/json", "X-API-Key": configured.apiKey },
  });
  if (!response.ok) throw new Error(`Syncthing request failed: ${response.status} ${response.statusText}`);
  const body = await response.text();
  return body ? JSON.parse(body) as T : undefined as T;
}

export function resetSyncthingConnection(): void {
  connectionPromise = undefined;
}

export async function syncthingDeviceId(): Promise<string | undefined> {
  if (!await connection()) return undefined;
  return (await request<SyncthingStatus>("/rest/system/status")).myID;
}

export async function listSyncthingFolders(): Promise<SyncthingFolder[]> {
  if (!await connection()) return [];
  return request<SyncthingFolder[]>("/rest/config/folders");
}

export async function syncthingFolderIdForPath(folderPath: string): Promise<string | undefined> {
  const resolvedPath = path.resolve(folderPath);
  return (await listSyncthingFolders()).find((folder) => path.resolve(folder.path) === resolvedPath)?.id;
}

export async function syncthingPathForFolderId(folderId: string): Promise<string | undefined> {
  return (await listSyncthingFolders()).find((folder) => folder.id === folderId)?.path;
}

async function setProjectIgnores(folderId: string): Promise<void> {
  const endpoint = `/rest/db/ignores?folder=${encodeURIComponent(folderId)}`;
  const existing = await request<SyncthingIgnores>(endpoint);
  const existingIgnore = existing.ignore ?? [];
  const enginePatterns = enginePrivateIgnorePatterns[folderId as EngineSyncFolder["id"]] ?? [];
  const folderPatterns = [...projectIgnorePatterns, ...enginePatterns];
  const managedPatterns = new Set([...projectIgnorePatterns, ...Object.values(enginePrivateIgnorePatterns).flat()]);
  const userRules = [...new Set(existingIgnore.filter((rule) => !managedPatterns.has(rule)))];
  const ignore = [...folderPatterns, ...userRules];
  if (ignore.length === existingIgnore.length && ignore.every((rule, index) => rule === existingIgnore[index])) return;
  await request<void>(endpoint, { method: "POST", body: JSON.stringify({ ignore }) });
}

export async function reconcileSyncthingProjectFolders(projects: Array<{ syncFolderId?: string }>): Promise<void> {
  const folderIds = [...new Set(projects.flatMap((project) => project.syncFolderId ? [project.syncFolderId] : []))];
  await Promise.all(folderIds.map(setProjectIgnores));
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
    if (!folder) return [id, { state: "error", remainingFiles: 0, remainingBytes: 0, message: "Syncthing folder is missing from configuration" }];
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

export async function assertSyncthingFolderReady(folderId: string): Promise<void> {
  if (!await connection()) throw new Error("Syncthing is not configured on this node");
  try {
    await setProjectIgnores(folderId);
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

export async function ensureTicketWorkspaceFolder(folderPath = ticketWorkspaceRoot(), peerDeviceId?: string, peerName = peerDeviceId ?? ""): Promise<void> {
  if (peerDeviceId) await ensureSyncthingDevice(peerDeviceId, peerName);
  await ensureSyncthingFolder(TICKET_WORKSPACE_FOLDER_ID, TICKET_WORKSPACE_FOLDER_LABEL, folderPath, peerDeviceId);
}

export async function ensureEngineSyncFolders(homePath = os.homedir(), peerDeviceId?: string, peerName = peerDeviceId ?? ""): Promise<void> {
  const folders = engineSyncFolders(homePath);
  if (peerDeviceId) await ensureSyncthingDevice(peerDeviceId, peerName);
  for (const folder of folders) {
    await mkdir(folder.path, { recursive: true });
    await ensureSyncthingFolder(folder.id, folder.label, folder.path, peerDeviceId);
  }
}

export async function ensureSyncthingFolder(folderId: string, label: string, folderPath: string, peerDeviceId?: string): Promise<void> {
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
  const folder = existing
    ? { ...existing, path: requestedPath, devices: deviceIds.map((deviceID) => ({ deviceID })) }
    : {
        id: folderId,
        label,
        path: requestedPath,
        type: "sendreceive",
        devices: deviceIds.map((deviceID) => ({ deviceID })),
        markerName: ".stfolder",
      };
  if (!existing) {
    await request<void>("/rest/config/folders", { method: "POST", body: JSON.stringify(folder) });
  } else if (pathChanged || deviceIds.length !== existing.devices.length) {
    await request<void>(`/rest/config/folders/${encodeURIComponent(folderId)}`, { method: "PUT", body: JSON.stringify(folder) });
  }
  await setProjectIgnores(folderId);
}
