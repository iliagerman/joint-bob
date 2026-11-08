import { sendSocket } from "./chat-controls.js";
import { elements } from "./elements.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

// A paused agent action, shown in its own conversation directly above the composer, like the
// browser sign-in. The socket carries the open reviews in; the person's answer goes back on it.
let card = null;
/** The open reviews the conversation's socket last sent; the card shows the first one. */
let openReviews = [];
/** Reviews already answered from this page, whose buttons stay off until the socket drops them. */
const answered = new Set();

function unmount() {
  card?.remove();
  card = null;
}

function show(reviews) {
  openReviews = reviews;
  for (const id of answered) if (!reviews.some((review) => review.id === id)) answered.delete(id);
  render();
}

function render() {
  unmount();
  const review = openReviews[0];
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
  const waiting = openReviews.length > 1 ? ` · ${openReviews.length - 1} more waiting` : "";
  detail.textContent = state.conversationReadOnly ? "Only someone who can write in this conversation can answer." : `${review.detail.split("\n").join(" · ")}${waiting}`;
  const answer = (decision) => {
    if (!sendSocket({ type: "guardianDecision", reviewId: review.id, decision })) return;
    answered.add(review.id);
    for (const control of foot.querySelectorAll("button")) control.disabled = true;
  };
  const block = document.createElement("button");
  block.type = "button"; block.className = "ghost"; block.textContent = "Block"; block.dataset.testid = "guardian-review-block";
  block.addEventListener("click", () => answer("block"));
  const allow = document.createElement("button");
  allow.type = "button"; allow.className = "primary"; allow.textContent = "Allow once"; allow.dataset.testid = "guardian-review-allow";
  allow.addEventListener("click", () => answer("allow"));
  block.disabled = allow.disabled = state.conversationReadOnly === true || answered.has(review.id);
  foot.append(detail, block, allow);
  card.append(copy, subject, foot);
  elements.composer.before(card);
}

document.addEventListener("guardian-event", (event) => {
  const payload = event.detail;
  if (payload.type === "guardianReviews") show(payload.reviews || []);
  if (payload.type === "guardianBlocked") toast.error(payload.message);
});

// Another conversation of the project is waiting on the person; say so once, without taking over.
document.addEventListener("guardian-elsewhere", (event) => {
  const { conversationId, titles } = event.detail;
  if (!titles?.length || conversationId === (state.activeConversationId || state.activeSessionId)) return;
  toast(`Guardian is waiting for you in another conversation: ${titles[0]}`, 8000);
});

// The chat controls announce "activeConversationChanged" on every redraw, which a running turn
// causes every few seconds, not only when another conversation opens. The card goes only when the
// conversation on screen is no longer the one its review pauses; the next conversation's own
// reviews arrive with its ready message. A redraw that took the card out of the page puts it back.
document.addEventListener("activeConversationChanged", () => {
  if (!openReviews.length) return;
  if (openReviews[0].conversationId !== (state.activeConversationId || state.activeSessionId)) {
    openReviews = [];
    unmount();
    return;
  }
  if (!card?.isConnected) render();
});
