import { telegramHtml, telegramLeaveChat, telegramParts } from "../webhook-telegram.js";
import type { InlineKeyboard } from "./telegram-format.js";

/** What Bob's bot asks of Telegram. Each call is made with the bot's token, which only this code ever holds. */

const MESSAGE_LIMIT = 4096;
const CALL_TIMEOUT_MS = 15_000;
const telegramApi = (): string => process.env.JOINT_BOB_TELEGRAM_API || "https://api.telegram.org";

export interface TelegramApi {
  /** Sends text, split into messages that fit; the keyboard goes on the last one. Returns the ids of what was sent. */
  send(chatId: string, text: string, keyboard?: InlineKeyboard | null): Promise<number[]>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
  /** Replaces the buttons under a message, or takes them away. */
  setKeyboard(chatId: string, messageId: number, keyboard: InlineKeyboard | null): Promise<void>;
  typing(chatId: string): Promise<void>;
  leave(chatId: string): Promise<void>;
}

type Body = Record<string, unknown>;

async function call(token: string, method: string, body: Body, fetchImpl: typeof fetch): Promise<{ ok: boolean; description: string; result: unknown }> {
  const response = await fetchImpl(`${telegramApi()}/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
  const answer = await response.json().catch(() => ({})) as { description?: string; result?: unknown };
  return { ok: response.ok, description: answer.description ?? `status ${response.status}`, result: answer.result };
}

/** Telegram accepts a webhook only for the updates asked for here: messages, button presses and the bot being put in a chat. */
export async function setBobWebhook(token: string, url: string, secretToken: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const answer = await call(token, "setWebhook", { url, secret_token: secretToken, allowed_updates: ["message", "callback_query", "my_chat_member"], drop_pending_updates: true }, fetchImpl);
  if (!answer.ok) throw new Error(answer.description);
}

export function telegramApiFor(token: string, fetchImpl: typeof fetch = fetch): TelegramApi {
  const ask = async (method: string, body: Body): Promise<unknown> => {
    const answer = await call(token, method, body, fetchImpl);
    if (!answer.ok) throw new Error(`Telegram refused ${method}: ${answer.description}`);
    return answer.result;
  };
  return {
    async send(chatId, text, keyboard) {
      const parts = telegramParts(text.trim() || "(nothing to say)");
      const sent: number[] = [];
      for (const [index, part] of parts.entries()) {
        const markup = keyboard && index === parts.length - 1 ? { reply_markup: keyboard } : {};
        const formatted = await call(token, "sendMessage", { chat_id: chatId, text: telegramHtml(part), parse_mode: "HTML", ...markup }, fetchImpl);
        // Formatting Telegram rejects must not cost the person their answer.
        const delivered = formatted.ok ? formatted : await call(token, "sendMessage", { chat_id: chatId, text: part.slice(0, MESSAGE_LIMIT), ...markup }, fetchImpl);
        if (!delivered.ok) throw new Error(`Telegram refused the message: ${delivered.description}`);
        const id = (delivered.result as { message_id?: unknown } | undefined)?.message_id;
        if (typeof id === "number") sent.push(id);
      }
      return sent;
    },
    async answerCallback(callbackId, text) {
      await ask("answerCallbackQuery", { callback_query_id: callbackId, ...text ? { text: text.slice(0, 200) } : {} });
    },
    async setKeyboard(chatId, messageId, keyboard) {
      await ask("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: keyboard ?? { inline_keyboard: [] } });
    },
    async typing(chatId) { await ask("sendChatAction", { chat_id: chatId, action: "typing" }); },
    leave: (chatId) => telegramLeaveChat(token, chatId),
  };
}
