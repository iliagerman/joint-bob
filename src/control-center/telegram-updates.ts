import type { TelegramConnection } from "./telegram-store.js";

/**
 * Decides what one update from Telegram may do, before anything runs. Bob's bot answers one person: the Telegram account
 * linked to it, in its own private chat. Anyone else, in any chat, gets no answer at all, and a group is left.
 */

export interface TelegramVoice { fileId: string; name: string; mimeType: string; bytes: number | null }

export type TelegramVerdict =
  | { kind: "ignore" }
  | { kind: "leave"; chatId: string }
  /** Someone opened the one-time link. Whether it links them is decided against the stored code. */
  | { kind: "link"; chatId: string; userId: string; name: string; code: string }
  | { kind: "start"; chatId: string }
  | { kind: "message"; chatId: string; text: string; voice: TelegramVoice | null }
  | { kind: "callback"; callbackId: string; chatId: string; messageId: number; data: string };

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Fields : undefined;
const personName = (person: Fields): string => [person.first_name, person.last_name].filter((value) => typeof value === "string" && value).join(" ") || (typeof person.username === "string" ? person.username : String(person.id));
/** Statuses of the bot in a chat it was just put into. */
const JOINED = ["member", "administrator", "restricted"];

function voiceOf(message: Fields): TelegramVoice | null {
  for (const [key, name, fallbackType] of [["voice", "voice.ogg", "audio/ogg"], ["video_note", "video-note.mp4", "video/mp4"]] as const) {
    const file = fields(message[key]);
    if (typeof file?.file_id !== "string") continue;
    // The type is claimed by the sender, so only a plausible one is kept.
    const mimeType = typeof file.mime_type === "string" && /^[\w.+-]{1,60}\/[\w.+-]{1,59}$/.test(file.mime_type) ? file.mime_type : fallbackType;
    return { fileId: file.file_id, name, mimeType, bytes: typeof file.file_size === "number" ? file.file_size : null };
  }
  return null;
}

export function readTelegramUpdate(known: TelegramConnection, update: unknown): TelegramVerdict {
  const data = fields(update);
  const change = fields(data?.my_chat_member);
  if (change) {
    // Whoever puts the bot into a group or channel, the owner included: it leaves at once and never answers there.
    const chat = fields(change.chat);
    return chat && chat.type !== "private" && JOINED.includes(String(fields(change.new_chat_member)?.status)) ? { kind: "leave", chatId: String(chat.id) } : { kind: "ignore" };
  }
  const query = fields(data?.callback_query);
  const message = fields(query ? query.message : data?.message);
  const chat = fields(message?.chat);
  const from = fields(query ? query.from : message?.from);
  if (!message || !chat || !from) return { kind: "ignore" };
  if (chat.type !== "private") return { kind: "leave", chatId: String(chat.id) };
  if (from.is_bot === true) return { kind: "ignore" };
  const chatId = String(chat.id), userId = String(from.id);
  // The linked account, writing in its own private chat with the bot (a private chat has the person's own id).
  const isPerson = known.telegramUserId !== null && userId === known.telegramUserId && chatId === userId;
  if (query) {
    return isPerson ? { kind: "callback", callbackId: String(query.id), chatId, messageId: Number(message.message_id), data: typeof query.data === "string" ? query.data : "" } : { kind: "ignore" };
  }
  const text = [message.text, message.caption].find((words): words is string => typeof words === "string" && words !== "") ?? "";
  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?$/.exec(text.trim());
  // The one-time link is how an account becomes the person, so it is read from anyone in a private chat.
  if (start?.[1] && chatId === userId) return { kind: "link", chatId, userId, name: personName(from), code: start[1] };
  if (!isPerson) return { kind: "ignore" };
  if (start) return { kind: "start", chatId };
  return { kind: "message", chatId, text, voice: voiceOf(message) };
}
