import { openAsBlob } from "node:fs";
import path from "node:path";

// Telegram replies for webhooks routed through an assistant: the answer goes back to the chat that
// asked. Code sends it, so the agent doesn't need network access or to handle the bot token.

const MESSAGE_LIMIT = 4096;
/** Leaves room for the tags formatting adds, so a formatted part still fits one message. */
const SOURCE_PART_LIMIT = 3500;
const SEND_TIMEOUT_MS = 15_000;
const TRANSFER_TIMEOUT_MS = 180_000;
export const TELEGRAM_DOWNLOAD_MAX_BYTES = 20 * 1024 * 1024;
export const TELEGRAM_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
export const TELEGRAM_TOKEN_VARIABLE = "TELEGRAM_BOT_TOKEN";

type Fields = Record<string, unknown>;
const fields = (value: unknown): Fields | undefined => value && typeof value === "object" ? value as Fields : undefined;

/** The message inside an update, for the update kinds that come from a chat. */
function updateMessage(data: unknown): Fields | undefined {
  const update = fields(data);
  if (!update) return undefined;
  for (const kind of ["message", "edited_message", "channel_post", "edited_channel_post", "business_message"]) {
    const message = fields(update[kind]);
    if (message) return message;
  }
  return fields(fields(update.callback_query)?.message);
}

export function telegramChatId(data: unknown): string | null {
  const id = fields(updateMessage(data)?.chat)?.id;
  return typeof id === "number" || typeof id === "string" ? String(id) : null;
}

/** What the person wrote or tapped, without the update's bookkeeping. */
export function telegramText(data: unknown): string | null {
  const message = updateMessage(data);
  const written = [fields(fields(data)?.callback_query)?.data, message?.text, message?.caption];
  return written.find((value): value is string => typeof value === "string" && value.trim() !== "") ?? null;
}

const escapeHtml = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Assistants answer in Markdown, which Telegram would show raw. This is the subset its HTML mode can display. */
export function telegramHtml(markdown: string): string {
  const kept: string[] = [];
  const keep = (html: string): string => `\u0000${kept.push(html) - 1}\u0000`;
  const withoutCode = markdown
    .replace(/```[^\n]*\n([\s\S]*?)```/g, (_match, code: string) => keep(`<pre>${escapeHtml(code.replace(/\n$/, ""))}</pre>`))
    .replace(/(?:^\|.*\|[ \t]*(?:\n|$))+/gm, table => `${keep(`<pre>${escapeHtml(table.trimEnd())}</pre>`)}\n`)
    .replace(/`([^`\n]+)`/g, (_match, code: string) => keep(`<code>${escapeHtml(code)}</code>`));
  return escapeHtml(withoutCode)
    .replace(/^\s*-{3,}\s*$/gm, "")
    .replace(/^(\s*)[-*]\s+/gm, "$1• ")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)"]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\s][^*\n]*)\*/gm, "$1<i>$2</i>")
    .replace(/~~([^~\n]+)~~/g, "<s>$1</s>")
    .replace(/^#{1,6}\s+(.+)$/gm, (_match, title: string) => `<b>${title.replace(/<\/?b>/g, "")}</b>`)
    .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => kept[Number(index)]);
}

/** Splits a long answer between paragraphs where it can, then lines, then words. */
export function telegramParts(text: string, limit = SOURCE_PART_LIMIT): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const breaks = ["\n\n", "\n", " "].map(separator => window.lastIndexOf(separator));
    const cut = breaks.find(index => index >= limit / 2) ?? limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

const telegramApi = (): string => process.env.JOINT_BOB_TELEGRAM_API || "https://api.telegram.org";

async function callTelegram(token: string, method: string, body: Fields, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(`${telegramApi()}/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  const answer = await response.json().catch(() => ({})) as { description?: string; result?: unknown };
  return { ok: response.ok, description: answer.description ?? `status ${response.status}`, result: answer.result };
}

async function requireTelegram(token: string, method: string, body: Fields): Promise<unknown> {
  const answer = await callTelegram(token, method, body);
  if (!answer.ok) throw new Error(answer.description);
  return answer.result;
}

export async function telegramBot(token: string): Promise<{ id: string; username: string; readsAllGroupMessages: boolean }> {
  const bot = fields(await requireTelegram(token, "getMe", {}));
  if (!bot || typeof bot.username !== "string") throw new Error("Telegram didn't describe this bot");
  return { id: String(bot.id), username: bot.username, readsAllGroupMessages: bot.can_read_all_group_messages === true };
}

/** Only messages and the bot's own membership reach Joint Bob, and each call carries the secret. */
export async function telegramSetWebhook(token: string, url: string, secretToken: string): Promise<void> {
  await requireTelegram(token, "setWebhook", { url, secret_token: secretToken, allowed_updates: ["message", "my_chat_member"], drop_pending_updates: true });
}
export async function telegramDeleteWebhook(token: string): Promise<void> { await requireTelegram(token, "deleteWebhook", {}); }
export async function telegramLeaveChat(token: string, chatId: string): Promise<void> { await requireTelegram(token, "leaveChat", { chat_id: chatId }); }

