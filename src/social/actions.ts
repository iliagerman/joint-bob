import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { SocialPeerError } from "./network.js";
import { now, socialDatabase } from "./store.js";

// An assistant's public actions. The public part says what people may ask for; the owner's
// instructions say when to do it; operations are the only things execution can touch.

export const OPERATIONS = ["calendar.freebusy", "calendar.create", "info.share"] as const;
export type Operation = typeof OPERATIONS[number];

export interface PublicAction {
  id: string; assistantId: string; name: string; description: string; inputs: string; instructions: string;
  operations: Operation[]; shareText: string; status: "draft" | "published" | "disabled"; revision: number; updatedAt: string;
}

export const actionInputSchema = z.object({
  name: z.string().trim().min(1).max(80), description: z.string().trim().max(500), inputs: z.string().trim().max(300),
  instructions: z.string().trim().max(8000), operations: z.array(z.enum(OPERATIONS)).max(3), shareText: z.string().trim().max(4000),
}).strict();

const COLUMNS = "id, assistant_id assistantId, name, description, inputs, instructions, operations, share_text shareText, status, revision, updated_at updatedAt";
function parse(row: Record<string, unknown>): PublicAction {
  return { ...row, operations: JSON.parse(String(row.operations)) as Operation[] } as PublicAction;
}

export async function listActions(assistantId: string): Promise<PublicAction[]> {
  const db = await socialDatabase();
  return (db.prepare(`SELECT ${COLUMNS} FROM social_actions WHERE assistant_id=? ORDER BY status='published' DESC, name`).all(assistantId) as Array<Record<string, unknown>>).map(parse);
}

export async function getAction(assistantId: string, actionId: string): Promise<PublicAction> {
  const db = await socialDatabase();
  const row = db.prepare(`SELECT ${COLUMNS} FROM social_actions WHERE assistant_id=? AND id=?`).get(assistantId, actionId) as Record<string, unknown> | undefined;
  if (!row) throw new SocialPeerError("Action not found", 404);
  return parse(row);
}

/** Why an action cannot run for strangers yet, or null when it can be published. */
export function publishProblem(action: Pick<PublicAction, "name" | "operations" | "shareText">): string | null {
  if (!action.operations.length) return "Choose what this action is allowed to do before publishing it.";
  if (action.operations.includes("info.share") && !action.shareText.trim()) return "Write the text this action shares before publishing it.";
  if (action.operations.includes("info.share") && action.operations.some(operation => operation !== "info.share")) return "Sharing a text can't be combined with calendar access in one action.";
  return null;
}

export async function createAction(assistantId: string, input: z.infer<typeof actionInputSchema>): Promise<PublicAction> {
  const db = await socialDatabase();
  const id = randomUUID();
  db.prepare("INSERT INTO social_actions (id, assistant_id, name, description, inputs, instructions, operations, share_text, status, revision, updated_at) VALUES (?,?,?,?,?,?,?,?,'draft',1,?)")
    .run(id, assistantId, input.name, input.description, input.inputs, input.instructions, JSON.stringify([...new Set(input.operations)]), input.shareText, now());
  return getAction(assistantId, id);
}

/** Every change makes a new revision; approvals frozen against an older one can no longer run. */
export async function updateAction(assistantId: string, actionId: string, input: z.infer<typeof actionInputSchema>): Promise<PublicAction> {
  const current = await getAction(assistantId, actionId);
  const operations = [...new Set(input.operations)];
  if (current.status === "published") { const problem = publishProblem({ ...input, operations }); if (problem) throw new SocialPeerError(problem, 409); }
  const db = await socialDatabase();
  db.prepare("UPDATE social_actions SET name=?, description=?, inputs=?, instructions=?, operations=?, share_text=?, revision=revision+1, updated_at=? WHERE id=? AND assistant_id=?")
    .run(input.name, input.description, input.inputs, input.instructions, JSON.stringify(operations), input.shareText, now(), actionId, assistantId);
  await cancelOpenRequests(assistantId, actionId, "The action changed after this was proposed. Nothing happened.");
  return getAction(assistantId, actionId);
}

export async function setActionStatus(assistantId: string, actionId: string, status: "published" | "disabled"): Promise<PublicAction> {
  const current = await getAction(assistantId, actionId);
  if (status === "published") { const problem = publishProblem(current); if (problem) throw new SocialPeerError(problem, 409); }
  const db = await socialDatabase();
  db.prepare("UPDATE social_actions SET status=?, revision=revision+1, updated_at=? WHERE id=? AND assistant_id=?").run(status, now(), actionId, assistantId);
  if (status === "disabled") await cancelOpenRequests(assistantId, actionId, "You disabled this action. Nothing happened.");
  return getAction(assistantId, actionId);
}

export async function deleteAction(assistantId: string, actionId: string): Promise<void> {
  await getAction(assistantId, actionId);
  const db = await socialDatabase();
  await cancelOpenRequests(assistantId, actionId, "You deleted this action. Nothing happened.");
  db.prepare("DELETE FROM social_actions WHERE id=? AND assistant_id=?").run(actionId, assistantId);
}

/** Disabling or editing an action stops its proposals that are not already executing. */
async function cancelOpenRequests(assistantId: string, actionId: string, detail: string): Promise<void> {
  const db = await socialDatabase();
  db.prepare("UPDATE social_requests SET state='declined', detail=?, updated_at=? WHERE assistant_id=? AND action_id=? AND state IN ('awaiting-decision','awaiting-approval')").run(detail, now(), assistantId, actionId);
}

/** Binds an approval to the exact governing text: an edited instruction is a different decision. */
export function instructionsDigest(assistantInstructions: string, action: Pick<PublicAction, "instructions" | "revision">): string {
  return createHash("sha256").update(JSON.stringify([assistantInstructions, action.instructions, action.revision])).digest("hex");
}
