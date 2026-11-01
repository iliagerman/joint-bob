import { randomUUID } from "node:crypto";

/** A review nobody answers blocks the action: scheduled runs and webhooks never wait forever. */
export const REVIEW_TIMEOUT_MS = 10 * 60_000;
const SUBJECT_LIMIT = 4_000;

export interface GuardianReview {
  id: string;
  projectId: string;
  conversationId: string;
  /** "Pi wants to run a command that could delete data". */
  title: string;
  /** The command, file change or content, shortened for the card. */
  subject: string;
  /** "Dangerous commands rule · 94% sure · Jev". */
  detail: string;
  createdAt: string;
  expiresAt: string;
}

export type ReviewDecision = "allow" | "block";

const pending = new Map<string, { review: GuardianReview; settle: (decision: ReviewDecision) => void }>();
const listeners = new Set<(projectId: string, conversationId: string, review: GuardianReview) => void>();

/** Called whenever a conversation's open reviews change; the chat server pushes them to its viewers. */
export function onGuardianReviewsChanged(listener: (projectId: string, conversationId: string, review: GuardianReview) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(review: GuardianReview): void {
  for (const listener of listeners) listener(review.projectId, review.conversationId, review);
}

/** Waits for the person's decision on one action. Resolves "block" after the timeout or when the run is stopped. */
export function requestGuardianReview(input: Omit<GuardianReview, "id" | "createdAt" | "expiresAt">, signal?: AbortSignal, timeoutMs = REVIEW_TIMEOUT_MS): Promise<ReviewDecision> {
  const now = Date.now();
  const review: GuardianReview = {
    ...input, subject: input.subject.length > SUBJECT_LIMIT ? `${input.subject.slice(0, SUBJECT_LIMIT)}\n…` : input.subject,
    id: randomUUID(), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + timeoutMs).toISOString(),
  };
  return new Promise<ReviewDecision>((resolve) => {
    const settle = (decision: ReviewDecision) => {
      if (!pending.delete(review.id)) return;
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      changed(review);
      resolve(decision);
    };
    const stop = () => settle("block");
    const timer = setTimeout(stop, timeoutMs);
    signal?.addEventListener("abort", stop, { once: true });
    pending.set(review.id, { review, settle });
    changed(review);
    if (signal?.aborted) stop();
  });
}

/** The person's answer. Only the conversation the review belongs to can answer it. */
export function decideGuardianReview(projectId: string, conversationId: string, id: string, decision: ReviewDecision): boolean {
  const entry = pending.get(id);
  if (!entry || entry.review.projectId !== projectId || entry.review.conversationId !== conversationId) return false;
  entry.settle(decision);
  return true;
}

export function pendingGuardianReviews(projectId: string, conversationId: string): GuardianReview[] {
  return [...pending.values()].map(({ review }) => review).filter((review) => review.projectId === projectId && review.conversationId === conversationId);
}
