import { request } from "./api.js";
import { app, fail, notify } from "./context.js";
import { h } from "./dom.js";

// The private chat: one timeline over the assistant's topics.

let pendingTurn = null;

export async function showTranscript() {
  const target = document.querySelector("#timeline");
  const { timeline } = await request(`/api/personal-assistants/${app.assistant.id}/transcript`);
  target.replaceChildren(...timeline.map(item => h("div", { class: `chat-bubble ${item.role === "user" ? "user" : "assistant"}` }, item.text)));
  const scroll = document.querySelector("#chat-scroll");
  scroll.scrollTop = scroll.scrollHeight;
}

async function sendTurn(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const field = document.querySelector("#chat-message");
  const button = form.querySelector("button[type=submit]");
  const content = field.value.trim();
  if (!content) return;
  if (pendingTurn && pendingTurn.message !== content) { notify("Retry the pending message before editing it.", true); return; }
  pendingTurn ??= { requestId: crypto.randomUUID(), message: content };
  button.disabled = true;
  notify("Thinking…");
  try {
    const recentMessages = [...document.querySelectorAll("#timeline .chat-bubble")].slice(-6).map(bubble => bubble.textContent.slice(0, 4000));
    await request(`/api/personal-assistants/${app.assistant.id}/turn`, { method: "POST", body: JSON.stringify({ requestId: pendingTurn.requestId, message: content, recentMessages }) });
    pendingTurn = null;
    field.value = "";
    await showTranscript();
    notify("");
  } catch (error) { await showTranscript().catch(() => {}); fail(error); }
  finally { button.disabled = false; }
}

const automationDialog = () => document.querySelector("#assistant-automation-dialog");
const automationFrame = () => document.querySelector("#assistantAutomationFrame");

function openAutomation(action) {
  const target = new URL("/", location.origin);
  target.searchParams.set("projectId", app.assistant.projectId);
  target.searchParams.set("sessionId", app.assistant.sessionId);
  if (app.assistant.nodeId) target.searchParams.set("nodeId", app.assistant.nodeId);
  target.searchParams.set("assistantId", app.assistant.id);
  target.searchParams.set("assistantAction", action);
  target.searchParams.set("assistantAutomation", "1");
  automationFrame().src = target.toString();
  automationDialog().showModal();
}

/** "Waiting for you" above the chat, from the assistant's activity. */
export function showWaitingStrip(counts, openActivity) {
  const strip = document.querySelector("#waiting-strip");
  const parts = [counts.approvals ? `${counts.approvals} approval${counts.approvals > 1 ? "s" : ""}` : "", counts.notices ? `${counts.notices} notice${counts.notices > 1 ? "s" : ""}` : "", counts.signIns ? `${counts.signIns} sign-in${counts.signIns > 1 ? "s" : ""}` : ""].filter(Boolean);
  strip.classList.toggle("hidden", !parts.length);
  document.querySelector("#waiting-text").textContent = parts.length ? `Waiting for you: ${parts.join(", ")}` : "";
  document.querySelector("#waiting-review").onclick = openActivity;
}

export function bindChat() {
  document.querySelector("#chat-form").addEventListener("submit", sendTurn);
  document.querySelector("#chat-message").addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form.requestSubmit(); }
  });
  document.querySelector("#new-scheduled-task").addEventListener("click", () => openAutomation("cron"));
  document.querySelector("#new-webhook").addEventListener("click", () => openAutomation("webhook"));
  automationDialog().addEventListener("close", () => automationFrame().removeAttribute("src"));
  window.addEventListener("message", event => {
    if (event.origin === location.origin && event.source === automationFrame().contentWindow && event.data === "assistant-automation-close") automationDialog().close();
  });
}
