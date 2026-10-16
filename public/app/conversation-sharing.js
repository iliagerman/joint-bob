import { elements } from "./elements.js";
import { menuIcon } from "./icons.js";
import { state } from "./state.js";
import { toast } from "./shell.js";

/** Links identify a conversation without including its transcript or local file path. */
export function getCurrentConversationLink() {
  const conversationId = state.activeConversationId || state.activeSessionId;
  if (!conversationId) return null;
  const url = new URL(window.location.origin);
  url.searchParams.set("sessionId", conversationId);
  const projectId = state.activeConversationProjectId || state.activeProjectId;
  if (projectId) url.searchParams.set("projectId", projectId);
  if (state.activeNodeId) url.searchParams.set("nodeId", state.activeNodeId);
  return url.toString();
}

export function getCurrentConversationTitle() {
  const projectId = state.activeConversationProjectId || state.activeProjectId;
  const project = state.projects.find((candidate) => candidate.id === projectId);
  const title = elements.sessionTitle.textContent;
  return project ? `${title} • ${project.name}` : title;
}

export async function copyConversationLink(successMessage = "Conversation link copied to clipboard") {
  const link = getCurrentConversationLink();
  if (!link) { toast("No active conversation to share"); return; }
  try {
    await navigator.clipboard.writeText(link);
    toast(successMessage);
  } catch (error) {
    toast(`Failed to copy link: ${error.message}`);
  }
}

export async function shareConversation() {
  const link = getCurrentConversationLink();
  if (!link) { toast("No active conversation to share"); return; }
  if (!navigator.share) { await copyConversationLink(); return; }
  try {
    await navigator.share({ title: getCurrentConversationTitle(), url: link });
  } catch (error) {
    if (error.name !== "AbortError") toast(`Failed to share link: ${error.message}`);
  }
}

const shareButton = document.createElement("button");
shareButton.id = "shareConversationButton";
shareButton.className = "ghost compact chat-action";
shareButton.type = "button";
shareButton.dataset.testid = "chat-share-button";
shareButton.title = "Share conversation";
shareButton.setAttribute("aria-label", "Share conversation");
const shareLabel = document.createElement("span");
shareLabel.className = "chat-action-label";
shareLabel.textContent = "Share";
shareButton.append(menuIcon("share"), shareLabel);
shareButton.addEventListener("click", () => void shareConversation());
const pinButton = document.createElement("button");
pinButton.id = "pinConversationButton";
pinButton.className = "ghost compact chat-action";
pinButton.type = "button";
pinButton.dataset.testid = "chat-pin-button";
pinButton.title = "Copy conversation link for a home-screen shortcut";
pinButton.setAttribute("aria-label", "Copy conversation link for home screen");
const pinLabel = document.createElement("span");
pinLabel.className = "chat-action-label";
pinLabel.textContent = "Copy home-screen link";
pinButton.append(menuIcon("pin"), pinLabel);
pinButton.addEventListener("click", () => void copyConversationLink("Link copied. Open Chrome, paste it, then tap ⋮ → Add to Home screen."));
elements.chatMoreMenu.querySelector(".chat-more-actions").append(shareButton, pinButton);