export async function sendTelegramReply(token: string, chatId: string, text: string, options: { replyTo?: number; fetchImpl?: typeof fetch } = {}): Promise<void> {
  const send = (message: Fields) => callTelegram(token, "sendMessage", { chat_id: chatId, ...message }, options.fetchImpl);
  let replying = options.replyTo === undefined ? {} : { reply_parameters: { message_id: options.replyTo, allow_sending_without_reply: true } };
  for (const part of telegramParts(text)) {
    const formatted = await send({ text: telegramHtml(part), parse_mode: "HTML", ...replying });
    if (!formatted.ok) {
      // Formatting Telegram rejects must not cost the person their answer.
      const plain = await send({ text: part.slice(0, MESSAGE_LIMIT), ...replying });
      if (!plain.ok) throw new Error(`Telegram refused the reply: ${plain.description}`);
    }
    replying = {};
  }
}

/** The download link holds the bot's token, so only this code ever sees it. */
export async function telegramDownload(token: string, fileId: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  const answer = await callTelegram(token, "getFile", { file_id: fileId }, fetchImpl);
  if (!answer.ok) throw new Error(answer.description);
  const filePath = fields(answer.result)?.file_path;
  if (typeof filePath !== "string") throw new Error("Telegram didn't say where the file is");
  const response = await fetchImpl(`${telegramApi()}/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Telegram didn't send the file: status ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

const SEND_METHODS: Record<string, { method: string; field: string }> = {
  ".jpg": { method: "sendPhoto", field: "photo" }, ".jpeg": { method: "sendPhoto", field: "photo" }, ".png": { method: "sendPhoto", field: "photo" }, ".webp": { method: "sendPhoto", field: "photo" },
  ".gif": { method: "sendAnimation", field: "animation" }, ".mp4": { method: "sendVideo", field: "video" },
  ".mp3": { method: "sendAudio", field: "audio" }, ".m4a": { method: "sendAudio", field: "audio" },
  ".ogg": { method: "sendVoice", field: "voice" }, ".oga": { method: "sendVoice", field: "voice" }, ".opus": { method: "sendVoice", field: "voice" },
};

async function postFile(token: string, method: string, field: string, chatId: string, file: Blob, name: string, extra: Record<string, string>, fetchImpl: typeof fetch) {
  const form = new FormData();
  form.append("chat_id", chatId);
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  form.append(field, file, name);
  const response = await fetchImpl(`${telegramApi()}/bot${token}/${method}`, { method: "POST", body: form, signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS) });
  const answer = await response.json().catch(() => ({})) as { description?: string };
  return { ok: response.ok, description: answer.description ?? `status ${response.status}` };
}

/** Sends a file the way Telegram shows its type best. Whatever that way refuses, such as a very large photo, still goes as a document. */
export async function sendTelegramFile(token: string, chatId: string, file: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const name = path.basename(file);
  const best = SEND_METHODS[path.extname(file).toLowerCase()];
  if (best && (await postFile(token, best.method, best.field, chatId, await openAsBlob(file), name, {}, fetchImpl)).ok) return;
  const plain = await postFile(token, "sendDocument", "document", chatId, await openAsBlob(file), name, {}, fetchImpl);
  if (!plain.ok) throw new Error(plain.description);
}

export async function sendTelegramVoice(token: string, chatId: string, mp3: Buffer, options: { replyTo?: number; fetchImpl?: typeof fetch } = {}): Promise<void> {
  const extra: Record<string, string> = options.replyTo === undefined ? {} : { reply_parameters: JSON.stringify({ message_id: options.replyTo, allow_sending_without_reply: true }) };
  const sent = await postFile(token, "sendVoice", "voice", chatId, new Blob([new Uint8Array(mp3)], { type: "audio/mpeg" }), "voice.mp3", extra, options.fetchImpl ?? fetch);
  if (!sent.ok) throw new Error(sent.description);
}

/** What can be read aloud from an answer. `complete` is false when something had to be left out, so the text goes too. */
export function telegramSpoken(markdown: string): { speech: string; complete: boolean } {
  let complete = true;
  const leaveOut = (kept = ""): string => { complete = false; return kept; };
  const speech = markdown
    .replace(/```[\s\S]*?```/g, () => leaveOut())
    .replace(/(?:^\|.*\|[ \t]*(?:\n|$))+/gm, () => leaveOut())
    .replace(/\[([^\]\n]+)\]\(https?:\/\/[^\s)]+\)/g, (_match, label: string) => leaveOut(label))
    .replace(/https?:\/\/\S+/g, () => leaveOut())
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^\s*-{3,}\s*$/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(^|[\s(])\*([^*\s][^*\n]*)\*/gm, "$1$2")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/\n{2,}/g, "\n")
    .trim();
  return { speech, complete };
}
