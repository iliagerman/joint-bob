/** Only built-in readers. Unknown extensions, shell, web and delegated agents are never read-only tools. */
export function readOnlyChatTools(harnessId: string): string[] {
  switch (harnessId) {
    case "pi": return ["read", "grep", "find", "ls"];
    case "claude": return ["Read", "Grep", "Glob"];
    case "kiro": return ["read"];
    default: return [];
  }
}
