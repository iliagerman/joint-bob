import path from "node:path";
import type { AuthSession } from "../auth.js";
import { getClusterNode } from "../cluster.js";
import { bobAutoRespondConfig } from "../control-center/auto-respond.js";
import type { BobSettings } from "../control-center/bob-store.js";
import { recordBobStart } from "../control-center/started.js";
import { enableAutoRespond } from "../conversation-auto-respond.js";
import { getConversationRecord } from "../conversation-records.js";
import { createQuickNote } from "../quick-notes.js";
import type { HarnessId, ProjectRecord } from "../types.js";
import { persistTaskAttachments, promptTextWithAttachments } from "./chat.js";
import type { PromptAttachment } from "./conversation-prompt.js";
import { launchQuickNote } from "./quick-note-dispatch.js";

/** What the person attached to their message to Bob, as the conversation message box sends it. */
export interface BobAttachments { images: PromptAttachment[]; files: PromptAttachment[] }

/** Saves attachments into the project's attachments folder, where the agent reading the message can open them by path. */
export async function saveBobAttachments(project: ProjectRecord, attachments: BobAttachments): Promise<Array<{ kind: "image" | "file"; name: string; path: string }>> {
  const saved = await persistTaskAttachments(project.path, attachments.images, attachments.files);
  return saved.map((attachment) => ({ kind: attachment.kind, name: attachment.name, path: path.resolve(project.path, attachment.path) }));
}

async function turnOnAutoRespond(session: AuthSession, settings: BobSettings, projectId: string, harnessId: HarnessId, sessionId: string, nodeId: string | null): Promise<string> {
  if (nodeId && nodeId !== (await getClusterNode()).id) return " Auto respond stays off: it only runs on the machine that owns the conversation.";
  try {
    const record = await getConversationRecord(projectId, harnessId, sessionId);
    await enableAutoRespond(projectId, record?.conversationId ?? sessionId, await bobAutoRespondConfig(settings, harnessId), null, session.accountId);
    return " I turned on auto respond for it: I'll answer its routine questions, and it stops for anything that needs you.";
  } catch (error) {
    return ` I could not turn on auto respond: ${error instanceof Error ? error.message : "unknown error"}.`;
  }
}

export function titleOf(message: string): string {
  const line = message.split("\n")[0].trim();
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

/**
 * Starts a conversation in a project the way Bob starts work: a quick note launched with the given agent, marked as started by
 * Bob, with auto respond turned on when asked. The note to add to Bob's reply says what happened with auto respond.
 */
export async function startBobConversation(args: { session: AuthSession; settings: BobSettings; project: ProjectRecord; title: string; brief: string; harnessId: string; autoRespond: boolean; attachments?: BobAttachments }): Promise<{ sessionId: string | null; autoRespondNote: string }> {
  // Images go with the note, as a pasted image goes with a message; files wait in the project, where the note runs, and the brief names them.
  const images = (args.attachments?.images ?? []).map(({ name, mimeType, data }) => ({ kind: "image" as const, name, mimeType, data }));
  const files = args.attachments?.files.length ? await saveBobAttachments(args.project, { images: [], files: args.attachments.files }) : [];
  const brief = files.length ? promptTextWithAttachments(args.brief, [], files) : args.brief;
  const note = createQuickNote({ projectId: args.project.id, title: args.title, content: brief, harnessId: args.harnessId, images });
  const started = await launchQuickNote(note.id);
  if (started.sessionId) await recordBobStart(args.project.id, started.sessionId, args.session.accountId);
  const autoRespondNote = started.sessionId && args.autoRespond
    ? await turnOnAutoRespond(args.session, args.settings, args.project.id, args.harnessId as HarnessId, started.sessionId, note.nodeId)
    : "";
  return { sessionId: started.sessionId ?? null, autoRespondNote };
}
