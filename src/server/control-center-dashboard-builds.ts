import type { AuthSession } from "../auth.js";
import { getClusterNode } from "../cluster.js";
import { registerBobAction } from "../control-center/bob-actions.js";
import { appendBobMessage, bobDatabase } from "../control-center/bob-store.js";
import { recordBobDashboard } from "../control-center/dashboards-made.js";
import type { DashboardEntity } from "../dashboards/contract.js";
import { resolveEntity } from "../dashboards/entity.js";
import { checkDraft, draftExists, promoteDraft, readCreatorMessages, removeDashboardFiles } from "../dashboards/files.js";
import { forgetDraftRefresh, runningState, startCreatorTurn, startRefresh } from "../dashboards/service.js";
import { activateDashboard, createDashboard, deleteDashboard, getDashboard, recordSavedDefinition, type DashboardRecord } from "../dashboards/store.js";
import { announceDashboardChanges } from "./dashboard-sharing.js";

/** What a dashboard Bob builds is for: a project, or the person's own workspace. */
export interface BuildTarget {
  entity: Extract<DashboardEntity, { kind: "project" | "workspace" }>;
  /** The project the dashboard's agent and scripts run in. */
  hostProjectId: string;
  /** What the person calls it: the project's name, or the workspace's. */
  label: string;
  /** The project the chat message belongs to; null for a dashboard that is not tied to one. */
  projectId: string | null;
  projectName: string | null;
}

export const OPEN_DASHBOARDS_ACTION = "dashboards.open";
// The button only moves the page to the Dashboards tab; the client does that when it runs.
registerBobAction(OPEN_DASHBOARDS_ACTION, async () => undefined);

const POLL_MS = 1000;
const ANSWER_LIMIT = 600;
/** How the dashboard service words an agent turn that ended in an error (src/dashboards/service.ts). */
const AGENT_STOPPED = "The dashboard agent stopped";
/** Dashboards Bob is still working on, from the first agent turn until its message is in the chat. */
const building = new Set<string>();
export const buildingDashboardIds = (): Set<string> => new Set(building);

async function idle(id: string): Promise<void> {
  while (runningState(id)) await new Promise<void>((resolve) => setTimeout(resolve, POLL_MS).unref());
}

function announce(): void {
  void announceDashboardChanges().catch((error: unknown) => console.warn("Dashboard change notice failed", error));
}

const where = (target: BuildTarget) => target.entity.kind === "project" ? `"${target.label}"` : `your workspace "${target.label}"`;

/** The whole of what the person is told, once the dashboard agent has finished. */
async function conclude(session: AuthSession, target: BuildTarget, id: string, kind: "created" | "changed"): Promise<{ text: string; via: string; importance: "done" | "needs-you" }> {
  const answer = readCreatorMessages(id).filter((message) => message.role === "assistant").at(-1)?.text ?? "";
  const check = draftExists(id) ? checkDraft(id) : { ok: false as const, error: "the dashboard agent wrote no dashboard" };
  // A stopped agent leaves the copy of the saved dashboard it started from, which is valid but is not a change.
  if (!check.ok || answer.startsWith(AGENT_STOPPED)) {
    return {
      text: `I could not finish the dashboard for ${where(target)}. ${(answer || (check.ok ? "" : check.error)).slice(0, ANSWER_LIMIT)}\n\nWhat there is stays as a draft: open it from Dashboards to carry on with the dashboard agent.`,
      via: "Dashboards · not finished", importance: "needs-you",
    };
  }
  const before = getDashboard(id)!.definitionDigest;
  const saved = promoteDraft(id);
  if (kind === "changed" && saved.digest === before) {
    return { text: `The dashboard agent made no change to "${saved.manifest.title}". ${answer.slice(0, ANSWER_LIMIT)}`, via: "Dashboards · no change", importance: "needs-you" };
  }
  recordSavedDefinition(id, { title: saved.manifest.title, refreshMethod: saved.manifest.refresh.method, digest: saved.digest });
  forgetDraftRefresh(id);
  // A dashboard the person asked for is the one their project or workspace shows from now on; older ones stay as alternatives.
  if (kind === "created") activateDashboard(id);
  announce();
  const title = saved.manifest.title;
  const lead = kind === "created" ? `Done. "${title}" is ready for ${where(target)}.` : `Done. I changed "${title}".`;
  if (saved.manifest.refresh.method === "ai") {
    return {
      text: `${lead} It refreshes with AI: each refresh runs the dashboard agent and uses AI, so I have not run one. Open it and press Refresh when you want data.`,
      via: "Dashboards · AI refresh", importance: "done",
    };
  }
  let data: string;
  try {
    const current = getDashboard(id)!;
    startRefresh(current, await resolveEntity(current.entity, current.hostProjectId, session), "live", async () => announce());
    await idle(id);
    const refresh = getDashboard(id)!.lastRefresh;
    data = refresh?.ok ? "It shows current data." : `Its first refresh failed: ${refresh?.error ?? "no answer"}. Open it to see what the script printed.`;
  } catch (error) {
    data = `I could not run its first refresh: ${(error as Error).message}.`;
  }
  return { text: `${lead} It refreshes by script, so refreshing it costs no AI. ${data}`, via: "Dashboards · script refresh, no AI", importance: "done" };
}

async function finish(session: AuthSession, target: BuildTarget, id: string, kind: "created" | "changed"): Promise<void> {
  const db = await bobDatabase();
  let result: Awaited<ReturnType<typeof conclude>>;
  try {
    await idle(id);
    if (!getDashboard(id)) return;
    result = await conclude(session, target, id, kind);
  } catch (error) {
    result = { text: `I could not finish the dashboard for ${where(target)}: ${(error as Error).message}`, via: "Dashboards · not finished", importance: "needs-you" };
  }
  // The dashboard stops being "building" just before Bob says so, so a page that reloads on the message sees it ready.
  building.delete(id);
  appendBobMessage(db, session.accountId, {
    role: "bob", ...result, projectId: target.projectId, projectName: target.projectName,
    actions: [{ id: OPEN_DASHBOARDS_ACTION, label: "Open dashboards", style: "primary", data: { dashboardId: id } }],
  });
}

/**
 * Hands a request to the dashboard-creator agent, for a new dashboard or a change to a saved one, and returns at once.
 * Bob then watches the job: when it ends the draft is saved as the dashboard (a script dashboard is also refreshed once),
 * and Bob says so in the chat. A new dashboard is recorded as Bob's.
 */
export async function startDashboardBuild(session: AuthSession, target: BuildTarget, text: string, request: string, existing?: DashboardRecord): Promise<DashboardRecord> {
  const context = await resolveEntity(target.entity, target.hostProjectId, session);
  const record = existing ?? createDashboard({ entity: target.entity, hostProjectId: target.hostProjectId, ownerNodeId: (await getClusterNode()).id, accountId: session.accountId });
  try {
    startCreatorTurn(record, context, text);
  } catch (error) {
    if (!existing) { deleteDashboard(record.id); removeDashboardFiles(record.id); }
    throw error;
  }
  if (!existing) recordBobDashboard(await bobDatabase(), session.accountId, record.id, request);
  building.add(record.id);
  void finish(session, target, record.id, existing ? "changed" : "created")
    .catch((error: unknown) => console.warn(`Bob's dashboard ${record.id} could not be reported`, error))
    .finally(() => building.delete(record.id));
  return record;
}
