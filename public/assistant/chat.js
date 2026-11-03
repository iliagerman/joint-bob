import { request } from "./api.js";
import { app, fail, notify } from "./context.js";
import { h, markdownBubble } from "./dom.js";

// The private chat: one timeline over the assistant's topics.

let pendingTurn = null;
let timelineTexts = [];

/** A webhook's message holds its instructions and raw payload, so it stays folded behind who sent it. */
function userBubble(text) {
  const webhook = /^(?:[^\n]*\n)*?\[Joint Bob webhook: (.+)\]/.exec(text);
  if (!webhook) return h("div", { class: "chat-bubble user" }, text);
  const sender = /^Sender: (.+?)\. This sender/m.exec(text)?.[1];
  const said = /"(?:text|caption)":\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1];
  let words = said;
  try { words = said === undefined ? undefined : JSON.parse(`"${said}"`); } catch { words = said; }
  return h("details", { class: "chat-bubble user webhook" },
    h("summary", {}, `From ${webhook[1]}${sender ? ` · ${sender}` : ""}`, words ? h("small", {}, words) : null),
    h("pre", {}, text));
}

export async function showTranscript() {
  const target = document.querySelector("#timeline");
  const { timeline } = await request(`/api/personal-assistants/${app.assistant.id}/transcript`);
  timelineTexts = timeline.map(item => item.text);
  target.replaceChildren(...timeline.map(item => item.role === "user" ? userBubble(item.text) : markdownBubble("chat-bubble assistant", item.text)));
  const scroll = document.querySelector("#chat-scroll");
  scroll.scrollTop = scroll.scrollHeight;
}

async function sendTurn(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const field = document.querySelector("#chat-message");
  const button = form.querySelector("button[type=submit]");
  if (button.disabled) return; // The keyboard shortcut submits even while a turn is running.
  const content = field.value.trim();
  if (!content) return;
  if (pendingTurn && pendingTurn.message !== content) { notify("Retry the pending message before editing it.", true); return; }
  pendingTurn ??= { requestId: crypto.randomUUID(), message: content };
  button.disabled = true;
  field.value = "";
  const recentMessages = timelineTexts.slice(-6).map(text => text.slice(0, 4000));
  const stopWorking = showWorking(content);
  try {
    await request(`/api/personal-assistants/${app.assistant.id}/turn`, { method: "POST", body: JSON.stringify({ requestId: pendingTurn.requestId, message: content, recentMessages }) });
    pendingTurn = null;
    await showTranscript();
  } catch (error) {
    // Unsent: put it back ahead of anything typed meanwhile, so Send retries it as the same turn.
    if (pendingTurn) field.value = field.value.trim() ? `${content}\n\n${field.value}` : content;
    await showTranscript().catch(() => {});
    fail(error);
  }
  finally { stopWorking(); button.disabled = false; }
}

/** Until the answer arrives, the sent message and how long the assistant has been at it stay in
    the chat. A turn can wait behind another one, so a passing status line is not enough. */
function showWorking(content) {
  const status = h("div", { class: "chat-working", role: "status", "data-testid": "assistant-working" }, "Working on it…");
  document.querySelector("#timeline").append(h("div", { class: "chat-bubble user pending" }, content), status);
  const scroll = document.querySelector("#chat-scroll");
  scroll.scrollTop = scroll.scrollHeight;
  const started = Date.now();
  const timer = setInterval(() => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    status.textContent = `Working on it… ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }, 1000);
  return () => clearInterval(timer);
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
