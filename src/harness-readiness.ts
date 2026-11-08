/**
 * Which agents were installed and signed in on this node at the last check. Checking runs
 * each agent's command-line tool, so src/background-agent.ts keeps the answer here and
 * refreshes it in the background. This module imports nothing, so settings can read it.
 */
let known: { ready: string[]; at: number } | undefined;

export function knownReadyHarnesses(): { ready: string[]; at: number } | undefined {
  return known;
}

export function rememberReadyHarnesses(ready: string[], at = Date.now()): void {
  known = { ready: [...ready], at };
}

export function forgetReadyHarnesses(): void {
  known = undefined;
}
