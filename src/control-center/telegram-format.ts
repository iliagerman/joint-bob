import type { BobImportance, BobMessage } from "./bob-store.js";

/** What of Bob's timeline goes to Telegram on its own, and how it looks there. */

/** Messages that matter enough to interrupt the person. Everything else waits in the app. */
const PUSHED: readonly BobImportance[] = ["needs-ok", "urgent", "needs-you", "report"];

export function wantsTelegramPush(message: Pick<BobMessage, "role" | "importance">): boolean {
  return message.role !== "user" && PUSHED.includes(message.importance);
}

const LABELS: Record<BobImportance, string> = { "needs-ok": "Needs your OK", urgent: "Urgent", "needs-you": "Needs you", report: "Report", done: "Done", fyi: "FYI" };

/** A message Bob sends unprompted says how much it matters and which project it is about. Markdown, as Bob writes. */
export function pushedText(message: Pick<BobMessage, "importance" | "projectName" | "text" | "via">): string {
  const head = [LABELS[message.importance], message.projectName].filter(Boolean).join(" · ").replaceAll("*", "");
  return [`**${head}**`, message.text.trim(), message.via ?? ""].filter(Boolean).join("\n\n");
}

export interface InlineButton { text: string; callback_data?: string; url?: string }
export interface InlineKeyboard { inline_keyboard: InlineButton[][] }

/** Pressed buttons, answered with nothing: they stay on the message to show what was chosen. */
export const SETTLED_BUTTON = "settled";
const CALLBACK = /^b:([0-9a-f-]{36}):(\d{1,3})$/;
/** Telegram keeps a button's data to 64 bytes, so it names the message and the place of the button, not the action. */
export const callbackData = (messageId: string, index: number): string => `b:${messageId}:${index}`;

export function parseCallbackData(data: string): { messageId: string; index: number } | null {
  const match = CALLBACK.exec(data);
  return match ? { messageId: match[1], index: Number(match[2]) } : null;
}

/** Where the app opens a conversation, from what a button's `open` names. */
function openUrl(appUrl: string, open: unknown): string {
  const target = open && typeof open === "object" ? open as { projectId?: unknown; conversationId?: unknown } : {};
  const link = new URL("/", appUrl);
  if (typeof target.projectId === "string" && typeof target.conversationId === "string") {
    link.searchParams.set("projectId", target.projectId);
    link.searchParams.set("sessionId", target.conversationId);
  }
  return link.toString();
}

/**
 * The message's buttons as an inline keyboard. A button that opens a page of the app is a link when the app has an address
 * Telegram can open, and is left out otherwise; every other button is pressed in Telegram and answered by Bob.
 */
export function keyboardFor(message: Pick<BobMessage, "id" | "actions">, appUrl: string | null): InlineKeyboard | null {
  const buttons: InlineButton[] = [];
  message.actions.forEach((action, index) => {
    if (action.data?.open !== undefined) { if (appUrl) buttons.push({ text: action.label, url: openUrl(appUrl, action.data.open) }); return; }
    buttons.push({ text: action.label, callback_data: callbackData(message.id, index) });
  });
  const rows: InlineButton[][] = [];
  for (let start = 0; start < buttons.length; start += 2) rows.push(buttons.slice(start, start + 2));
  return rows.length ? { inline_keyboard: rows } : null;
}

/** Telegram opens only addresses it can reach: a secure one that is not this machine's own. */
export function telegramReachableUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const local = url.hostname === "localhost" || url.hostname === "[::1]" || /^(127|10)\./.test(url.hostname) || /^192\.168\./.test(url.hostname);
    return url.protocol === "https:" && !local ? url.origin : null;
  } catch { return null; }
}
