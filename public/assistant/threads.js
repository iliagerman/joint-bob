import { post, request } from "./api.js";
import { app, fail, isMobile } from "./context.js";
import { bot, h, icon, markdownBubble, requestSteps, stateLabel, trail } from "./dom.js";

// Direct requests: your thread with someone else's assistant, hosted on its machine.

let current = null;

export async function loadThreads() {
  const { threads } = await request("/api/social/threads");
  app.threads = threads;
  return threads;
}

export function threadStatus(thread) { return `${thread.ownerName}'s assistant`; }

function messageNodes(detail) {
  const owner = detail.assistant.ownerName.split(" ")[0] || detail.assistant.ownerName;
  return detail.messages.flatMap(message => message.author === "requester"
    ? [h("div", { class: "m me" }, h("div", { class: "bubble" }, message.text)), message.state && message.state !== "recorded" ? h("div", { "aria-label": stateLabel(message.state) }, trail(requestSteps(message.state, `${owner}'s`))) : null]
    : [h("div", { class: "m bot-msg" }, bot("other"), h("div", {}, h("div", { class: "who" }, h("b", {}, detail.assistant.name), `Assistant · For ${owner}`), markdownBubble("bubble", message.text)))]);
}

export async function showThread(threadId) {
  const detail = await request(`/api/social/threads/${threadId}`);
  current = threadId;
  const target = document.querySelector("#social-view");
  const owner = detail.assistant.ownerName.split(" ")[0] || detail.assistant.ownerName;
  const box = h("textarea", { rows: 1, required: true, maxlength: 4000, placeholder: `Ask ${detail.assistant.name}…`, "aria-label": `Ask ${detail.assistant.name}` });
  const form = h("form", { class: "composer", id: "thread-composer" }, box, h("div", { class: "composer-foot" }, h("span", { class: "spacer" }, "Only what's listed above can be requested"), h("button", { type: "submit", class: "primary icon", "aria-label": "Send" }, icon("send"))));
  box.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const text = box.value.trim();
    if (!text) return;
    try { await post(`/api/social/threads/${threadId}/messages`, { id: crypto.randomUUID(), text }); box.value = ""; await showThread(threadId); }
    catch (error) { fail(error); }
  });
  const scroll = h("div", { class: "scroll" }, h("div", { class: "msgs", "data-testid": "assistant-thread-messages" },
    h("div", { class: "notice plain", style: "margin:0" }, icon("lock"), h("span", {}, `This thread is between you and this assistant. It can't use ${owner}'s private chats, and only ${owner} can review what it does here.`)),
    detail.online ? null : h("div", { class: "notice" }, icon("alert"), h("span", {}, "The assistant's machine is offline. Try again when it's back.")),
    detail.catalog.length ? h("div", {}, h("p", { class: "label" }, "You can ask for"), h("div", { class: "catalog" }, detail.catalog.map(action => h("button", { type: "button", onclick: () => { box.value = action.inputs ? `${action.name}: ` : action.name; box.focus(); } }, h("strong", {}, action.name), h("small", {}, action.description))))) : null,
    messageNodes(detail)));
  target.replaceChildren(h("header", { class: "head" },
    isMobile() ? h("button", { type: "button", class: "icon ghost", "aria-label": "Back", onclick: () => history.back() }, icon("back")) : null,
    bot("other"), h("div", { class: "head-text" }, h("h1", {}, detail.assistant.name), h("p", {}, `${detail.assistant.ownerName}'s assistant`))),
  h("div", { class: "col" }, scroll, detail.online ? h("div", { class: "composer-wrap" }, form) : null));
  scroll.scrollTop = scroll.scrollHeight;
}
export const currentThread = () => current;
export function leftThreadScreen() { current = null; }
