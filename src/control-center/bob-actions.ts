import type { DatabaseSync } from "node:sqlite";
import type { AuthSession } from "../auth.js";
import { appendBobMessage, clearBobActions, getBobMessage, type BobAction, type BobMessage } from "./bob-store.js";

export interface BobActionContext {
  session: AuthSession;
  db: DatabaseSync;
  /** The message that carried the button. */
  message: BobMessage;
  action: BobAction;
}

/** What an action answers with: messages to add to Bob's timeline. */
export type BobActionHandler = (context: BobActionContext) => Promise<BobMessage[] | void>;

const handlers = new Map<string, BobActionHandler>();

/** Features register what their buttons do, keyed by the action id they put on their messages. */
export function registerBobAction(id: string, handler: BobActionHandler): void {
  handlers.set(id, handler);
}

export class BobActionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Runs a button on one of the person's own messages. Only buttons the message really carries run, and each runs once. */
export async function runBobAction(db: DatabaseSync, session: AuthSession, messageId: string, actionId: string): Promise<BobMessage[]> {
  const message = getBobMessage(db, session.accountId, messageId);
  const action = message?.actions.find((candidate) => candidate.id === actionId);
  if (!message || !action) throw new BobActionError(404, "That button is no longer available");
  const handler = handlers.get(actionId);
  if (!handler) throw new BobActionError(404, "Bob cannot do that yet");
  clearBobActions(db, session.accountId, messageId);
  try {
    return (await handler({ session, db, message, action })) ?? [];
  } catch (error) {
    // The button comes back when the action did not happen.
    db.prepare("UPDATE control_center_bob_messages SET actions = ? WHERE account_id = ? AND id = ?").run(JSON.stringify(message.actions), session.accountId, messageId);
    throw error;
  }
}

/** Convenience for handlers that just answer in words. */
export function bobSays(db: DatabaseSync, session: AuthSession, text: string, extra: Parameters<typeof appendBobMessage>[2] extends infer T ? Partial<T> : never = {}): BobMessage {
  return appendBobMessage(db, session.accountId, { role: "bob", text, ...extra });
}
