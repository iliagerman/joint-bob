import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSettings, syncthingApiKey } from "./settings.js";
import { TICKET_WORKSPACE_FOLDER_ID, TICKET_WORKSPACE_FOLDER_LABEL, ticketWorkspaceRoot } from "./task-workspaces.js";

interface SyncthingDevice {
  deviceID: string;
  name?: string;
  addresses?: string[];
}

interface SyncthingFolder {
  id: string;
  label: string;
  path: string;
  type: string;
  devices: SyncthingDevice[];
  [key: string]: unknown;
}

interface SyncthingStatus {
  myID: string;
}

interface SyncthingIgnores {
  ignore: string[] | null;
}

interface SyncthingFolderStatus {
  state: string;
  needTotalItems: number;
  needBytes: number;
  errors?: unknown[] | number;
}

export interface SyncthingConnection {
  url: string;
  apiKey: string;
  configPath?: string;
}

const projectIgnorePatterns = [
  ".git",
  ".git/**",
  "**/.git",
  "**/.git/**",
  "node_modules/",
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
  const managedPatterns = new Set(projectIgnorePatterns);
  const userRules = [...new Set(existingIgnore.filter((rule) => !managedPatterns.has(rule)))];
  const ignore = [...projectIgnorePatterns, ...userRules];
  if (ignore.length === existingIgnore.length && ignore.every((rule, index) => rule === existingIgnore[index])) return;
  await request<void>(endpoint, { method: "POST", body: JSON.stringify({ ignore }) });
}

export async function reconcileSyncthingProjectFolders(projects: Array<{ syncFolderId?: string }>): Promise<void> {
  const folderIds = [...new Set(projects.flatMap((project) => project.syncFolderId ? [project.syncFolderId] : []))];
  await Promise.all(folderIds.map(setProjectIgnores));
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
