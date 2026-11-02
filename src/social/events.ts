import { EventEmitter } from "node:events";

// Local change signals. Machines push "changed" to each other; this emitter tells this
// machine's open pages and its assistants that something they follow moved.

export type SocialChange =
  | { kind: "group"; groupId: string; accountIds: string[] }
  | { kind: "thread"; threadId: string; accountIds: string[] }
  | { kind: "invitations"; accountIds: string[] }
  | { kind: "activity"; assistantId: string; accountIds: string[] };

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function emitSocialChange(change: SocialChange): void { emitter.emit("change", change); }

export function onSocialChange(listener: (change: SocialChange) => void): () => void {
  emitter.on("change", listener);
  return () => emitter.off("change", listener);
}

type ThreadMonitor = (threadId: string, messageId: string) => void;
const threadMonitors: ThreadMonitor[] = [];
export function onAssistantThreadMessage(monitor: ThreadMonitor): void { threadMonitors.push(monitor); }
export function assistantThreadMessage(threadId: string, messageId: string): void {
  for (const monitor of threadMonitors) monitor(threadId, messageId);
}

type GroupMonitor = (groupId: string, assistantIds: string[]) => void;
const groupMonitors: GroupMonitor[] = [];
/** The request pipeline registers here so group code never imports it. */
export function onAssistantGroupMessages(monitor: GroupMonitor): void { groupMonitors.push(monitor); }
export function assistantGroupMessages(groupId: string, assistantIds: string[]): void {
  for (const monitor of groupMonitors) monitor(groupId, assistantIds);
}
