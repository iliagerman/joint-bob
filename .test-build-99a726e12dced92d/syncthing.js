import { mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSettings, syncthingApiKey } from "./settings.js";
import { AGENT_RESOURCES_FOLDER_ID, AGENT_RESOURCES_FOLDER_LABEL } from "./agent-resources.js";
import { TICKET_WORKSPACE_FOLDER_ID, TICKET_WORKSPACE_FOLDER_LABEL, ticketWorkspaceRoot } from "./task-workspaces.js";
import { WORKTREE_FOLDER_PREFIX, worktreeBinaryExtensions, worktreeHeavyDirectories, worktreeLinkedDirectories } from "./worktree-filters.js";
const PI_ENGINE_SYNC_FOLDER_ID = "dot-pi";
const CLAUDE_ENGINE_SYNC_FOLDER_ID = "dot-claude";
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
  "(?d)dist/",
  "(?d)build/",
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
  "(?d).dev-env/",
  "(?d)**/.dev-env/",
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
  "(?d)**/test_database_*.db"
];
const worktreeIgnorePatterns = [
  ...projectIgnorePatterns.map((rule) => rule.startsWith("(?d)") ? rule : `(?d)${rule}`),
  ...worktreeHeavyDirectories.filter((name) => !name.startsWith(".st")).map((name) => `(?d)${name}`),
  // Each node links its own project's dependencies; a link never travels to a peer.
  ...worktreeLinkedDirectories.filter((name) => !worktreeHeavyDirectories.includes(name)).map((name) => `(?d)${name}`),
  "(?d)*.egg-info",
  "(?d).joint-bob-merge",
  ...worktreeBinaryExtensions.map((extension) => `(?d)(?i)*.${extension}`)
];
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
  "*.sync-conflict-*"
];
function defaultConfigPaths() {
  return process.platform === "darwin" ? [path.join(os.homedir(), "Library/Application Support/Syncthing/config.xml")] : [
    path.join(os.homedir(), ".local/state/syncthing/config.xml"),
    path.join(os.homedir(), ".config/syncthing/config.xml")
  ];
}
function elementText(xml, element) {
  return new RegExp(`<${element}[^>]*>([^<]+)</${element}>`).exec(xml)?.[1]?.trim();
}
function loopbackUrl(value) {
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}
function guiUrl(address, tls) {
  if (/^https?:\/\//.test(address)) return address.replace(/\/$/, "");
  const normalized = address === "default" ? "127.0.0.1:8384" : address.replace(/^0\.0\.0\.0:/, "127.0.0.1:").replace(/^\[::\]:/, "127.0.0.1:");
  return `${tls ? "https" : "http"}://${normalized}`;
}
async function discoverSyncthingConfig(configPaths = defaultConfigPaths()) {
  for (const configPath of configPaths) {
    let xml;
    try {
      xml = await readFile(configPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const gui = /<gui\b([^>]*)>([\s\S]*?)<\/gui>/.exec(xml);
    if (!gui || /enabled="false"/.test(gui[1])) continue;
    const address = elementText(gui[2], "address");
    const apiKey = elementText(gui[2], "apikey");
    if (!address || !apiKey) continue;
    return { url: guiUrl(address, /tls="true"/.test(gui[1])), apiKey, configPath };
  }
  return void 0;
}
let connectionPromise;
async function connection() {
  if (!connectionPromise) {
    connectionPromise = discoverSyncthingConfig().then((discovered) => {
      const settings = getSettings();
      const url = (process.env.JOINT_BOB_SYNCTHING_URL ?? process.env.PI_MOBILE_WEB_SYNCTHING_URL)?.trim() || settings.syncthing.endpoint || discovered?.url;
      const apiKey = (process.env.JOINT_BOB_SYNCTHING_API_KEY ?? process.env.PI_MOBILE_WEB_SYNCTHING_API_KEY)?.trim() || syncthingApiKey() || discovered?.apiKey;
      return url && apiKey && loopbackUrl(url) ? { url, apiKey, configPath: discovered?.configPath } : void 0;
    });
  }
  return connectionPromise;
}
async function request(pathname, init = {}) {
  const configured = await connection();
  if (!configured) throw new Error("Syncthing is not configured on this node");
  const response = await fetch(new URL(pathname, configured.url), {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(1e4),
    headers: { ...init.headers, "Content-Type": "application/json", "X-API-Key": configured.apiKey }
  });
  if (!response.ok) throw new Error(`Syncthing request failed: ${response.status} ${response.statusText}`);
  const body = await response.text();
  return body ? JSON.parse(body) : void 0;
}
function resetSyncthingConnection() {
  connectionPromise = void 0;
}
async function syncthingDeviceId() {
  if (!await connection()) return void 0;
  return (await request("/rest/system/status")).myID;
}
async function listSyncthingFolders() {
  if (!await connection()) return [];
  return request("/rest/config/folders");
}
async function rescanSyncthingFolder(folderId) {
  await request(`/rest/db/scan?folder=${encodeURIComponent(folderId)}`, { method: "POST" });
}
function withoutDeletable(rule) {
  return rule.replace(/^\(\?d\)/, "");
}
async function setIgnores(folderId, patterns, preserveUserRules) {
  const endpoint = `/rest/db/ignores?folder=${encodeURIComponent(folderId)}`;
  const existing = await request(endpoint);
  const existingIgnore = existing.ignore ?? [];
  const managed = /* @__PURE__ */ new Set([...patterns, ...patterns.map(withoutDeletable)]);
  const userRules = preserveUserRules ? [...new Set(existingIgnore.filter((rule) => !managed.has(rule)))] : [];
  const ignore = [...patterns, ...userRules];
  if (ignore.length === existingIgnore.length && ignore.every((rule, index) => rule === existingIgnore[index])) return;
  await request(endpoint, { method: "POST", body: JSON.stringify({ ignore }) });
}
async function setProjectIgnores(folderId) {
  const endpoint = `/rest/db/ignores?folder=${encodeURIComponent(folderId)}`;
  const existing = await request(endpoint);
  const existingIgnore = existing.ignore ?? [];
  const folderPatterns = folderId.startsWith(WORKTREE_FOLDER_PREFIX) ? worktreeIgnorePatterns : projectIgnorePatterns;
  const managedPatterns = new Set([...projectIgnorePatterns, ...worktreeIgnorePatterns].flatMap((rule) => [rule, withoutDeletable(rule)]));
  const userRules = [...new Set(existingIgnore.filter((rule) => !managedPatterns.has(rule)))];
  const ignore = [...folderPatterns, ...userRules];
  if (ignore.length === existingIgnore.length && ignore.every((rule, index) => rule === existingIgnore[index])) return;
  await request(endpoint, { method: "POST", body: JSON.stringify({ ignore }) });
}
async function reconcileSyncthingProjectFolders(projects) {
  const folderIds = [...new Set(projects.flatMap((project) => project.syncFolderId ? [project.syncFolderId] : []))];
  if (!folderIds.length) return;
  const folders = await request("/rest/config/folders");
  const configured = new Set(folders.map((folder) => folder.id));
  await Promise.all(folderIds.filter((folderId) => configured.has(folderId)).map(setProjectIgnores));
  await Promise.all(folders.filter((folder) => folder.id.startsWith(WORKTREE_FOLDER_PREFIX) && folder.order !== "smallestFirst").map((folder) => request(`/rest/config/folders/${encodeURIComponent(folder.id)}`, { method: "PUT", body: JSON.stringify({ ...folder, order: "smallestFirst" }) })));
}
function remaining(value) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}
function statusErrors(errors) {
  return typeof errors === "number" ? Math.max(0, errors) : Array.isArray(errors) ? errors.length : 0;
}
function unavailableStatus(message) {
  return { state: "unavailable", remainingFiles: 0, remainingBytes: 0, message };
}
async function syncthingFolderStatuses(folderIds) {
  const ids = [...new Set(folderIds.filter(Boolean))];
  if (!ids.length) return {};
  if (!await connection()) return Object.fromEntries(ids.map((id) => [id, unavailableStatus("Syncthing is not configured on this node")]));
  let folders;
  try {
    folders = await request("/rest/config/folders");
  } catch {
    return Object.fromEntries(ids.map((id) => [id, unavailableStatus("Syncthing folder list is unavailable")]));
  }
  const configured = new Map(folders.map((folder) => [folder.id, folder]));
  const entries = await Promise.all(ids.map(async (id) => {
    const folder = configured.get(id);
    if (!folder) return [id, { state: "error", remainingFiles: 0, remainingBytes: 0, message: "Syncthing folder is missing from configuration" }];
    if (folder.paused) return [id, { state: "paused", remainingFiles: 0, remainingBytes: 0, message: "Syncthing folder is paused" }];
    try {
      const status = await request(`/rest/db/status?folder=${encodeURIComponent(id)}`);
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
async function syncthingFolderErrors(folderId) {
  const body = await request(`/rest/folder/errors?folder=${encodeURIComponent(folderId)}`);
  return body.errors ?? [];
}
async function syncthingPeerCaughtUp(deviceId, folderIds) {
  if (!await connection()) throw new Error("Syncthing is not configured on this node");
  const connections = await request("/rest/system/connections");
  if (!connections.connections[deviceId]?.connected) return false;
  const local = await syncthingFolderStatuses(folderIds);
  for (const id of folderIds) {
    if (local[id].state !== "synced") return false;
    const completion = await request(
      `/rest/db/completion?folder=${encodeURIComponent(id)}&device=${encodeURIComponent(deviceId)}`
    );
    if (completion.completion !== 100 || completion.needItems !== 0 || completion.needBytes !== 0 || completion.needDeletes !== 0 || completion.remoteState !== "valid") return false;
  }
  return true;
}
async function assertSyncthingFolderReady(folderId, projectIgnores = true) {
  if (!await connection()) throw new Error("Syncthing is not configured on this node");
  try {
    if (projectIgnores) await setProjectIgnores(folderId);
    const status = await request(`/rest/db/status?folder=${encodeURIComponent(folderId)}`);
    const errors = typeof status.errors === "number" ? status.errors : status.errors?.length ?? 0;
    if (status.state !== "idle" || status.needTotalItems !== 0 || status.needBytes !== 0 || errors !== 0) {
      throw new Error("Syncthing folder is not synchronized on this node");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "Syncthing folder is not synchronized on this node") throw error;
    throw new Error("Syncthing folder is not synchronized on this node");
  }
}
async function ensureSyncthingDevice(deviceId, name) {
  if (!await connection()) throw new Error("Syncthing is not configured on this node");
  const devices = await request("/rest/config/devices");
  if (devices.some((device) => device.deviceID === deviceId)) return;
  await request("/rest/config/devices", {
    method: "POST",
    body: JSON.stringify({ deviceID: deviceId, name, addresses: ["dynamic"] })
  });
}
async function removeSyncthingDevices(deviceIds, folderIds) {
  if (!deviceIds.length || !folderIds.length || !await connection()) return;
  const removed = new Set(deviceIds);
  const ownedFolders = new Set(folderIds);
  for (const folder of await listSyncthingFolders()) {
    if (!ownedFolders.has(folder.id)) continue;
    const devices = folder.devices.filter((device) => !removed.has(device.deviceID));
    if (devices.length === folder.devices.length) continue;
    await request(`/rest/config/folders/${encodeURIComponent(folder.id)}`, {
      method: "PUT",
      body: JSON.stringify({ ...folder, devices })
    });
  }
}
async function pauseSyncthingFolders(folderIds) {
  for (const folder of await listSyncthingFolders()) {
    if (!folderIds.includes(folder.id) || folder.paused) continue;
    await request(`/rest/config/folders/${encodeURIComponent(folder.id)}`, {
      method: "PUT",
      body: JSON.stringify({ ...folder, paused: true })
    });
  }
}
async function ensureTicketWorkspaceFolder(folderPath = ticketWorkspaceRoot(), peerDeviceId, peerName = peerDeviceId ?? "") {
  if (peerDeviceId) await ensureSyncthingDevice(peerDeviceId, peerName);
  await ensureSyncthingFolder(TICKET_WORKSPACE_FOLDER_ID, TICKET_WORKSPACE_FOLDER_LABEL, folderPath, peerDeviceId);
}
async function pauseEngineSyncFolders() {
  const settings = getSettings();
  const resourcePaths = /* @__PURE__ */ new Set([
    path.resolve(settings.pi.configPath),
    path.resolve(settings.claude.configPath),
    path.join(os.homedir(), ".agents")
  ]);
  const legacyIds = /* @__PURE__ */ new Set([PI_ENGINE_SYNC_FOLDER_ID, CLAUDE_ENGINE_SYNC_FOLDER_ID]);
  for (const folder of await listSyncthingFolders()) {
    const isLegacyResourceFolder = legacyIds.has(folder.id) || resourcePaths.has(path.resolve(folder.path));
    if (folder.id === AGENT_RESOURCES_FOLDER_ID || !isLegacyResourceFolder || folder.paused) continue;
    await request(`/rest/config/folders/${encodeURIComponent(folder.id)}`, {
      method: "PUT",
      body: JSON.stringify({ ...folder, paused: true })
    });
  }
}
async function ensureFolder(folderId, label, folderPath, peerDeviceId, ignorePolicy, unpause) {
  if (!await connection()) throw new Error("Syncthing is not configured on this node");
  const requestedPath = path.resolve(folderPath);
  const folders = await listSyncthingFolders();
  const existing = folders.find((folder2) => folder2.id === folderId);
  const localDeviceId = await syncthingDeviceId();
  const deviceIds = [...new Set([
    ...(existing?.devices ?? []).map((device) => device.deviceID),
    localDeviceId,
    peerDeviceId
  ].filter((deviceId) => Boolean(deviceId)))];
  const pathChanged = Boolean(existing && path.resolve(existing.path) !== requestedPath);
  const order = folderId.startsWith(WORKTREE_FOLDER_PREFIX) ? { order: "smallestFirst" } : {};
  const folder = existing ? { ...existing, ...order, label, path: requestedPath, ...unpause ? { paused: false } : {}, devices: deviceIds.map((deviceID) => ({ deviceID })) } : {
    id: folderId,
    label,
    path: requestedPath,
    type: "sendreceive",
    devices: deviceIds.map((deviceID) => ({ deviceID })),
    markerName: ".stfolder",
    ...order
  };
  if (!existing) {
    await request("/rest/config/folders", { method: "POST", body: JSON.stringify(folder) });
  } else if (pathChanged || deviceIds.length !== existing.devices.length || existing.label !== label || unpause && existing.paused || order.order && existing.order !== order.order) {
    await request(`/rest/config/folders/${encodeURIComponent(folderId)}`, { method: "PUT", body: JSON.stringify(folder) });
  }
  if (ignorePolicy === "project") await setProjectIgnores(folderId);
  if (ignorePolicy === "resources") await setIgnores(folderId, agentResourceIgnorePatterns, false);
}
async function ensureSharedProjectFolder(folderId, label, folderPath, peerDeviceId) {
  const folders = await listSyncthingFolders();
  const canonical = folders.find((folder) => folder.id === folderId);
  if (canonical && path.resolve(canonical.path) !== path.resolve(folderPath)) throw new Error("Shared folder ID belongs to a different local path");
  const prior = folders.find((folder) => path.resolve(folder.path) === path.resolve(folderPath) && folder.id !== folderId);
  if (prior) {
    await request(`/rest/config/folders/${encodeURIComponent(prior.id)}`, { method: "DELETE" });
    if (!canonical) await request("/rest/config/folders", { method: "POST", body: JSON.stringify({ ...prior, id: folderId, label }) });
  }
  await ensureSyncthingFolder(folderId, label, folderPath, peerDeviceId);
}
async function resumeSharedProjectFolder(folderId) {
  const folder = (await listSyncthingFolders()).find((candidate) => candidate.id === folderId);
  if (!folder) return;
  if (folder.paused) await request(`/rest/config/folders/${encodeURIComponent(folderId)}`, {
    method: "PUT",
    body: JSON.stringify({ ...folder, paused: false })
  });
}
async function ensureSyncthingFolder(folderId, label, folderPath, peerDeviceId) {
  await ensureFolder(folderId, label, folderPath, peerDeviceId, "project", false);
}
async function ensureAgentResourcesFolder(folderPath, peerDeviceId, peerName = peerDeviceId ?? "") {
  if (peerDeviceId) await ensureSyncthingDevice(peerDeviceId, peerName);
  await mkdir(path.resolve(folderPath), { recursive: true });
  await ensureFolder(AGENT_RESOURCES_FOLDER_ID, AGENT_RESOURCES_FOLDER_LABEL, folderPath, peerDeviceId, "resources", true);
}
async function ensureConversationSyncFolders(folders, peerDeviceId, peerName = peerDeviceId ?? "") {
  if (peerDeviceId) await ensureSyncthingDevice(peerDeviceId, peerName);
  for (const folder of folders) {
    await mkdir(path.resolve(folder.path), { recursive: true });
    await ensureFolder(folder.id, folder.label, folder.path, peerDeviceId, "none", true);
  }
}
export {
  assertSyncthingFolderReady,
  discoverSyncthingConfig,
  ensureAgentResourcesFolder,
  ensureConversationSyncFolders,
  ensureSharedProjectFolder,
  ensureSyncthingDevice,
  ensureSyncthingFolder,
  ensureTicketWorkspaceFolder,
  listSyncthingFolders,
  pauseEngineSyncFolders,
  pauseSyncthingFolders,
  reconcileSyncthingProjectFolders,
  removeSyncthingDevices,
  rescanSyncthingFolder,
  resetSyncthingConnection,
  resumeSharedProjectFolder,
  syncthingDeviceId,
  syncthingFolderErrors,
  syncthingFolderStatuses,
  syncthingPeerCaughtUp
};
