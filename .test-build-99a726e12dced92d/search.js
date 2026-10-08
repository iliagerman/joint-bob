import { projectAdditionalPaths } from "./server/session-scope.js";
import { listHarnessSessions } from "./harnesses.js";
import { listProjects } from "./store.js";
import { listTasks } from "./tasks.js";
const RESULT_LIMIT = 40;
const IDLE_PROJECTS = 8;
const IDLE_CONVERSATIONS = 16;
function fuzzySearchScore(text, query) {
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
const byNewest = (left, right) => (right.updatedAt || "").localeCompare(left.updatedAt || "");
async function conversationsIn(project) {
  const tasks = await listTasks(project.id);
  const sessions = await listHarnessSessions({
    ...project,
    additionalPaths: await projectAdditionalPaths(project.id, tasks)
  });
  return sessions.map((session) => ({
    kind: "conversation",
    projectId: project.id,
    projectName: project.name,
    title: session.title,
    subtitle: `${project.name} \xB7 ${session.agentLabel}`,
    sessionId: session.id,
    sessionPath: session.path,
    harnessId: session.harnessId,
    updatedAt: session.updatedAt
  }));
}
async function searchWorkspace(query) {
  const projects = await listProjects();
  const projectResults = projects.map((project) => ({
    kind: "project",
    projectId: project.id,
    projectName: project.name,
    title: project.name,
    subtitle: project.path,
    updatedAt: project.updatedAt
  }));
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
      ...conversationResults.sort(byNewest).slice(0, IDLE_CONVERSATIONS),
      ...projectResults.sort(byNewest).slice(0, IDLE_PROJECTS)
    ];
  }
  return [...projectResults, ...conversationResults].map((result) => ({ result, score: fuzzySearchScore(result.title, trimmed) })).filter((entry) => entry.score !== null).sort((left, right) => right.score - left.score || Number(right.result.kind === "project") - Number(left.result.kind === "project") || byNewest(left.result, right.result)).slice(0, RESULT_LIMIT).map((entry) => entry.result);
}
export {
  fuzzySearchScore,
  searchWorkspace
};
