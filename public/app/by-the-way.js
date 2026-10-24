import { openConversationChat } from "./conversation-chat.js";

// /bob-btw uses the persistent, text-only side chat, never a writable transcript fork.
export function openByTheWay() {
  return openConversationChat();
}
