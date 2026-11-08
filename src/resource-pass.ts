/**
 * Launching an agent decides, for every skill, plugin and MCP server, whether it may load.
 * Each decision read the same files and tables again (the Git resource sources, the relay
 * skill policies, the scoped skill index), so one launch read them dozens of times while
 * blocking the event loop. Inside a pass, each is read once. A pass is synchronous: it ends
 * when the work returns, so nothing read here outlives the launch that read it.
 */
let pass: Map<string, unknown> | undefined;

export function withResourcePass<T>(work: () => T): T {
  if (pass) return work();
  pass = new Map();
  try {
    return work();
  } finally {
    pass = undefined;
  }
}

export function readOncePerPass<T>(key: string, read: () => T): T {
  if (!pass) return read();
  if (pass.has(key)) return pass.get(key) as T;
  const value = read();
  pass.set(key, value);
  return value;
}
