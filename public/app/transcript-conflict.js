import { api } from "./api.js";
import { chooseOption, confirmAction, toast } from "./shell.js";
import { openSettings } from "./settings.js";
import { refreshSessionsQuietly } from "./socket.js";

let showing = false;

export function isTranscriptConflict(error) {
  return /Divergent transcript requires review/.test(error?.message || error || "");
}

export async function reconcileTranscriptConflict(error, { projectId, engine, sessionId } = {}) {
  if (!isTranscriptConflict(error)) return false;
  if (showing) return true;
  showing = true;
  try {
    const matches = [];
    let lookupError = "";
    if (projectId && engine && sessionId) {
      try {
        const { relationships } = await api("/api/twins");
        for (const relationship of relationships.filter((item) => item.status === "active")) {
          const status = await api(`/api/twins/${relationship.relationshipId}/sharing`);
          if (status.conflicts?.some((item) => item.projectId === projectId && item.engine === engine && item.sessionId === sessionId)) matches.push(relationship);
        }
      } catch (failure) { lookupError = failure.message; }
    }
    const match = !lookupError && matches.length === 1 ? matches[0] : null;
    const owner = match ? (match.peer?.name || match.peer?.nodeId || "the other machine") : null;
    const choice = await chooseOption({
      eyebrow: "Conversation history",
      title: "This conversation has two histories",
      message: `${owner ? `${owner} owns this conversation: it holds permission to continue the original.` : "The owner could not be identified from a unique local conflict. Check synchronization details on the destination machine."} Nothing will be overwritten without confirmation. Automatic merging is not available.${lookupError ? ` Lookup failed: ${lookupError}` : ""}`,
      options: [
        { value: "keep", label: "Decide later", hint: "Leave both histories untouched. The conflict remains unresolved." },
        { value: "fork", label: "Fork this machine's history into a new conversation", hint: "Create an independent local conversation. Neither original history nor its ownership changes. The original conflict remains unresolved.", disabled: !match },
        { value: "owner", label: owner ? `Use ${owner}'s history` : "Use the owner's history", hint: "Back up this machine's history, then replace it with the owner's version.", disabled: !match },
        { value: "review", label: "Review synchronization details", hint: "Open Settings → Cluster to inspect the conflicting conversation and its machines." },
      ],
    });
    if (!choice || choice === "keep") return true;
    if (choice === "review") { await openSettings("cluster"); return true; }
    if (!match) return true;
    const base = `/api/twins/${match.relationshipId}/transcript-conflicts`;
    if (choice === "fork") {
      const { session } = await api(`${base}/fork`, { method: "POST", body: JSON.stringify({ projectId, engine, sessionId }) });
      toast(`Created ${session.title}. Open it from the project's conversations. The original histories are unchanged.`, 12000);
      await refreshSessionsQuietly();
      return true;
    }
    if (!await confirmAction({
      eyebrow: "Conversation history", title: `Use ${owner}'s history?`,
      message: "This machine's version will be saved to a file first. Its unique messages will not appear in the active conversation. No messages will be sent and ownership will not move automatically.",
      confirmLabel: "Back up and replace",
    })) return true;
    const { saved } = await api(`${base}/accept`, {
      method: "POST", body: JSON.stringify({ projectId, engine, sessionId, confirmReplaceLocal: true }),
    });
    toast(`History reconciled. Backup: ${saved}. Reopen the conversation and retry the transfer.`, 12000);
    return true;
  } catch (failure) {
    toast(`Could not reconcile history: ${failure.message}`, 10000);
    return true;
  } finally { showing = false; }
}
