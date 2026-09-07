import { listHarnessSessions } from "./harnesses.js";
import { listProjects } from "./store.js";
import { listTasks } from "./tasks.js";
import type { HarnessId } from "./types.js";

/**
 * One search across every project and every conversation in them, for the command bar.
 * A conversation is only ever named here, never opened: the bar hands the identity back
 * to the normal open path.
 */
export interface SearchResult {
  kind: "project" | "conversation";
  projectId: string;
  projectName: string;
  title: string;
  subtitle: string;
  sessionId?: string;
  sessionPath?: string;
  harnessId?: HarnessId;
  updatedAt?: string;
}

const RESULT_LIMIT = 40;
/** With nothing typed the bar is a shortlist, not a directory listing. */
const IDLE_PROJECTS = 8;
const IDLE_CONVERSATIONS = 16;

/**
 * Characters in order, not necessarily adjacent, so "pyser" finds "Payments service".
 * Adjacent hits and hits at a word boundary score higher, and a shorter haystack breaks
 * ties, so the tightest match rises. Null means the query is simply not in there.
 */
export function fuzzySearchScore(text: string, query: string): number | null {
  if (!query) return 0;
  const haystack = text.toLowerCase();
  let score = 0;
  let index = -1;
  let prior = -2;
  for (const character of query.toLowerCase()) {
    index = haystack.indexOf(character, index + 1);
    if (index < 0) return null;
    score += index === prior + 1 ? 10 : 1;
    if (index === 0 || /[\s·\-_/]/.test(haystack[index - 1])) score += 5;
    prior = index;
  }
  return score - haystack.length / 100;
}

const byNewest = (left: SearchResult, right: SearchResult) => (right.updatedAt || "").localeCompare(left.updatedAt || "");

async function conversationsIn(project: { id: string; name: string; path: string }): Promise<SearchResult[]> {
  const tasks = await listTasks(project.id);
  const sessions = await listHarnessSessions({
    ...project,
    additionalPaths: tasks.flatMap((task) => task.worktreePath ? [task.worktreePath] : []),
  } as Parameters<typeof listHarnessSessions>[0]);
  return sessions.map((session) => ({
    kind: "conversation" as const,
    projectId: project.id,
    projectName: project.name,
    title: session.title,
    subtitle: `${project.name} · ${session.agentLabel}`,
    sessionId: session.id,
    sessionPath: session.path,
    harnessId: session.harnessId,
    updatedAt: session.updatedAt,
  }));
}

export async function searchWorkspace(query: string): Promise<SearchResult[]> {
  const projects = await listProjects();
  const projectResults: SearchResult[] = projects.map((project) => ({
    kind: "project" as const,
    projectId: project.id,
    projectName: project.name,
    title: project.name,
    subtitle: project.path,
    updatedAt: project.updatedAt,
  }));
  // Reading every project's conversations is the point of one bar; a project whose
  // transcripts cannot be read is skipped rather than failing the whole search.
  const conversationResults = (await Promise.all(projects.map(async (project) => {
    try {
      return await conversationsIn(project);
    } catch (error) {
      console.warn(`Could not search conversations in ${project.name}`, error);
      return [];
    }
  }))).flat();

  const trimmed = query.trim();
  if (!trimmed) {
    return [
      ...projectResults.sort(byNewest).slice(0, IDLE_PROJECTS),
      ...conversationResults.sort(byNewest).slice(0, IDLE_CONVERSATIONS),
    ];
  }
  return [...projectResults, ...conversationResults]
    .map((result) => ({ result, score: fuzzySearchScore(result.title, trimmed) }))
    .filter((entry): entry is { result: SearchResult; score: number } => entry.score !== null)
    // A project outranks a conversation of the same strength: it is the smaller list,
    // and it is what "go to X" usually means.
    .sort((left, right) => right.score - left.score
      || Number(right.result.kind === "project") - Number(left.result.kind === "project")
      || byNewest(left.result, right.result))
    .slice(0, RESULT_LIMIT)
    .map((entry) => entry.result);
}
