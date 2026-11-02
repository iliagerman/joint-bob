import { assistantGroupMessages } from "./events.js";
import { retryOutbox } from "./groups.js";
import { socialDatabase } from "./store.js";

/** After this machine reconnects to a relay: assistants read what they missed and waiting
    sends go to their hosts. Each step resumes from its saved cursor or outbox entry. */
export async function socialCatchUp(): Promise<void> {
  const db = await socialDatabase();
  for (const row of db.prepare("SELECT group_id groupId, assistant_id assistantId FROM social_assistant_groups WHERE status='active'").all() as Array<{ groupId: string; assistantId: string }>) {
    assistantGroupMessages(row.groupId, [row.assistantId]);
  }
  for (const row of db.prepare("SELECT DISTINCT group_id groupId, account_id accountId FROM social_outbox WHERE status='pending'").all() as Array<{ groupId: string; accountId: string }>) {
    await retryOutbox(row.accountId, row.groupId).catch(error => console.warn(`Social: waiting messages for group ${row.groupId} are still queued: ${error instanceof Error ? error.message : error}`));
  }
}
