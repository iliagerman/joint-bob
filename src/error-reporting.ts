import os from "node:os";
import { z } from "zod";
import { appVersion } from "./changelog.js";
import { ntfyTopicName } from "./ntfy-admin.js";
import { getNtfyService } from "./ntfy.js";
import { publishNtfyMessage, savedNtfyServer } from "./ntfy-publish.js";
import { save, settingsDatabase, value } from "./settings-store.js";

export type ErrorChannel = "client" | "backend";
const CHANNELS: ErrorChannel[] = ["client", "backend"];
const CHANNEL_LABELS: Record<ErrorChannel, string> = { client: "Client errors", backend: "Backend errors" };
const SETTINGS_KEY = "errorReporting";
/** One report per distinct error in this window, and at most MAX_REPORTS_PER_WINDOW per channel. */
export const REPORT_WINDOW_MS = 10 * 60_000;
export const MAX_REPORTS_PER_WINDOW = 20;
const MESSAGE_LIMIT = 3_800;

const destinationSchema = z.object({
  enabled: z.boolean(),
  serviceId: z.string().uuid().nullable(),
  topic: z.string().max(64),
}).strict();

export const errorReportingSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Backend errors use the client destination when both channels are on. */
  sameDestination: z.boolean(),
  client: destinationSchema,
  backend: destinationSchema,
}).strict();

export type ErrorReportingSettings = z.infer<typeof errorReportingSettingsSchema>;

const DEFAULT_SETTINGS: ErrorReportingSettings = {
  enabled: false,
  sameDestination: true,
  client: { enabled: true, serviceId: null, topic: "" },
  backend: { enabled: true, serviceId: null, topic: "" },
};

export class ErrorReportingSettingsError extends Error {}

export function getErrorReportingSettings(): ErrorReportingSettings {
  const stored = value(SETTINGS_KEY);
  if (!stored) return structuredClone(DEFAULT_SETTINGS);
  const parsed = errorReportingSettingsSchema.safeParse(JSON.parse(stored));
  return parsed.success ? parsed.data : structuredClone(DEFAULT_SETTINGS);
}

function sourceFor(channel: ErrorChannel, settings: ErrorReportingSettings): ErrorReportingSettings["client"] {
  return channel === "backend" && settings.sameDestination && settings.client.enabled ? settings.client : settings[channel];
}

/** Where a channel's errors go, or null when that channel is off. */
export function errorDestination(channel: ErrorChannel, settings = getErrorReportingSettings()): { serviceId: string; topic: string } | null {
  if (!settings.enabled || !settings[channel].enabled) return null;
  const source = sourceFor(channel, settings);
  return source.serviceId && source.topic ? { serviceId: source.serviceId, topic: source.topic } : null;
}

export function updateErrorReportingSettings(input: unknown): ErrorReportingSettings {
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

interface Throttle { windowStartedAt: number; sent: number; withheld: number; recent: Map<string, number> }
const throttles = new Map<ErrorChannel, Throttle>();

/** Errors that differ only in ids, counts or ports are one error. */
function errorSignature(summary: string): string {
  return summary.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>").replace(/\d+/g, "#").slice(0, 300);
}

/** Counts this report against its channel's window; false means it is withheld. */
function admit(channel: ErrorChannel, summary: string, now: number): { admitted: boolean; withheld: number } {
  let throttle = throttles.get(channel);
  if (!throttle || now - throttle.windowStartedAt >= REPORT_WINDOW_MS) {
    throttle = { windowStartedAt: now, sent: 0, withheld: throttle?.withheld ?? 0, recent: throttle?.recent ?? new Map() };
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

export interface ErrorReport {
  summary: string;
  detail?: string;
  /** Where the error came from: a page URL, a route, a component. */
  source?: string;
}

/** Publishes one error to the channel's ntfy topic. Never throws; a failed delivery is logged as a warning. */
export async function reportError(channel: ErrorChannel, report: ErrorReport, now = Date.now()): Promise<boolean> {
  try {
    const destination = errorDestination(channel);
    if (!destination) return false;
    const { admitted, withheld } = admit(channel, report.summary, now);
    if (!admitted) return false;
    const lines = [
      report.summary,
      ...(report.source ? [`Source: ${report.source}`] : []),
      `Node: ${os.hostname()} · Joint Bob ${appVersion()}`,
      ...(withheld ? [`${withheld} repeated or excess error${withheld === 1 ? " was" : "s were"} not sent since the last report.`] : []),
      ...(report.detail ? ["", report.detail] : []),
    ];
    const message = lines.join("\n");
    await publishNtfyMessage(savedNtfyServer(destination.serviceId), destination.topic, {
      title: `Joint Bob ${channel === "client" ? "UI" : "backend"} error`,
      message: message.length > MESSAGE_LIMIT ? `${message.slice(0, MESSAGE_LIMIT)}\n… truncated` : message,
      tags: [channel === "client" ? "warning" : "rotating_light"],
    });
    return true;
  } catch (error) {
    // A warning, not an error: an error here would be reported again.
    console.warn(`Could not forward a ${channel} error to ntfy: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}
