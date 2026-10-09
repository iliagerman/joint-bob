import { randomUUID } from "node:crypto";
import { decrypt, save, setting, settingsDatabase } from "./settings-store.js";
const SERVICES_KEY = "ntfy.services";
function readConfig() {
  const found = setting(SERVICES_KEY);
  if (!found) return { services: [], defaultServiceId: null };
  const stored = JSON.parse(found.isSecret ? decrypt(found.value) : found.value);
  if (Array.isArray(stored)) return { services: stored, defaultServiceId: stored[0]?.id ?? null };
  const defaultServiceId = stored.services.some(({ id }) => id === stored.defaultServiceId) ? stored.defaultServiceId : stored.services[0]?.id ?? null;
  return { services: stored.services, defaultServiceId };
}
function writeConfig(config) {
  save(settingsDatabase(), SERVICES_KEY, JSON.stringify(config), true);
}
function view(service, defaultServiceId) {
  return { id: service.id, name: service.name, url: service.url, hasToken: service.token !== "", isDefault: service.id === defaultServiceId };
}
function listNtfyServices() {
  const config = readConfig();
  return config.services.map((service) => view(service, config.defaultServiceId));
}
function getNtfyService(id) {
  return readConfig().services.find((service) => service.id === id);
}
function addNtfyService(name, url, token) {
  const config = readConfig();
  const service = { id: randomUUID(), name, url: url.replace(/\/+$/, ""), token, updatedAt: Date.now() };
  const defaultServiceId = config.defaultServiceId ?? service.id;
  writeConfig({ services: [...config.services, service], defaultServiceId });
  return view(service, defaultServiceId);
}
function importNtfyService(service) {
  const config = readConfig();
  const imported = { ...service, url: service.url.replace(/\/+$/, ""), updatedAt: service.updatedAt ?? Date.now() };
  const services = [...config.services.filter(({ id }) => id !== service.id), imported];
  const defaultServiceId = config.defaultServiceId ?? service.id;
  writeConfig({ services, defaultServiceId });
  return view(imported, defaultServiceId);
}
function importNewerNtfyService(service) {
  const current = getNtfyService(service.id);
  if (current && (current.updatedAt ?? 0) >= service.updatedAt) return false;
  importNtfyService(service);
  return true;
}
function updateNtfyService(id, changes) {
  const config = readConfig();
  const current = config.services.find((service) => service.id === id);
  if (!current) return void 0;
  const updated = { ...current, ...changes.name === void 0 ? {} : { name: changes.name }, ...changes.url === void 0 ? {} : { url: changes.url.replace(/\/+$/, "") }, ...changes.token === void 0 ? {} : { token: changes.token }, updatedAt: Date.now() };
  writeConfig({ ...config, services: config.services.map((service) => service.id === id ? updated : service) });
  return view(updated, config.defaultServiceId);
}
function setDefaultNtfyService(id) {
  const config = readConfig();
  if (!config.services.some((service) => service.id === id)) return false;
  writeConfig({ ...config, defaultServiceId: id });
  return true;
}
function deleteNtfyService(id) {
  const config = readConfig();
  const services = config.services.filter((service) => service.id !== id);
  if (services.length === config.services.length) return false;
  const defaultServiceId = config.defaultServiceId === id ? services[0]?.id ?? null : config.defaultServiceId;
  writeConfig({ services, defaultServiceId });
  return true;
}
export {
  addNtfyService,
  deleteNtfyService,
  getNtfyService,
  importNewerNtfyService,
  importNtfyService,
  listNtfyServices,
  setDefaultNtfyService,
  updateNtfyService
};
