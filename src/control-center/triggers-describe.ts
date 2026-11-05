/**
 * What an incoming webhook call says, in a title and a line, taken from the payload with a few well-known shapes
 * (GitHub, GitLab, Alertmanager, CloudWatch, Stripe) and then any common field. The payload comes from an outside
 * sender: it is only ever read as data, every piece is cut to size, and control and direction characters are removed.
 */
export const TITLE_LIMIT = 120;
export const SUMMARY_LIMIT = 200;
/** What is kept of the call itself, for the rating and for a read-only investigation. */
export const EXCERPT_LIMIT = 4_000;
const HEADER_LIMIT = 200;
const SNS_MESSAGE_LIMIT = 100_000;

export interface TriggerText { title: string; summary: string; text: string }
interface Headline { title: string; summary: string }
export interface DescribedCall { headers: Record<string, string>; body: string; data?: unknown }

// Control characters, line and paragraph separators, zero-width marks and the bidirectional overrides.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]+/g;

/** One line of at most `limit` characters; a cut ends in an ellipsis. */
export function oneLine(value: string, limit: number): string {
  const line = value.replace(INVISIBLE, " ").replace(/\s+/g, " ").trim();
  return line.length > limit ? `${line.slice(0, limit - 1).trimEnd()}…` : line;
}

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The value at a dot path when it is a non-empty string, a number or a boolean. Own properties only. */
function at(data: unknown, path: string): string | undefined {
  let value = data;
  for (const key of path.split(".")) {
    if (!isObject(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return String(value);
  return typeof value === "string" && value.trim() ? value : undefined;
}

const first = (data: unknown, paths: string[]): string | undefined => {
  for (const path of paths) { const found = at(data, path); if (found !== undefined) return found; }
  return undefined;
};

const join = (parts: Array<string | undefined>, separator: string): string => parts.filter((part): part is string => Boolean(part)).join(separator);

const GITHUB_EVENTS: Record<string, string> = {
  issues: "Issue", issue_comment: "Issue comment", pull_request: "Pull request", pull_request_review: "Pull request review",
  pull_request_review_comment: "Pull request comment", workflow_run: "Workflow run", workflow_job: "Workflow job", check_run: "Check run", check_suite: "Check suite",
  push: "Push", release: "Release", discussion: "Discussion", deployment_status: "Deployment", security_advisory: "Security advisory",
  dependabot_alert: "Dependabot alert", code_scanning_alert: "Code scanning alert", secret_scanning_alert: "Secret scanning alert", ping: "Ping",
};

function github(event: string, data: unknown): Headline {
  const kind = GITHUB_EVENTS[event] ?? event.replace(/_/g, " ").replace(/^./, (letter) => letter.toUpperCase());
  const number = first(data, ["issue.number", "pull_request.number", "number", "discussion.number"]);
  const action = at(data, "action");
  const outcome = first(data, ["workflow_run.conclusion", "workflow_job.conclusion", "check_run.conclusion", "check_suite.conclusion", "deployment_status.state"]);
  const subject = first(data, ["issue.title", "pull_request.title", "discussion.title", "release.name", "release.tag_name", "workflow_run.name", "workflow_job.name", "check_run.name",
    "security_advisory.summary", "alert.rule.description", "alert.security_advisory.summary", "head_commit.message", "zen"]);
  const where = at(data, "repository.full_name");
  const who = first(data, ["sender.login", "pusher.name"]);
  const ref = at(data, "ref");
  const head = join([kind + (number ? ` #${number}` : ""), action, outcome], " ");
  const branch = event === "push" && ref ? ` to ${ref.replace(/^refs\/(heads|tags)\//, "")}` : "";
  return {
    title: join([head + branch, subject ? oneLine(subject.split("\n")[0], TITLE_LIMIT) : undefined], ": "),
    summary: join([where, who ? `by ${who}` : undefined], " · "),
  };
}

function gitlab(kind: string, data: unknown): Headline {
  const subject = first(data, ["object_attributes.title", "object_attributes.name", "commit.title"]);
  const action = first(data, ["object_attributes.action", "object_attributes.status", "object_attributes.state"]);
  const who = first(data, ["user.username", "user_username", "user_name"]);
  return {
    title: join([`GitLab ${kind.replace(/_/g, " ")}${action ? ` ${action}` : ""}`, subject], ": "),
    summary: join([first(data, ["project.path_with_namespace", "project.name"]), who ? `by ${who}` : undefined], " · "),
  };
}

function alertmanager(data: Json): Headline | undefined {
  const alerts = data.alerts;
  if (!Array.isArray(alerts) || !alerts.length) return undefined;
  const lead = alerts[0];
  const name = first(lead, ["labels.alertname"]);
  if (!name) return undefined;
  const status = at(data, "status") ?? at(lead, "status");
  return {
    title: `${status ? `Alert ${status}` : "Alert"}: ${name}${alerts.length > 1 ? ` (+${alerts.length - 1} more)` : ""}`,
    summary: first(lead, ["annotations.summary", "annotations.description", "labels.instance", "labels.job"]) ?? "",
  };
}

function alarm(data: unknown): Headline | undefined {
  const name = first(data, ["AlarmName", "alarmName", "alarm_name", "alarm"]);
  if (!name) return undefined;
  const state = first(data, ["NewStateValue", "newStateValue", "state", "status"]);
  return { title: `Alarm${state ? ` ${state}` : ""}: ${name}`, summary: first(data, ["NewStateReason", "reason", "message", "AlarmDescription", "description"]) ?? "" };
}

function stripe(data: unknown): Headline | undefined {
  const type = at(data, "type");
  const object = isObject(data) && isObject(data.data) ? data.data.object : undefined;
  if (!type || !at(data, "id")?.startsWith("evt_") || !isObject(object)) return undefined;
  const amount = first(object, ["amount", "amount_due"]);
  const currency = at(object, "currency");
  return {
    title: `Stripe ${type}${at(data, "livemode") === "true" ? "" : " (test mode)"}`,
    summary: join([at(object, "object"), at(object, "id"), amount && currency ? `${amount} ${currency}` : undefined], " · "),
  };
}

const TITLE_FIELDS = ["title", "subject", "alert", "alertname", "name", "event", "event_type", "type", "message", "text"];
const STATE_FIELDS = ["state", "status", "action"];
const SUMMARY_FIELDS = ["summary", "description", "message", "text", "body", "reason"];

function generic(data: unknown): Headline | undefined {
  if (!isObject(data)) return undefined;
  const title = first(data, TITLE_FIELDS);
  if (!title) return undefined;
  const state = first(data, STATE_FIELDS);
  const summary = SUMMARY_FIELDS.map((field) => at(data, field)).find((value) => value !== undefined && oneLine(value, TITLE_LIMIT) !== oneLine(title, TITLE_LIMIT));
  return { title: `${oneLine(title.split("\n")[0], TITLE_LIMIT)}${state && state !== title ? ` (${state})` : ""}`, summary: summary ?? "" };
}

/** An Amazon SNS delivery wraps the alarm in a JSON string under `Message`. */
function unwrapSns(data: unknown): unknown {
  const message = isObject(data) && at(data, "Type") === "Notification" ? at(data, "Message") : undefined;
  if (message === undefined || message.length > SNS_MESSAGE_LIMIT) return data;
  try {
    const inner: unknown = JSON.parse(message);
    return isObject(inner) ? { ...inner, Subject: at(data, "Subject") } : data;
  } catch { return data; }
}

function firstLines(body: string): string {
  return body.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 3).join(" · ");
}

/** Headers that say what kind of event this is; the rest say nothing a person or a rating needs. */
const KIND_HEADER = /^x-[a-z0-9-]*(event|type|action)[a-z0-9-]*$/;

function excerpt(webhookName: string, call: DescribedCall): string {
  const headers = Object.entries(call.headers).filter(([name]) => KIND_HEADER.test(name)).map(([name, value]) => `${name}: ${oneLine(value, HEADER_LIMIT)}`);
  const body = call.body.replace(/\u0000/g, "").trim();
  const text = [`Webhook: ${oneLine(webhookName, TITLE_LIMIT)}`, ...headers, ...body ? ["", body] : ["", "(empty payload)"]].join("\n");
  return text.length > EXCERPT_LIMIT ? `${text.slice(0, EXCERPT_LIMIT)}\n… (cut: the call is longer than what is kept)` : text;
}

/** A title, a summary and a bounded excerpt for one accepted call. Never throws on whatever the sender sent. */
export function describeCall(webhookName: string, call: DescribedCall): TriggerText {
  const data = unwrapSns(call.data);
  const headerEvent = call.headers["x-github-event"] || undefined;
  const gitlabKind = at(data, "object_kind") ?? call.headers["x-gitlab-event"]?.replace(/\s+hook$/i, "").toLowerCase().replace(/\s+/g, "_");
  const found = (headerEvent ? github(headerEvent, data) : undefined)
    ?? (gitlabKind ? gitlab(gitlabKind, data) : undefined)
    ?? (isObject(data) ? alertmanager(data) : undefined)
    ?? alarm(data)
    ?? stripe(data)
    ?? generic(data);
  const subject = isObject(data) ? at(data, "Subject") : undefined;
  const title = oneLine(found?.title || subject || webhookName, TITLE_LIMIT);
  // With no known shape the first lines of the payload are the summary.
  const summary = oneLine(found ? found.summary : firstLines(call.body) || "Empty payload", SUMMARY_LIMIT);
  return { title, summary, text: excerpt(webhookName, call) };
}
