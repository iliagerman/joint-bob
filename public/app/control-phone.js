import { api } from "./api.js";
import { cardActionList } from "./control-cards.js";
import { openConversation, refreshControlCenter } from "./control-center.js";
import { currentControlView, showControlView } from "./control-views.js";
import { elements } from "./elements.js";
import { setMobileView } from "./layout.js";
import { toast } from "./shell.js";

/**
 * The control center on a phone is Bob's chat. The board and its tabs are not drawn as columns there; this module adds what
 * the chat needs to stand in for them: a strip of chips with the counts, the agents sheet one chip opens, the way back out,
 * the agent chip in the composer and the menu entries that reach the control center. The chat itself (timeline, filters,
 * settings, monitor) is control-chat.js, restyled by control-phone.css. Everything added here is hidden above 1023px.
 */
const narrow = matchMedia("(max-width: 1023px)");

const GROUPS = [
  { id: "ok", title: "Needs your OK", chip: (count) => `${count} ${count === 1 ? "needs" : "need"} your OK` },
  { id: "you", title: "Needs you", chip: (count) => `${count} ${count === 1 ? "needs" : "need"} you` },
  { id: "running", title: "Running", chip: (count) => `${count} running` },
  { id: "review", title: "To review", chip: (count) => `${count} to review` },
];
const LEASE_LABELS = { "take-control": "Take control", "give-back": "Give back" };

let cards = [];
let openGroup = null;
let jumpTo = null;
let page = 0;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className, testid, onClick) {
  const node = element("button", className, label);
  node.type = "button";
  node.dataset.testid = testid;
  node.addEventListener("click", onClick);
  return node;
}

/** One entry per thing that waits on the person or runs: a pending Guardian review, or an agent in a column. */
function entries() {
  const withoutReview = (card) => !card.pendingReviews?.length;
  const inColumn = (group, test) => cards.filter(test).map((card) => ({ group, card }));
  return [
    ...cards.flatMap((card) => (card.pendingReviews ?? []).map((review) => ({ group: "ok", card, review }))),
    ...inColumn("you", (card) => card.column === "needs-you" && withoutReview(card)),
    ...inColumn("running", (card) => card.column === "running"),
    ...inColumn("review", (card) => card.column === "review"),
  ];
}

// ── The chat's own header, strip and composer ──────────────────────────────────────────────────────────────

const head = elements.controlChat.querySelector(".control-chat-head");
const back = button("‹", "ghost compact phone-back", "control-phone-back", () => elements.controlCenterCloseButton.click());
back.setAttribute("aria-label", "Back to your workspace");
head.prepend(back);

const strip = element("div", "phone-strip");
strip.dataset.testid = "control-phone-strip";
strip.setAttribute("role", "group");
strip.setAttribute("aria-label", "Agents");
head.after(strip);

const agentChip = button("Bob's agent", "phone-chip phone-agent", "control-phone-agent", () => elements.controlChatSettingsButton.click());
agentChip.title = "Bob's agent, model and settings";
elements.controlChatForm.querySelector(".control-chat-project").after(agentChip);

// The message box is one line high on a phone, so its hint has to be short.
const placeholder = elements.controlChatInput.placeholder;
function shortenPlaceholder() { elements.controlChatInput.placeholder = narrow.matches ? "Message Bob…" : placeholder; }
narrow.addEventListener("change", shortenPlaceholder);
shortenPlaceholder();

/** The agent Bob runs on, as the person set it; an empty harness is the node's usual helper agent. */
window.addEventListener("control-bob-settings", (event) => {
  const { harnessId, modelId } = event.detail;
  agentChip.textContent = harnessId ? `${harnessId[0].toUpperCase()}${harnessId.slice(1)} · ${modelId || "default model"}` : "Bob's agent";
});

function renderStrip() {
  const all = entries();
  const chips = GROUPS.map((group) => {
    const count = all.filter((entry) => entry.group === group.id).length;
    if (!count) return null;
    const chip = button(group.chip(count), `phone-chip ${group.id}`, `control-phone-chip-${group.id}`, () => toggleSheet(group.id));
    chip.dataset.count = String(count);
    chip.setAttribute("aria-pressed", String(openGroup === group.id));
    return chip;
  }).filter(Boolean);
  const dashboards = button("▦ Dashboards", "phone-chip", "control-phone-chip-dashboards", () => { closeSheet(); showControlView("dashboards"); });
  strip.replaceChildren(...chips, dashboards);
}

// ── The agents sheet ───────────────────────────────────────────────────────────────────────────────────────

