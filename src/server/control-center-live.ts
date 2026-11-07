import { currentActivity } from "../control-center/activity.js";
import { harnessSessions, harnessTurnBusy } from "./harness-sessions.js";

/** What a turn this machine runs is doing now, read from its live events; null when no turn of it runs here. */
export function liveActivity(projectId: string, conversationId: string): string | null {
  const shared = [...harnessSessions.values()].find((entry) => entry.projectId === projectId && entry.conversationId === conversationId && harnessTurnBusy(entry));
  return shared ? currentActivity(shared.liveEvents) : null;
}
