function conversationId(session) {
  return session.conversationId || session.id;
}

export function referenceDraft(references) {
  const lines = [
    "Referenced work (pointers only; content is not preloaded):",
    "Project ID: " + references.projectId,
  ];
  for (const worktree of references.worktrees) {
    lines.push("", `Worktree: ${worktree.name}`, `- ID: ${worktree.id}`, `- Path on the selecting node: ${worktree.path}`);
    if (worktree.pullRequest) lines.push(`- Pull request: #${worktree.pullRequest.number} ${worktree.pullRequest.url}`, `- Branch: ${worktree.pullRequest.branch} -> ${worktree.pullRequest.base}`);
  }
  for (const session of references.conversations) {
    lines.push("", `Conversation: ${session.title || session.name || "Untitled conversation"}`, `- ID: ${conversationId(session)}`, `- Agent: ${session.agentLabel || session.harnessId}`);
    if (session.path && !session.path.startsWith("draft:")) lines.push(`- Transcript path on the selecting node: ${session.path}`);
    if (session.worktree) lines.push(`- Worktree: ${session.worktree.name} (${session.worktree.id})`);
  }
  lines.push("", "Inspect only the references needed for the task. Run the Joint Bob worktree CLI list command before any PR, merge, or delete operation.", "", "Task:", "");
  return lines.join("\n");
}