const sheet = element("section", "phone-sheet");
sheet.hidden = true;
sheet.dataset.testid = "control-phone-sheet";
sheet.setAttribute("role", "dialog");
sheet.setAttribute("aria-label", "Agents");
const sheetTitle = element("b", "", "Agents");
const sheetClose = button("×", "ghost compact", "control-phone-sheet-close", () => closeSheet());
sheetClose.setAttribute("aria-label", "Close the agents sheet");
const sheetHead = element("div", "phone-sheet-head");
sheetHead.append(sheetTitle, sheetClose);
const list = element("div", "phone-sheet-list");
list.dataset.testid = "control-phone-list";
const pager = element("div", "phone-pager");
pager.dataset.testid = "control-phone-pager";
sheet.append(element("span", "phone-grab"), sheetHead, list, pager);
elements.controlChat.append(sheet);

// The Focus menu's round handle would sit on the rows' buttons, so it steps aside while the sheet is open.
function openSheet(group) {
  openGroup = group;
  jumpTo = group;
  sheet.hidden = false;
  document.body.classList.add("control-phone-sheet");
  renderSheet();
  renderStrip();
}

function closeSheet() {
  if (sheet.hidden) return;
  openGroup = null;
  sheet.hidden = true;
  document.body.classList.remove("control-phone-sheet");
  renderStrip();
}

function toggleSheet(group) {
  if (!sheet.hidden && openGroup === group) closeSheet();
  else openSheet(group);
}

function open(card) {
  closeSheet();
  openConversation(card).catch((error) => toast(error.message));
}

function decide({ card, review }, decision, buttons) {
  for (const control of buttons) control.disabled = true;
  api("/api/control-center/guardian/decide", { method: "POST", body: JSON.stringify({ projectId: card.projectId, conversationId: card.conversationId, reviewId: review.id, decision }) })
    .then(() => refreshControlCenter())
    .catch((error) => { toast(error.message); for (const control of buttons) control.disabled = false; });
}

/** What each kind of row says under its title. */
function detail({ group, card, review }) {
  if (group === "ok") return `${card.projectName} · ${review.subject}`;
  if (group === "you") return `${card.projectName} · ${card.autoRespondStop.reason || card.autoRespondStop.kind}`;
  if (group === "running") return `${card.projectName} · ${card.summary ?? "Working…"}${card.autoRespondActive ? " · auto respond" : ""}`;
  return `${card.projectName} · ${card.summary ?? "Finished. Open it to review."}`;
}

function buildRow(entry) {
  const { group, card } = entry;
  const row = element("div", `phone-row ${group}`);
  row.dataset.testid = "control-phone-row";
  row.dataset.group = group;
  row.dataset.key = `${card.projectId}:${card.conversationId}`;
  const text = element("div", "phone-row-text");
  const subject = element("small", "", detail(entry));
  subject.title = subject.textContent;
  text.append(element("b", "", card.title), subject);
  const actions = element("div", "phone-row-actions");
  if (group === "ok") {
    const allow = button("Allow once", "phone-action warn", "control-phone-allow", () => decide(entry, "allow", [allow, block]));
    const block = button("Block", "phone-action", "control-phone-block", () => decide(entry, "block", [allow, block]));
    actions.append(allow, block);
  } else {
    const label = { you: "Answer", running: "Watch", review: "Review" }[group];
    actions.append(button(label, "phone-action", `control-phone-${label.toLowerCase()}`, () => open(card)));
  }
  if (group === "running") {
    // Taking control (and giving it back) is the board card's own action, so the lease logic stays in one place.
    for (const action of cardActionList(card).filter((candidate) => LEASE_LABELS[candidate.id])) {
      actions.append(button(LEASE_LABELS[action.id], "phone-action", `control-phone-${action.id}`, () => {
        if (action.id === "take-control") closeSheet();
        Promise.resolve(action.run(card)).catch((error) => toast(error.message));
      }));
    }
  }
  row.append(text, actions);
  return row;
}

function buildHeading(group, count) {
  const heading = element("div", `phone-heading ${group.id}`);
  heading.dataset.testid = `control-phone-group-${group.id}`;
  heading.append(element("b", "", group.title), element("span", "", ` ${count}`));
  return heading;
}

/**
 * Splits the groups into pages that fit `capacity`: lists page rather than scroll. Rows are drawn once to learn their height
 * (text wraps, so heights differ); a page that starts in the middle of a group repeats the group's heading.
 */
function paginate(sections, capacity, headingHeight) {
  const pages = [];
  let current = null;
  let used = 0;
  for (const section of sections) {
    let part = null;
    for (const row of section.rows) {
      if (current && used + row.height + (part ? 0 : headingHeight) > capacity) { current = null; part = null; }
      if (!current) { current = []; pages.push(current); used = 0; }
      if (!part) { part = { section, rows: [] }; current.push(part); used += headingHeight; }
      part.rows.push(row);
      used += row.height;
    }
  }
  return pages;
}

