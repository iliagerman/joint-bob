import { randomUUID } from "node:crypto";
import { decrypt, save, setting, settingsDatabase } from "./settings-store.js";

/** A user-defined ntfy server. The token grants publish access, so the whole
    list is stored encrypted in the node settings store. */
export interface NtfyService {
  id: string;
  name: string;
  url: string;
  token: string;
}

/** What the UI sees: the token itself never leaves the node. */
export interface NtfyServiceView {
  id: string;
  name: string;
  url: string;
  hasToken: boolean;
  isDefault: boolean;
}

interface NtfyConfig {
  services: NtfyService[];
  defaultServiceId: string | null;
}

const SERVICES_KEY = "ntfy.services";

function readConfig(): NtfyConfig {
  const found = setting(SERVICES_KEY);
  if (!found) return { services: [], defaultServiceId: null };
  const stored = JSON.parse(found.isSecret ? decrypt(found.value) : found.value) as NtfyConfig | NtfyService[];
  if (Array.isArray(stored)) return { services: stored, defaultServiceId: stored[0]?.id ?? null };
  const defaultServiceId = stored.services.some(({ id }) => id === stored.defaultServiceId) ? stored.defaultServiceId : stored.services[0]?.id ?? null;
  return { services: stored.services, defaultServiceId };
}

function writeConfig(config: NtfyConfig): void {
  save(settingsDatabase(), SERVICES_KEY, JSON.stringify(config), true);
}

function view(service: NtfyService, defaultServiceId: string | null): NtfyServiceView {
  return { id: service.id, name: service.name, url: service.url, hasToken: service.token !== "", isDefault: service.id === defaultServiceId };
}

export function listNtfyServices(): NtfyServiceView[] {
  const config = readConfig();
  return config.services.map((service) => view(service, config.defaultServiceId));
}

export function getNtfyService(id: string): NtfyService | undefined {
  return readConfig().services.find((service) => service.id === id);
}

export function addNtfyService(name: string, url: string, token: string): NtfyServiceView {
  const config = readConfig();
  const service: NtfyService = { id: randomUUID(), name, url: url.replace(/\/+$/, ""), token };
  const defaultServiceId = config.defaultServiceId ?? service.id;
  writeConfig({ services: [...config.services, service], defaultServiceId });
  return view(service, defaultServiceId);
}

export function importNtfyService(service: NtfyService): NtfyServiceView {
  const config = readConfig();
  const imported = { ...service, url: service.url.replace(/\/+$/, "") };
  const services = [...config.services.filter(({ id }) => id !== service.id), imported];
  const defaultServiceId = config.defaultServiceId ?? service.id;
  writeConfig({ services, defaultServiceId });
  return view(imported, defaultServiceId);
}

export function setDefaultNtfyService(id: string): boolean {
  const config = readConfig();
  if (!config.services.some((service) => service.id === id)) return false;
  writeConfig({ ...config, defaultServiceId: id });
  return true;
}

export function deleteNtfyService(id: string): boolean {
  const config = readConfig();
  const services = config.services.filter((service) => service.id !== id);
  if (services.length === config.services.length) return false;
  const defaultServiceId = config.defaultServiceId === id ? services[0]?.id ?? null : config.defaultServiceId;
  writeConfig({ services, defaultServiceId });
  return true;
}
