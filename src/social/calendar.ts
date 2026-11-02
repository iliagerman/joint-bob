import { createHash, createSign } from "node:crypto";
import { readFileSync } from "node:fs";

// The only calendar access a public action has: free/busy times and creating one event.
// Credentials come from the Google account attached to the assistant, on its own machine.

const TOKEN_ENDPOINT = () => process.env.JOINT_BOB_GOOGLE_TOKEN_ENDPOINT || "https://oauth2.googleapis.com/token";
const CALENDAR_ENDPOINT = () => process.env.JOINT_BOB_GOOGLE_CALENDAR_ENDPOINT || "https://www.googleapis.com/calendar/v3";
const SCOPE = "https://www.googleapis.com/auth/calendar";
const TIMEOUT_MS = 15_000;

export class CalendarAccessError extends Error {}
/** The service may or may not have applied the change; never retry it blindly. */
export class CalendarUncertainError extends Error {}

interface AuthorizedUser { type: "authorized_user"; client_id: string; client_secret: string; refresh_token: string }
interface ServiceAccount { type: "service_account"; client_email: string; private_key: string; token_uri?: string }

function credentialsFrom(environment: Record<string, string | undefined>): AuthorizedUser | ServiceAccount {
  let raw = environment.GOOGLE_CREDENTIALS_JSON;
  if (!raw && environment.GOOGLE_APPLICATION_CREDENTIALS) {
    try { raw = readFileSync(environment.GOOGLE_APPLICATION_CREDENTIALS, "utf8"); }
    catch { throw new CalendarAccessError("The Google account's credential file can't be read on this machine"); }
  }
  if (!raw) throw new CalendarAccessError("Attach a Google account to this assistant under Resources → Secrets");
  let parsed: { type?: string };
  try { parsed = JSON.parse(raw) as { type?: string }; } catch { throw new CalendarAccessError("The attached Google credential isn't valid JSON"); }
  if (parsed.type === "authorized_user" || parsed.type === "service_account") return parsed as AuthorizedUser | ServiceAccount;
  throw new CalendarAccessError("The attached Google credential must be an authorized user or a service account");
}

const base64url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

async function accessToken(credentials: AuthorizedUser | ServiceAccount, subject?: string): Promise<string> {
  const body = new URLSearchParams();
  if (credentials.type === "authorized_user") {
    body.set("grant_type", "refresh_token"); body.set("client_id", credentials.client_id);
    body.set("client_secret", credentials.client_secret); body.set("refresh_token", credentials.refresh_token);
  } else {
    const issued = Math.floor(Date.now() / 1000);
    const claims = { iss: credentials.client_email, scope: SCOPE, aud: TOKEN_ENDPOINT(), iat: issued, exp: issued + 3600, ...(subject ? { sub: subject } : {}) };
    const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}`;
    const signature = createSign("RSA-SHA256").update(unsigned).sign(credentials.private_key);
    body.set("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"); body.set("assertion", `${unsigned}.${base64url(signature)}`);
  }
  let response: Response;
  try { response = await fetch(TOKEN_ENDPOINT(), { method: "POST", body, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch { throw new CalendarAccessError("Google sign-in is unreachable"); }
  const answer = await response.json().catch(() => ({})) as { access_token?: string; error?: string };
  if (!response.ok || !answer.access_token) throw new CalendarAccessError(`Google refused the attached account (${answer.error ?? response.status}). Reconnect it under Resources → Secrets.`);
  return answer.access_token;
}

export interface BusyBlock { start: Date; end: Date }
export interface CalendarClient {
  timeZone: string;
  busy(start: Date, end: Date): Promise<BusyBlock[]>;
  /** Idempotent: the event ID comes from the request, so a repeat finds the first event. */
  create(input: { requestId: string; start: Date; end: Date; summary: string; description: string }): Promise<{ id: string; link: string | null; existed: boolean }>;
}

/** Google event IDs use base32hex characters; a hex digest is a valid one. */
export function eventIdFor(requestId: string): string {
  return `jb${createHash("sha256").update(`joint-bob-social:${requestId}`).digest("hex").slice(0, 40)}`;
}

export async function calendarClient(environment: Record<string, string | undefined>): Promise<CalendarClient> {
  const credentials = credentialsFrom(environment);
  const token = await accessToken(credentials, environment.GOOGLE_CALENDAR_SUBJECT);
  const calendarId = encodeURIComponent(environment.GOOGLE_CALENDAR_ID || "primary");
  const call = async (path: string, init: RequestInit = {}) => {
    try { return await fetch(`${CALENDAR_ENDPOINT()}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) }); }
    catch { throw new CalendarAccessError("Google Calendar is unreachable"); }
  };
  const settings = await call(`/calendars/${calendarId}`);
  if (!settings.ok) throw new CalendarAccessError(`Google Calendar refused access (${settings.status})`);
  const { timeZone } = await settings.json() as { timeZone?: string };
  return {
    timeZone: timeZone || "UTC",
    async busy(start, end) {
      const response = await call("/freeBusy", { method: "POST", body: JSON.stringify({ timeMin: start.toISOString(), timeMax: end.toISOString(), items: [{ id: decodeURIComponent(calendarId) }] }) });
      if (!response.ok) throw new CalendarAccessError(`Google Calendar free/busy failed (${response.status})`);
      const answer = await response.json() as { calendars?: Record<string, { busy?: Array<{ start: string; end: string }>; errors?: unknown[] }> };
      const entry = Object.values(answer.calendars ?? {})[0];
      if (!entry || entry.errors?.length) throw new CalendarAccessError("Google Calendar didn't return free/busy times");
      return (entry.busy ?? []).map(block => ({ start: new Date(block.start), end: new Date(block.end) }));
    },
    async create(input) {
      const id = eventIdFor(input.requestId);
      let response: Response;
      try {
        response = await fetch(`${CALENDAR_ENDPOINT()}/calendars/${calendarId}/events?sendUpdates=none`, {
          method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS),
          body: JSON.stringify({ id, summary: input.summary, description: input.description, start: { dateTime: input.start.toISOString() }, end: { dateTime: input.end.toISOString() } }),
        });
      } catch { throw new CalendarUncertainError("Google Calendar didn't confirm the event"); }
      if (response.status === 409) {
        const existing = await call(`/calendars/${calendarId}/events/${id}`);
        if (!existing.ok) throw new CalendarUncertainError("Google Calendar reported the event exists but didn't return it");
        const event = await existing.json() as { id: string; htmlLink?: string };
        return { id: event.id, link: event.htmlLink ?? null, existed: true };
      }
      if (response.status >= 500) throw new CalendarUncertainError(`Google Calendar answered ${response.status} without confirming the event`);
      if (!response.ok) throw new CalendarAccessError(`Google Calendar refused the event (${response.status})`);
      const event = await response.json() as { id: string; htmlLink?: string };
      return { id: event.id, link: event.htmlLink ?? null, existed: false };
    },
  };
}
