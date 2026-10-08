import os from "node:os";
import { z } from "zod";
import { appVersion } from "./changelog.js";
import { ntfyTopicName } from "./ntfy-admin.js";
import { getNtfyService } from "./ntfy.js";
import { publishNtfyMessage, savedNtfyServer } from "./ntfy-publish.js";
import { save, settingsDatabase, value } from "./settings-store.js";
const CHANNELS = ["client", "backend"];
const CHANNEL_LABELS = { client: "Client errors", backend: "Backend errors" };
const SETTINGS_KEY = "errorReporting";
const REPORT_WINDOW_MS = 10 * 6e4;
const MAX_REPORTS_PER_WINDOW = 20;
const MESSAGE_LIMIT = 3800;
const destinationSchema = z.object({
  enabled: z.boolean(),
  serviceId: z.string().uuid().nullable(),
  topic: z.string().max(64)
}).strict();
const errorReportingSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Backend errors use the client destination when both channels are on. */
  sameDestination: z.boolean(),
  client: destinationSchema,
  backend: destinationSchema
}).strict();
const DEFAULT_SETTINGS = {
  enabled: false,
  sameDestination: true,
  client: { enabled: true, serviceId: null, topic: "" },
  backend: { enabled: true, serviceId: null, topic: "" }
};
class ErrorReportingSettingsError extends Error {
}
function getErrorReportingSettings() {
  const stored = value(SETTINGS_KEY);
  if (!stored) return structuredClone(DEFAULT_SETTINGS);
  const parsed = errorReportingSettingsSchema.safeParse(JSON.parse(stored));
  return parsed.success ? parsed.data : structuredClone(DEFAULT_SETTINGS);
}
function sourceFor(channel, settings) {
  return channel === "backend" && settings.sameDestination && settings.client.enabled ? settings.client : settings[channel];
}
function errorDestination(channel, settings = getErrorReportingSettings()) {
  if (!settings.enabled || !settings[channel].enabled) return null;
  const source = sourceFor(channel, settings);
  return source.serviceId && source.topic ? { serviceId: source.serviceId, topic: source.topic } : null;
}
function updateErrorReportingSettings(input) {
  const settings = errorReportingSettingsSchema.parse(input);
  if (settings.enabled) {
    if (!settings.client.enabled && !settings.backend.enabled) throw new ErrorReportingSettingsError("Choose client errors, backend errors, or both");
    for (const channel of CHANNELS) {
      if (!settings[channel].enabled) continue;
      const source = sourceFor(channel, settings);
      if (!source.serviceId || !getNtfyService(source.serviceId)) throw new ErrorReportingSettingsError(`${CHANNEL_LABELS[channel]} need a saved ntfy server`);
      if (!ntfyTopicName.safeParse(source.topic).success) throw new ErrorReportingSettingsError(`${CHANNEL_LABELS[channel]} need a topic of 1 to 64 letters, digits, - or _`);
    }
  }
  save(settingsDatabase(), SETTINGS_KEY, JSON.stringify(settings));
  throttles.clear();
  return settings;
}
const throttles = /* @__PURE__ */ new Map();
function errorSignature(summary) {
  return summary.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>").replace(/\d+/g, "#").slice(0, 300);
}
function admit(channel, summary, now) {
  let throttle = throttles.get(channel);
  if (!throttle || now - throttle.windowStartedAt >= REPORT_WINDOW_MS) {
    throttle = { windowStartedAt: now, sent: 0, withheld: throttle?.withheld ?? 0, recent: throttle?.recent ?? /* @__PURE__ */ new Map() };
    throttles.set(channel, throttle);
  }
  for (const [key, at] of throttle.recent) if (now - at >= REPORT_WINDOW_MS) throttle.recent.delete(key);
  const signature = errorSignature(summary);
  if (throttle.recent.has(signature) || throttle.sent >= MAX_REPORTS_PER_WINDOW) {
    throttle.withheld += 1;
    return { admitted: false, withheld: throttle.withheld };
  }
  throttle.recent.set(signature, now);
  throttle.sent += 1;
  const withheld = throttle.withheld;
  throttle.withheld = 0;
  return { admitted: true, withheld };
}
async function reportError(channel, report, now = Date.now()) {
  try {
    const destination = errorDestination(channel);
    if (!destination) return false;
    const { admitted, withheld } = admit(channel, report.summary, now);
    if (!admitted) return false;
    const lines = [
      report.summary,
      ...report.source ? [`Source: ${report.source}`] : [],
      `Node: ${os.hostname()} \xB7 Joint Bob ${appVersion()}`,
      ...withheld ? [`${withheld} repeated or excess error${withheld === 1 ? " was" : "s were"} not sent since the last report.`] : [],
      ...report.detail ? ["", report.detail] : []
    ];
    const message = lines.join("\n");
    await publishNtfyMessage(savedNtfyServer(destination.serviceId), destination.topic, {
      title: `Joint Bob ${channel === "client" ? "UI" : "backend"} error`,
      message: message.length > MESSAGE_LIMIT ? `${message.slice(0, MESSAGE_LIMIT)}
\u2026 truncated` : message,
      tags: [channel === "client" ? "warning" : "rotating_light"]
    });
    return true;
  } catch (error) {
    console.warn(`Could not forward a ${channel} error to ntfy: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
export {
  ErrorReportingSettingsError,
  MAX_REPORTS_PER_WINDOW,
  REPORT_WINDOW_MS,
  errorDestination,
  errorReportingSettingsSchema,
  getErrorReportingSettings,
  reportError,
  updateErrorReportingSettings
};
