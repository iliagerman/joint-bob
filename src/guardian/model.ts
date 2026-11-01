import { createHash } from "node:crypto";

/** Where the yes/no questions go. Jev and laya-serve accept the same `/v1/systemone` request. */
export interface GuardianModelTarget {
  /** Shown in reasons and review cards: "Jev", "Laya". */
  label: string;
  url: string;
  apiKey?: string;
  /** Sent as the request's `model` field. */
  model?: string;
  timeoutMs: number;
  /** The longest piece of state one request carries; longer content is split and every piece is asked. */
  chunkCharacters: number;
  maxChunks: number;
}

export const JEV_ENDPOINT = process.env.JOINT_BOB_TYPESAFE_ENDPOINT || "https://api.typesafe.ai/v1/systemone";

export function jevTarget(apiKey: string): GuardianModelTarget {
  // Jev budgets 32k tokens for the state; 100,000 characters stays below it with the questions.
  return { label: "Jev", url: JEV_ENDPOINT, apiKey, model: "jev-latest", timeoutMs: 10_000, chunkCharacters: 100_000, maxChunks: 5 };
}

export function layaTarget(baseUrl: string, apiKey: string | undefined, local: boolean): GuardianModelTarget {
  // The multilingual checkpoint reads 1,024 tokens by default, about 3,500 characters of English.
  // A local server loads its checkpoint on the first request, which takes far longer than an answer.
  return {
    label: "Laya", url: `${baseUrl.replace(/\/+$/, "")}/v1/systemone`, ...(apiKey ? { apiKey } : {}), model: "multilingual",
    timeoutMs: local ? 120_000 : 20_000, chunkCharacters: 3_500, maxChunks: 30,
  };
}

export class GuardianModelError extends Error {}

const CACHE_LIMIT = 1_000;
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; answers: Record<string, number> }>();

function cached(key: string): Record<string, number> | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > CACHE_MS) { cache.delete(key); return undefined; }
  return entry.answers;
}

function remember(key: string, answers: Record<string, number>): void {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), answers });
}

export function clearGuardianModelCache(): void { cache.clear(); }

async function post(target: GuardianModelTarget, state: string, questions: Record<string, string>, fetchImpl: typeof fetch): Promise<Response> {
  return fetchImpl(target.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}) },
    body: JSON.stringify({
      state,
      ...(target.model ? { model: target.model } : {}),
      questions: Object.fromEntries(Object.entries(questions).map(([id, instructions]) => [id, { type: "noul", instructions }])),
    }),
    signal: AbortSignal.timeout(target.timeoutMs),
  });
}

/** One request: every question about one piece of state, retried once when the service is busy. */
async function askOnce(target: GuardianModelTarget, state: string, questions: Record<string, string>, fetchImpl: typeof fetch): Promise<Record<string, number>> {
  let response: Response | undefined;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      response = await post(target, state, questions, fetchImpl);
    } catch (error) {
      if (attempt === 2) throw new GuardianModelError(`${target.label} did not answer: ${(error as Error).message}`);
      continue;
    }
    if (response.ok || (response.status !== 429 && response.status < 500)) break;
  }
  if (!response!.ok) throw new GuardianModelError(`${target.label} refused the check (HTTP ${response!.status})`);
  const body = await response!.json().catch(() => null) as { answers?: Record<string, { noul?: unknown }> } | null;
  const answers: Record<string, number> = {};
  for (const id of Object.keys(questions)) {
    const value = body?.answers?.[id]?.noul;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new GuardianModelError(`${target.label} returned no answer for a rule`);
    answers[id] = value;
  }
  return answers;
}

function chunks(text: string, size: number): string[] {
  const pieces: string[] = [];
  for (let start = 0; start < text.length; start += size) pieces.push(text.slice(start, start + size));
  return pieces.length ? pieces : [""];
}

/**
 * The probability that the answer to each question is yes. Content longer than one request is asked
 * piece by piece and the highest answer counts, so a secret at the end is not lost to truncation.
 * Throws when the model cannot answer; callers treat that as a failed check.
 */
export async function askGuardianModel(target: GuardianModelTarget, state: string, questions: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<Record<string, number>> {
  const pieces = chunks(state, target.chunkCharacters);
  if (pieces.length > target.maxChunks) {
    throw new GuardianModelError(`The content is too long for ${target.label} to check (${state.length.toLocaleString("en-US")} characters)`);
  }
  const results = await Promise.all(pieces.map(async (piece) => {
    const key = createHash("sha256").update(JSON.stringify([target.url, target.model, questions, piece])).digest("hex");
    const known = cached(key);
    if (known) return known;
    const answers = await askOnce(target, piece, questions, fetchImpl);
    remember(key, answers);
    return answers;
  }));
  return Object.fromEntries(Object.keys(questions).map((id) => [id, Math.max(...results.map((answers) => answers[id]))]));
}
