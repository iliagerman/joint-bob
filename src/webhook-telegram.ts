// Telegram replies for webhooks routed through an assistant: the answer goes back to the chat that
// asked. Code sends it, so the agent doesn't need network access or to handle the bot token.

const MESSAGE_LIMIT = 4096;
/** Leaves room for the tags formatting adds, so a formatted part still fits one message. */
const SOURCE_PART_LIMIT = 3500;
const SEND_TIMEOUT_MS = 15_000;
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

export async function sendTelegramReply(token: string, chatId: string, text: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const api = process.env.JOINT_BOB_TELEGRAM_API || "https://api.telegram.org";
  const send = async (message: Fields) => {
    const response = await fetchImpl(`${api}/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, ...message }), signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const answer = await response.json().catch(() => ({})) as { description?: string };
    return { ok: response.ok, description: answer.description ?? `status ${response.status}` };
  };
  for (const part of telegramParts(text)) {
    if ((await send({ text: telegramHtml(part), parse_mode: "HTML" })).ok) continue;
    // Formatting Telegram rejects must not cost the person their answer.
    const plain = await send({ text: part.slice(0, MESSAGE_LIMIT) });
    if (!plain.ok) throw new Error(`Telegram refused the reply: ${plain.description}`);
  }
}
