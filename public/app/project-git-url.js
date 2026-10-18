/** Capture scope when opening a view, not from active-chat state when a request finishes. */
export function projectGitUrl(context, route, params = {}) {
  const url = new URL(`/api/projects/${encodeURIComponent(context.projectId)}/git/${route}`, location.origin);
  for (const [key, value] of Object.entries({ ...params, nodeId: context.nodeId, taskId: context.taskId, repository: context.repository })) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}
