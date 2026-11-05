import type { AuthSession } from "../auth.js";
import { registerBobContextProvider } from "../control-center/bob-hooks.js";
import { bobDatabase } from "../control-center/bob-store.js";
import { bobDashboardIds } from "../control-center/dashboards-made.js";
import type { DashboardEntity } from "../dashboards/contract.js";
import { resolveEntity } from "../dashboards/entity.js";
import { readSharedPayload } from "../dashboards/files.js";
import { hasOwnSavedDashboard, listAllDashboards, type DashboardRecord, type DashboardRefresh } from "../dashboards/store.js";
import { NotFoundError } from "../not-found.js";
import { buildingDashboardIds } from "./control-center-dashboard-builds.js";
import { isTwinOwner } from "./dashboard-sharing.js";
import { projectsWithSharedNames } from "./projects.js";

/** One dashboard in the control center's Dashboards tab. */
export interface DashboardCard {
  id: string;
  title: string;
  /** `project` dashboards belong to a project; `me` ones to the person's workspace. */
  group: "project" | "me";
  entity: { kind: "project" | "workspace"; id: string };
  /** The project the dashboard runs in. */
  hostProjectId: string;
  projectId: string | null;
  projectName: string | null;
  /** The workspace's name, for a `me` dashboard. */
  workspaceLabel: string | null;
  /** The projects a `me` dashboard covers, so a project filter can keep it. */
  projectIds: string[];
  madeBy: "bob" | "you" | "shared";
  origin: "own" | "received";
  ownerNodeId: string;
  refreshMethod: "script" | "ai" | null;
  /** `ready` is saved and can be shown; `building` is Bob's agent still at work; `draft` was never finished. */
  status: "ready" | "building" | "draft";
  approved: boolean;
  lastRefresh: DashboardRefresh | null;
  /** When the owner published the data shown, for a dashboard received from another node. */
  publishedAt: string | null;
  /** Bob's agent is changing this saved dashboard now. */
  changing: boolean;
  /** The person may ask Bob to change it: only a saved dashboard of this node's own. */
  canChange: boolean;
  updatedAt: string;
}

/** The dashboard an entity shows here: the active one, else on a twin with none of its own, its twin's. */
async function displayed(entity: DashboardEntity, records: DashboardRecord[]): Promise<DashboardRecord | undefined> {
  const saved = records.filter((record) => record.definitionDigest !== null);
  const active = saved.find((record) => record.active);
  if (active || hasOwnSavedDashboard(entity)) return active;
  for (const record of saved) if (record.origin === "received" && await isTwinOwner(record.ownerNodeId)) return record;
  return undefined;
}

/**
 * The dashboards this person can see, one card per project or workspace: the one it shows. Dashboards Bob is still
 * building, or could not finish, are listed too, so the person can follow them and finish them. Conversation
 * dashboards stay with their conversations.
 */
export async function listDashboardCards(session: AuthSession): Promise<DashboardCard[]> {
  const [names, made] = await Promise.all([
    projectsWithSharedNames({ includeSyncStatus: false, includeUsage: false }).then((projects) => new Map(projects.map((project) => [project.id, project.name]))),
    bobDatabase().then((db) => bobDashboardIds(db, session.accountId)),
  ]);
  const working = buildingDashboardIds();
  const byEntity = new Map<string, DashboardRecord[]>();
  for (const record of listAllDashboards()) {
    if (record.entity.kind === "conversation") continue;
    const key = `${record.entity.kind}:${record.entity.id}`;
    byEntity.set(key, [...byEntity.get(key) ?? [], record]);
  }
  const cards: DashboardCard[] = [];
  for (const records of byEntity.values()) {
    const entity = records[0].entity as DashboardCard["entity"];
    let context: Awaited<ReturnType<typeof resolveEntity>>;
    try { context = await resolveEntity(entity, records[0].hostProjectId, session); }
    catch (error) { if (error instanceof NotFoundError) continue; throw error; }
    const shown = await displayed(entity, records);
    const unfinished = records.filter((record) => record.definitionDigest === null && record.origin === "own" && made.has(record.id));
    for (const record of [...(shown ? [shown] : []), ...unfinished]) {
      const saved = record.definitionDigest !== null;
      cards.push({
        id: record.id, title: record.title || "New dashboard", group: entity.kind === "project" ? "project" : "me", entity,
        hostProjectId: record.hostProjectId,
        projectId: entity.kind === "project" ? entity.id : null,
        projectName: entity.kind === "project" ? names.get(entity.id) ?? context.label : null,
        workspaceLabel: entity.kind === "workspace" ? context.label : null,
        projectIds: context.workspace?.projects.map((project) => project.id) ?? [],
        madeBy: made.has(record.id) ? "bob" : record.origin === "own" && (!record.accountId || record.accountId === session.accountId) ? "you" : "shared",
        origin: record.origin, ownerNodeId: record.ownerNodeId, refreshMethod: record.refreshMethod,
        status: saved ? "ready" : working.has(record.id) ? "building" : "draft",
        approved: saved && record.approvedDigest === record.definitionDigest,
        lastRefresh: record.lastRefresh,
        publishedAt: record.origin === "received" ? readSharedPayload(record.id)?.generatedAt ?? null : null,
        changing: saved && working.has(record.id), canChange: saved && record.origin === "own", updatedAt: record.updatedAt,
      });
    }
  }
  return cards.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}

const KNOWN_LIMIT = 20;
const ago = (iso: string) => {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.round(minutes / 60)}h ago` : `${Math.round(minutes / 1440)}d ago`;
};

// Bob's own agent hears what dashboards are and which exist, so it can say yes to "can you build me a dashboard?" and list them.
registerBobContextProvider("dashboards", async (turn) => {
  const cards = (await listDashboardCards(turn.session)).filter((card) => card.status === "ready").slice(0, KNOWN_LIMIT);
  const lines = cards.map((card) => {
    const where = card.group === "project" ? `project ${card.projectName}` : `for the person, workspace ${card.workspaceLabel}`;
    const refreshed = card.publishedAt ?? card.lastRefresh?.at;
    return `- "${card.title}" (${where}; made by ${card.madeBy === "bob" ? "Bob" : card.madeBy === "you" ? "the person" : "another node"}; refreshes ${card.refreshMethod === "ai" ? "with AI, each refresh costs AI" : "by script, no AI"}; ${refreshed ? `refreshed ${ago(refreshed)}` : "not refreshed yet"})`;
  });
  return { text: [
    "Dashboards: the person can ask you to build a dashboard for a project or for themselves (for example \"create a dashboard for <project> showing bugs per day\", or \"make me a dashboard of what needs my attention\").",
    "Such a message is handled before it reaches you: the dashboard-creator agent builds it in the background and you tell the person here when it is ready. They see dashboards in the Dashboards tab and change one with its \"Ask Bob to change it\" button.",
    lines.length ? `Dashboards now:\n${lines.join("\n")}` : "There are no dashboards yet.",
  ].join("\n") };
});
