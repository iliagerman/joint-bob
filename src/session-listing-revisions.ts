/**
 * The running list and the review inbox span every project, so every open page asks for every
 * project's conversations whenever a conversation changes anywhere. Each request used to
 * rebuild all of them, once per page and once per list, while only one project had changed.
 *
 * A project's answer is kept here until something is announced for that project, or for all
 * of them, and requests that arrive together share one computation. Callers pass what they
 * read of the state that changes unannounced (see unannouncedRunState), so the age limit is
 * only a backstop for a change nobody thought to announce. It is as long as the pages' own
 * poll: at ten seconds, pages asking every fifteen still recomputed every project each time.
 *
 * This module imports nothing, so anything that announces a change can mark it here.
 */
const MAX_AGE_MS = 60_000;
const MAX_ENTRIES = 2_000;

const projects = new Map<string, number>();
let everywhere = 0;
const held = new Map<string, { revision: string; startedAt: number; value: Promise<unknown> }>();

/** Marks one project's conversation list as changed, or every project's when none is named. */
export function sessionListingChanged(projectId?: string): void {
  if (projectId) projects.set(projectId, (projects.get(projectId) ?? 0) + 1);
  else everywhere += 1;
}

function revision(projectId: string): string { return `${everywhere}:${projects.get(projectId) ?? 0}`; }

/**
 * `compute`'s answer for `key`, shared with every caller until the project is marked changed.
 * A change marked while it is being computed makes the next caller compute again: the answer
 * in flight may have read the old state. `state` is whatever the caller read that the answer
 * depends on and that changes unannounced; a different value also computes again.
 */
export function sharedProjectListing<T>(projectId: string, key: string, compute: () => Promise<T>, state = "", now = Date.now()): Promise<T> {
  const current = `${revision(projectId)}:${state}`;
  const existing = held.get(key);
  if (existing && existing.revision === current && now - existing.startedAt < MAX_AGE_MS) return existing.value as Promise<T>;
  if (held.size >= MAX_ENTRIES) held.clear();
  const value = compute();
  const entry = { revision: current, startedAt: now, value };
  held.set(key, entry);
  // A failed listing is not kept: the next request tries again.
  value.catch(() => { if (held.get(key) === entry) held.delete(key); });
  return value;
}

export function resetSharedProjectListings(): void { held.clear(); }
