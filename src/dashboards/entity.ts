import type { AuthSession } from "../auth.js";
import { NotFoundError } from "../not-found.js";
import { listConversationSegments } from "../conversation-records.js";
import { getProject, listProjects, listWorkspaces, projectVisible } from "../store.js";
import { listReviewScopeSessions } from "../server/sessions-helpers.js";
import type { ProjectRecord } from "../types.js";
import type { DashboardEntity } from "./contract.js";

/** What a dashboard's entity is on this node, for the person asking; absent or hidden is not found. */
export interface EntityContext {
  entity: DashboardEntity;
  project: ProjectRecord;
  label: string;
  /** The conversation's latest harness session, whose secret accounts its dashboard also gets. */
  conversation?: { engine: string; sessionId: string; title: string; transcriptPath: string };
  workspace?: { id: string; label: string; projects: ProjectRecord[] };
}

async function visibleProject(projectId: string): Promise<ProjectRecord> {
  const project = await getProject(projectId);
  if (!project || !await projectVisible(project.id)) throw new NotFoundError("Project not found");
  return project;
}

async function conversationContext(project: ProjectRecord, conversationId: string, auth: AuthSession): Promise<EntityContext["conversation"]> {
  const sessions = await listReviewScopeSessions(project, auth.userId, auth.accountId);
  const session = sessions.find((candidate) => (candidate.conversationId ?? candidate.id) === conversationId);
  if (!session) throw new NotFoundError("Conversation not found");
  const latest = (await listConversationSegments(project.id, conversationId)).at(-1);
  return { engine: latest?.engine ?? session.harnessId, sessionId: latest?.sessionId ?? session.id, title: session.title, transcriptPath: session.path };
}

async function workspaceContext(workspaceId: string, host: ProjectRecord): Promise<EntityContext["workspace"]> {
  const workspace = (await listWorkspaces()).find((candidate) => candidate.id === workspaceId);
  if (!workspace || host.type !== workspace.id) throw new NotFoundError("Workspace not found");
  return { id: workspace.id, label: workspace.label, projects: (await listProjects()).filter((project) => project.type === workspace.id) };
}

/** Resolves the entity and checks the person may see it; the host project carries its work. */
export async function resolveEntity(entity: DashboardEntity, hostProjectId: string, auth: AuthSession): Promise<EntityContext> {
  const project = await visibleProject(hostProjectId);
  if (entity.kind === "project") return { entity, project, label: project.name };
  if (entity.kind === "conversation") {
    const conversation = await conversationContext(project, entity.id, auth);
    return { entity, project, label: conversation!.title || "Conversation", conversation };
  }
  const workspace = await workspaceContext(entity.id, project);
  return { entity, project, label: workspace!.label, workspace };
}
