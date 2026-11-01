import { sendSocket } from "./chat-controls.js";
import { elements } from "./elements.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

// A paused agent action, shown in its own conversation directly above the composer, like the
// browser sign-in. The socket carries the open reviews in; the person's answer goes back on it.
let card = null;

function unmount() {
  card?.remove();
  card = null;
}

function show(reviews) {
  unmount();
  const review = reviews[0];
  if (!review) return;
  card = document.createElement("section");
  card.className = "guardian-review";
  card.dataset.testid = "guardian-review";
  card.setAttribute("aria-label", "Guardian");
  const copy = document.createElement("div");
  copy.className = "conversation-lock-copy";
  const title = document.createElement("strong");
  title.textContent = review.title;
  copy.append(title);
  const subject = document.createElement("pre");
  subject.textContent = review.subject;
  subject.dataset.testid = "guardian-review-subject";
  const foot = document.createElement("div");
  foot.className = "guardian-review-foot";
  const detail = document.createElement("span");
  detail.className = "settings-hint";
  detail.dataset.testid = "guardian-review-detail";
  const waiting = reviews.length > 1 ? ` · ${reviews.length - 1} more waiting` : "";
  detail.textContent = state.conversationReadOnly ? "Only someone who can write in this conversation can answer." : `${review.detail.split("\n").join(" · ")}${waiting}`;
  const answer = (decision) => {
    if (!sendSocket({ type: "guardianDecision", reviewId: review.id, decision })) return;
    for (const control of foot.querySelectorAll("button")) control.disabled = true;
  };
  const block = document.createElement("button");
  block.type = "button"; block.className = "ghost"; block.textContent = "Block"; block.dataset.testid = "guardian-review-block";
  block.addEventListener("click", () => answer("block"));
  const allow = document.createElement("button");
  allow.type = "button"; allow.className = "primary"; allow.textContent = "Allow once"; allow.dataset.testid = "guardian-review-allow";
  allow.addEventListener("click", () => answer("allow"));
  block.disabled = allow.disabled = state.conversationReadOnly === true;
  foot.append(detail, block, allow);
  card.append(copy, subject, foot);
  elements.composer.before(card);
}

document.addEventListener("guardian-event", (event) => {
  const payload = event.detail;
  if (payload.type === "guardianReviews") show(payload.reviews || []);
  if (payload.type === "guardianBlocked") toast(payload.message, 8000);
});

// Another conversation of the project is waiting on the person; say so once, without taking over.
document.addEventListener("guardian-elsewhere", (event) => {
  const { conversationId, titles } = event.detail;
  if (!titles?.length || conversationId === (state.activeConversationId || state.activeSessionId)) return;
  toast(`Guardian is waiting for you in another conversation: ${titles[0]}`, 8000);
});

// The next conversation's own reviews arrive with its ready message.
document.addEventListener("activeConversationChanged", unmount);