function renderSheet() {
  if (sheet.hidden) return;
  const all = entries();
  sheetTitle.textContent = `Agents · ${all.length}`;
  const capacity = Math.min(440, Math.floor(innerHeight * 0.55));
  list.style.maxHeight = `${capacity}px`;
  if (!all.length) {
    const empty = element("p", "phone-empty", "Nothing is running and nothing waits for you.");
    empty.dataset.testid = "control-phone-empty";
    list.replaceChildren(empty);
    pager.hidden = true;
    return;
  }
  const sections = GROUPS.map((group) => ({ group, rows: all.filter((entry) => entry.group === group.id).map((entry) => ({ node: buildRow(entry) })) })).filter((section) => section.rows.length);
  // Heights are only known once the rows are in the page.
  const sample = buildHeading(sections[0].group, 0);
  list.replaceChildren(sample, ...sections.flatMap((section) => section.rows.map((row) => row.node)));
  const headingHeight = sample.offsetHeight;
  for (const section of sections) for (const row of section.rows) row.height = row.node.offsetHeight;
  const pages = paginate(sections, capacity, headingHeight);
  if (jumpTo) page = Math.max(0, pages.findIndex((parts) => parts.some((part) => part.section.group.id === jumpTo)));
  jumpTo = null;
  page = Math.min(page, pages.length - 1);
  list.replaceChildren(...pages[page].flatMap((part) => [buildHeading(part.section.group, part.section.rows.length), ...part.rows.map((row) => row.node)]));
  renderPager(pages.length);
}

function renderPager(pages) {
  pager.hidden = pages <= 1;
  const previous = button("Prev", "ghost compact", "control-phone-prev", () => { page -= 1; renderSheet(); });
  const next = button("Next", "ghost compact", "control-phone-next", () => { page += 1; renderSheet(); });
  previous.disabled = page === 0;
  next.disabled = page >= pages - 1;
  const label = element("span", "", `Page ${page + 1} of ${pages}`);
  label.dataset.testid = "control-phone-page-label";
  pager.replaceChildren(previous, label, next);
}

renderStrip();
window.addEventListener("control-center-rendered", (event) => {
  cards = event.detail.cards;
  renderStrip();
  renderSheet();
});
window.addEventListener("resize", renderSheet);
// Escape closes the sheet before it can leave the control center.
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || sheet.hidden) return;
  event.preventDefault();
  closeSheet();
}, true);

// ── Other tabs, over the chat ──────────────────────────────────────────────────────────────────────────────

// Dashboards (and any tab a feature registers) cannot be a column on a phone: the one that is chosen covers the chat, with a way back.
const viewBar = element("div", "phone-view-bar");
const viewTitle = element("b");
viewTitle.dataset.testid = "control-phone-view-title";
viewBar.append(button("‹ Bob", "ghost compact", "control-phone-view-back", () => showControlView("live")), viewTitle);
document.querySelector("#controlViews").prepend(viewBar);

window.addEventListener("control-view-changed", (event) => {
  const { id } = event.detail;
  document.body.classList.toggle("control-phone-view", id !== "live");
  viewTitle.textContent = document.querySelector(`#controlTabs [data-view="${id}"]`)?.firstChild.textContent ?? "";
});
// Asking Bob for something from a tab (a dashboard, for example) writes into the message box; show the chat the words went to.
elements.controlChatInput.addEventListener("focusin", () => {
  if (narrow.matches && currentControlView() !== "live") showControlView("live");
});
// A person opens the control center to talk to Bob.
window.addEventListener("control-center-activated", () => {
  if (narrow.matches && currentControlView() !== "live") showControlView("live");
});

// ── Ways in ────────────────────────────────────────────────────────────────────────────────────────────────

// Phones above 700px keep the app menu; the small ones have the Focus menu (focus-ui.js). The toolbar icon that shows the waiting count is hidden there, so the count is copied to the entries.
const menuEntry = button("Control center", "ghost compact", "app-menu-control-center-button", () => {
  elements.appMenu.removeAttribute("open");
  setMobileView("control");
});
elements.appMenuSettingsButton.before(menuEntry);

const waiting = document.querySelector('[data-testid="control-center-waiting-badge"]');
function mirrorWaiting() {
  for (const entry of [menuEntry, document.getElementById("focusControl")]) {
    if (!entry) continue;
    let badge = entry.querySelector(".phone-waiting");
    if (!badge) {
      badge = element("span", "focus-pending-badge phone-waiting");
      badge.dataset.testid = "control-phone-waiting";
      entry.append(badge);
    }
    badge.textContent = waiting.textContent;
    badge.hidden = waiting.hidden;
  }
}
new MutationObserver(mirrorWaiting).observe(waiting, { attributes: true, childList: true, characterData: true, subtree: true });
