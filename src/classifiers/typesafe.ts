import type { DifficultyClassification, DifficultyClassifier } from "./contract.js";

export const DIFFICULTY_LEVELS = 10;

/** Ordered rubric levels for the TypeSafe score question. Index 0 is difficulty 1. */
export const DIFFICULTY_RUBRIC: readonly string[] = [
  "Trivial: a single short factual question or tiny edit a beginner could handle with no tools and no codebase context",
  "Simple: a one-line change, a rename, or a straightforward question needing one quick file look",
  "Routine: a small localized edit, formatting, a simple script, or a well-scoped bug with a clear reproduction",
  "Moderate: a feature or fix touching a few files, following standard patterns with clear requirements",
  "Substantial: a multi-file change that needs planning and tests, with some ambiguity to resolve",
  "Complex: a cross-component feature, or work with performance, concurrency, or reliability concerns that needs careful design",
  "Hard: an architectural change, refactoring coupled systems, or debugging an unclear failure",
  "Very hard: a multi-system integration, security-sensitive or data-migration work, or a long chain of dependencies",
  "Extremely hard: open-ended research and design, a legacy rewrite, or sustained multi-hour engineering",
  "Frontier: a program spanning repositories and teams at month scale, novel architecture, or high-risk irreversible operations",
];

const TYPESAFE_ENDPOINT = process.env.JOINT_BOB_TYPESAFE_ENDPOINT || "https://api.typesafe.ai/v1/systemone";
const TYPESAFE_MODEL = "jev-latest";
/** Jev budgets 32k tokens for the state; this character cap stays far below it. */
const STATE_CHARACTER_LIMIT = 120_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 2;

interface ScoreAnswer {
  type?: unknown;
  score?: unknown;
  confidence?: unknown;
  probabilities?: unknown;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Picks the level with the highest probability, falling back to the rounded score. */
export function levelFromAnswer(answer: ScoreAnswer): DifficultyClassification | null {
  const score = numberOrUndefined(answer.score);
  const confidence = numberOrUndefined(answer.confidence);
  if (score === undefined || confidence === undefined) return null;
  let level = Math.min(DIFFICULTY_LEVELS, Math.max(1, Math.round(score) + 1));
  if (answer.probabilities && typeof answer.probabilities === "object" && !Array.isArray(answer.probabilities)) {
    let best = -1;
    for (let index = 0; index < DIFFICULTY_LEVELS; index += 1) {
      const probability = numberOrUndefined((answer.probabilities as Record<string, unknown>)[String(index)]);
      if (probability !== undefined && probability > best) {
        best = probability;
        level = index + 1;
      }
    }
    if (best < 0) return null;
  }
  return { level, score: score + 1, confidence: Math.min(1, Math.max(0, confidence)) };
}

async function postOnce(text: string, apiKey: string, fetchImpl: typeof fetch): Promise<Response> {
  return fetchImpl(TYPESAFE_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      state: text.slice(0, STATE_CHARACTER_LIMIT),
      model: TYPESAFE_MODEL,
      questions: {
        complexity: {
          type: "score",
          instructions: "How complex is this software development request for a coding agent to execute, based on the work it describes?",
          criteria: DIFFICULTY_RUBRIC,
        },
      },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/** Evaluates prompt difficulty through TypeSafe's System One score question.
    Returns null on any failure: network error, timeout, non-2xx status, or a malformed answer. */
export async function classifyWithTypesafe(text: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<DifficultyClassification | null> {
  if (!text.trim() || !apiKey) return null;
  let response: Response | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const candidate = await postOnce(text, apiKey, fetchImpl);
      if (candidate.ok || (candidate.status !== 429 && candidate.status < 500) || attempt === MAX_ATTEMPTS) {
        response = candidate;
        break;
      }
    } catch {
      if (attempt === MAX_ATTEMPTS) return null;
    }
  }
  if (!response || !response.ok) return null;
  let body: unknown;
  try { body = await response.json(); }
  catch { return null; }
  const answers = (body as { answers?: unknown } | null)?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) return null;
  const answer = (answers as Record<string, unknown>).complexity;
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  try { return levelFromAnswer(answer as ScoreAnswer); }
  catch { return null; }
}

export const typesafeClassifier: DifficultyClassifier = {
  id: "typesafe",
  label: "TypeSafe (Jev)",
  variableName: "TYPESAFE_API_KEY",
  classify: (text, apiKey) => classifyWithTypesafe(text, apiKey),
};
