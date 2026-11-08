import type { Webhook, WebhookCall } from "../webhooks.js";

/**
 * Where the control center learns that a webhook received a call. The webhook code announces each call it accepts
 * (one line in `acceptWebhookCall`) and knows nothing else about Bob; the control center listens.
 */
export type AcceptedWebhookCall = { webhook: Webhook; call: Pick<WebhookCall, "headers" | "body" | "data" | "sender" | "requestId"> };

const listeners = new Set<(accepted: AcceptedWebhookCall) => Promise<void>>();

export function onWebhookCall(listener: (accepted: AcceptedWebhookCall) => Promise<void>): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Never throws and never waits: a listener's failure is logged and cannot hold up or break the delivery. */
export function announceWebhookCall(webhook: Webhook, call: AcceptedWebhookCall["call"]): void {
  for (const listener of listeners) {
    void listener({ webhook, call }).catch((error) => console.warn(`Bob could not take in a call to webhook ${webhook.id}`, error instanceof Error ? error.message : error));
  }
}
