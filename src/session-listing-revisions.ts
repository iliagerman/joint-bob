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
interface Held { revision: string; startedAt: number; value: Promise<unknown>; settled: boolean }
const held = new Map<string, Held>();

/** Marks one project's conversation list as changed, or every project's when none is named. */
export function sessionListingChanged(projectId?: string): void {
  if (projectId) projects.set(projectId, (projects.get(projectId) ?? 0) + 1);
  else everywhere += 1;
}

/**
 * Which projects a conversation belongs to. Most of what changes is one conversation (it
 * started, stopped, or its agents reported progress); marking every project for that threw
 * every kept answer away on almost every request once a few conversations were running.
 */
type ConversationProjects = (engine: string, sessionId: string) => string[];
let projectsOfConversation: ConversationProjects | undefined;
export function placeConversationsWith(resolver: ConversationProjects | undefined): void { projectsOfConversation = resolver; }

/** The projects these conversations belong to, or undefined when one of them cannot be placed. */
export function conversationProjects(conversations: Iterable<{ engine: string; sessionId: string }>): Set<string> | undefined {
  const found = new Set<string>();
  for (const { engine, sessionId } of conversations) {
    let ids: string[] = [];
    try { ids = projectsOfConversation?.(engine, sessionId) ?? []; } catch { /* treated as not placed */ }
    if (!ids.length) return undefined;
    for (const id of ids) found.add(id);
  }
  return found;
}

/** Marks the conversation lists of the projects these conversations belong to; every project's when one cannot be placed. */
export function conversationsChanged(conversations: Iterable<{ engine: string; sessionId: string }>): void {
  const placed = conversationProjects(conversations);
  if (!placed) sessionListingChanged();
  else for (const id of placed) sessionListingChanged(id);
}

function revision(projectId: string): string { return `${everywhere}:${projects.get(projectId) ?? 0}`; }

/**
 * `compute`'s answer for `key`, shared with every caller until the project is marked changed.
 * A change marked while it is being computed makes the next caller compute again: the answer
 * in flight may have read the old state. `state` is whatever the caller read that the answer
 * depends on and that changes unannounced; a different value also computes again.
 */
export function sharedProjectListing<T>(projectId: string, key: string, compute: () => Promise<T>, state = "", now = Date.now(), onlyInFlight = false): Promise<T> {
  const current = `${revision(projectId)}:${state}`;
  const fresh = (entry: Held | undefined): entry is Held => Boolean(entry) && entry!.revision === current && now - entry!.startedAt < MAX_AGE_MS;
  const existing = held.get(key);
  // `onlyInFlight` is for the open project's own list: a person looks at it right after acting,
  // and much of what it shows changes unannounced. It joins a listing being built now, never
  // takes a finished one, and what it builds is neither kept nor allowed to replace a kept one.
  const place = onlyInFlight ? `${key}\nin flight` : key;
  const building = [existing, held.get(`${key}\nin flight`)].find((entry) => fresh(entry) && !entry.settled);
  const joined = onlyInFlight ? building : fresh(existing) ? existing : building;
  if (joined) {
    // A list that keeps its answer and joins one being built for the open project keeps that one.
    if (!onlyInFlight && joined !== existing) held.set(key, joined);
    use.reused++;
    return joined.value as Promise<T>;
  }
  use.computed++;
  if (held.size >= MAX_ENTRIES) held.clear();
  const value = compute();
  const entry: Held = { revision: current, startedAt: now, value, settled: false };
  held.set(place, entry);
  // A failed listing is not kept: the next request tries again.
  const drop = (): void => { if (held.get(place) === entry) held.delete(place); };
  value.then(() => { entry.settled = true; if (onlyInFlight) drop(); }, drop);
  return value;
}

export function resetSharedProjectListings(): void { held.clear(); }

const use = { computed: 0, reused: 0 };
/** How many listings were built and how many were answered from a kept one, since this process started. */
export function sharedProjectListingUse(): { computed: number; reused: number } { return { ...use }; }
