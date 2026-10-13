/**
 * Suggestions for the skills an agent could use, from what this node has recorded: which
 * installed skills look idle, failing or redundant, and which kinds of conversation keep coming
 * back without a skill for them. Everything here is a heuristic over local metadata (usage, turn
 * results, conversation titles). Nothing calls a model, and nothing is installed or removed.
 */

export interface InstalledSkill { name: string; description: string; origin: string; harnesses: string[] }
export interface ObservedSkill { name: string; associatedTurns: number; toolCalls: number; toolErrors: number; apiEquivalentCostUsd: number; lastUsedAt: string }
export interface RemovalSuggestion {
  kind: "unused" | "failing" | "overlap";
  name: string;
  /** The skill it overlaps with, for an overlap. */
  other?: string;
  reason: string;
  turns: number;
  lastUsedAt: string | null;
  knownCostUsd: number;
}

const DAY_MS = 86_400_000;
export const UNUSED_AFTER_DAYS = 90;
export const MIN_OBSERVED_DAYS = 30;
const MIN_FAILING_TURNS = 10;
const OVERLAP = 0.6;

const STOP = new Set(("a an and are as at be by for from has have how in into is it its of on or that the this to was were will with you your " +
  "new conversation chat untitled claude fork please can could would should need want make get add use using run set up").split(" "));

/** Words of a title or description worth comparing: letters and digits, no stop words or bare numbers. */
export function significantWords(text: string): string[] {
  return text.toLowerCase().replace(/^\[[^\]]*\]\s*/, "").split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 3 && !/^\d+$/.test(word) && !STOP.has(word));
}

const jaccard = (left: Set<string>, right: Set<string>): number => {
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return left.size + right.size - shared ? shared / (left.size + right.size - shared) : 0;
};

/**
 * Installed skills to consider removing, most certain first. `observedSince` is when this
 * ledger's earliest request was recorded: a skill cannot be called idle for longer than that.
 */
export function suggestRemovals(input: { installed: InstalledSkill[]; used: ObservedSkill[]; observedSince: string | null; baselineErrorRate: number | null; now?: Date }): RemovalSuggestion[] {
  const now = (input.now ?? new Date()).getTime();
  const observedDays = input.observedSince ? (now - Date.parse(input.observedSince)) / DAY_MS : 0;
  // Claude names a plugin's skill "plugin:skill"; either spelling is that skill being used.
  const usage = new Map<string, ObservedSkill>();
  for (const skill of input.used) for (const key of new Set([skill.name, skill.name.split(":").at(-1)!])) {
    const current = usage.get(key);
    if (!current || skill.associatedTurns > current.associatedTurns) usage.set(key, skill);
  }
  const byName = new Map<string, InstalledSkill>();
  for (const skill of input.installed) if (!byName.has(skill.name)) byName.set(skill.name, skill);
  const found: RemovalSuggestion[] = [];

  for (const skill of byName.values()) {
    const seen = usage.get(skill.name);
    if (!seen) {
      if (observedDays >= MIN_OBSERVED_DAYS) found.push({ kind: "unused", name: skill.name, turns: 0, lastUsedAt: null, knownCostUsd: 0,
        reason: `No agent has loaded it in the ${Math.floor(observedDays)} days of usage recorded on this node.` });
      continue;
    }
    const idle = (now - Date.parse(seen.lastUsedAt)) / DAY_MS;
    if (idle >= UNUSED_AFTER_DAYS) found.push({ kind: "unused", name: skill.name, turns: seen.associatedTurns, lastUsedAt: seen.lastUsedAt, knownCostUsd: seen.apiEquivalentCostUsd,
      reason: `Loaded in ${seen.associatedTurns.toLocaleString()} turn${seen.associatedTurns === 1 ? "" : "s"} in total, but not for ${Math.floor(idle)} days.` });
    else if (input.baselineErrorRate !== null && seen.associatedTurns >= MIN_FAILING_TURNS && seen.toolCalls >= 30) {
      const rate = seen.toolErrors / seen.toolCalls;
      if (rate >= input.baselineErrorRate * 1.5 && rate - input.baselineErrorRate >= 0.03) found.push({ kind: "failing", name: skill.name, turns: seen.associatedTurns, lastUsedAt: seen.lastUsedAt, knownCostUsd: seen.apiEquivalentCostUsd,
        reason: `${(rate * 100).toFixed(0)}% of tool calls fail in turns that load it, against ${(input.baselineErrorRate * 100).toFixed(1)}% across all turns with a skill. Worth fixing or dropping.` });
    }
  }

  const words = [...byName.values()].map((skill) => ({ skill, words: new Set(significantWords(`${skill.name.replace(/[-_:]/g, " ")} ${skill.description}`)) })).filter((entry) => entry.words.size >= 4);
  for (let left = 0; left < words.length; left++) for (let right = left + 1; right < words.length; right++) {
    if (jaccard(words[left].words, words[right].words) < OVERLAP) continue;
    const turns = (entry: (typeof words)[number]) => usage.get(entry.skill.name)?.associatedTurns ?? 0;
    const [keep, drop] = turns(words[left]) >= turns(words[right]) ? [words[left], words[right]] : [words[right], words[left]];
    const seen = usage.get(drop.skill.name);
    found.push({ kind: "overlap", name: drop.skill.name, other: keep.skill.name, turns: turns(drop), lastUsedAt: seen?.lastUsedAt ?? null, knownCostUsd: seen?.apiEquivalentCostUsd ?? 0,
      reason: `Its description is ${Math.round(jaccard(words[left].words, words[right].words) * 100)}% the same as ${keep.skill.name}, which is loaded in ${turns(keep).toLocaleString()} turns against ${turns(drop).toLocaleString()} for it.` });
  }
  const rank = { unused: 0, overlap: 1, failing: 2 } as const;
  return found.sort((a, b) => rank[a.kind] - rank[b.kind] || a.turns - b.turns || a.name.localeCompare(b.name));
}

