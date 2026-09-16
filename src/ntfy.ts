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
}

const SERVICES_KEY = "ntfy.services";

function readServices(): NtfyService[] {
  const found = setting(SERVICES_KEY);
  if (!found) return [];
  return JSON.parse(found.isSecret ? decrypt(found.value) : found.value) as NtfyService[];
}

function writeServices(services: NtfyService[]): void {
  save(settingsDatabase(), SERVICES_KEY, JSON.stringify(services), true);
}

function view(service: NtfyService): NtfyServiceView {
  return { id: service.id, name: service.name, url: service.url, hasToken: service.token !== "" };
}

export function listNtfyServices(): NtfyServiceView[] {
  return readServices().map(view);
}

export function getNtfyService(id: string): NtfyService | undefined {
  return readServices().find((service) => service.id === id);
}

export function addNtfyService(name: string, url: string, token: string): NtfyServiceView {
  const service: NtfyService = { id: randomUUID(), name, url: url.replace(/\/+$/, ""), token };
  writeServices([...readServices(), service]);
  return view(service);
}

export function deleteNtfyService(id: string): boolean {
  const services = readServices();
  const remaining = services.filter((service) => service.id !== id);
  if (remaining.length === services.length) return false;
  writeServices(remaining);
  return true;
}