export interface ConversationSummary { projectId: string; conversationId: string; title: string; costUsd: number | null; requests: number; firstAt: string; lastAt: string }
export interface CreationSuggestion {
  phrase: string;
  kind: "skill" | "script";
  confidence: number;
  conversations: number; projects: number; days: number;
  knownCostUsd: number; requests: number;
  firstAt: string; lastAt: string;
  /** An installed skill that already seems to cover the phrase. */
  coveredBy: string | null;
  examples: Array<{ projectId: string; conversationId: string; title: string; knownCostUsd: number | null }>;
  /** The project with at least three of these conversations, which a draft can cite as evidence. */
  draftProjectId: string | null;
  draftEvidenceIds: string[];
}
const MIN_CONVERSATIONS = 3;
const MIN_DAYS = 2;
const MAX_GROUPS = 12;

/**
 * Kinds of work that keep recurring: a pair of words that appears in the titles of at least
 * three conversations on at least two different days. Each conversation joins the commonest
 * pair it holds, so one run of work is not listed twice.
 */
export function suggestNewSkills(conversations: ConversationSummary[], installed: InstalledSkill[]): CreationSuggestion[] {
  const pairs = new Map<string, Set<number>>();
  const titled = conversations.map((conversation, index) => {
    const words = significantWords(conversation.title);
    const own = new Set<string>();
    for (let at = 0; at + 1 < words.length; at++) if (words[at] !== words[at + 1]) own.add(`${words[at]} ${words[at + 1]}`);
    for (const pair of own) { const set = pairs.get(pair) ?? new Set<number>(); set.add(index); pairs.set(pair, set); }
    return { conversation, words: new Set(words), own };
  });
  const cost = (indexes: Iterable<number>) => [...indexes].reduce((sum, index) => sum + (conversations[index].costUsd ?? 0), 0);
  const claimed = new Set<number>();
  const groups: Array<{ phrase: string; members: number[] }> = [];
  const ranked = [...pairs].filter(([, set]) => set.size >= MIN_CONVERSATIONS)
    .sort(([leftPair, left], [rightPair, right]) => right.size - left.size || cost(right) - cost(left) || leftPair.localeCompare(rightPair));
  for (const [phrase, set] of ranked) {
    const members = [...set].filter((index) => !claimed.has(index));
    if (members.length < MIN_CONVERSATIONS) continue;
    if (new Set(members.map((index) => conversations[index].lastAt.slice(0, 10))).size < MIN_DAYS) continue;
    for (const index of members) claimed.add(index);
    groups.push({ phrase, members });
    if (groups.length >= MAX_GROUPS) break;
  }
  const coverage = installed.map((skill) => ({ name: skill.name, words: new Set(significantWords(`${skill.name.replace(/[-_:]/g, " ")} ${skill.description}`)) }));
  return groups.map(({ phrase, members }) => {
    const chosen = members.map((index) => conversations[index]);
    const phraseWords = phrase.split(" ");
    const covered = coverage.find((skill) => phraseWords.every((word) => skill.words.has(word)))?.name ?? null;
    const perProject = new Map<string, ConversationSummary[]>();
    for (const conversation of chosen) perProject.set(conversation.projectId, [...(perProject.get(conversation.projectId) ?? []), conversation]);
    const best = [...perProject].sort((a, b) => b[1].length - a[1].length)[0];
    const draftable = best && best[1].length >= MIN_CONVERSATIONS ? best : null;
    return {
      phrase, kind: /^(run|build|deploy|check|update|test|fix|restart|backup|sync|export|import)\b/.test(phrase) ? "script" as const : "skill" as const,
      confidence: Math.max(0.1, Math.min(0.7, 0.25 + members.length * 0.05) - (covered ? 0.15 : 0)),
      conversations: members.length, projects: perProject.size, days: new Set(chosen.map((item) => item.lastAt.slice(0, 10))).size,
      knownCostUsd: cost(members), requests: chosen.reduce((sum, item) => sum + item.requests, 0),
      firstAt: chosen.map((item) => item.firstAt).sort()[0], lastAt: chosen.map((item) => item.lastAt).sort().at(-1)!,
      coveredBy: covered,
      examples: [...chosen].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)).slice(0, 6).map((item) => ({ projectId: item.projectId, conversationId: item.conversationId, title: item.title, knownCostUsd: item.costUsd })),
      draftProjectId: draftable ? draftable[0] : null,
      draftEvidenceIds: draftable ? [...draftable[1]].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0)).slice(0, 10).map((item) => item.conversationId) : [],
    };
  }).sort((a, b) => b.knownCostUsd - a.knownCostUsd);
}
