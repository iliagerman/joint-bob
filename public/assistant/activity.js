import { post, request } from "./api.js";
import { app, closeOverlay, fail, navigate, notify, openDrawer, refreshOverlay } from "./context.js";
import { chip, formatTime, h, requestSteps, stateChip, stateLabel, trail } from "./dom.js";
import { openSignIn } from "./resources.js";

// The owner's private review: approvals, notices and everything the assistant did for others.

let panel = null;
let editing = null;
const base = () => `/api/personal-assistants/${app.assistant.id}`;

export async function loadActivity() {
  const [activity, resources] = await Promise.all([
    request(`${base()}/activity`),
    app.resources ? Promise.resolve(app.resources) : request(`${base()}/resources`).catch(() => null),
  ]);
  if (resources) app.resources = resources;
  app.activity = activity;
  app.activityAssistantId = app.assistant.id;
  return activity;
}

export function activityCounts(activity = app.activity, resources = app.resources) {
  if (!activity) return { approvals: 0, notices: 0, signIns: 0, total: 0 };
  const signIns = (resources?.logins ?? []).filter(login => login.state === "needs-sign-in").length;
  const counts = { approvals: activity.approvals.length, notices: activity.notices.length, signIns };
  return { ...counts, total: counts.approvals + counts.notices + counts.signIns };
}

function kv(rows) { return h("dl", { class: "kv" }, rows.flatMap(([key, value]) => [h("dt", {}, key), h("dd", {}, value)])); }

function proposalRows(proposal) {
  if (!proposal) return [];
  if (proposal.operation === "calendar.create" && proposal.start) {
    const zone = proposal.timeZone || undefined;
    // Same wording as the reply the assistant would post: "Thu 5 Nov, 15:00–15:30".
    const day = new Date(proposal.start).toLocaleDateString("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short" });
    const clock = iso => new Date(iso).toLocaleTimeString("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    return [["Would do", "Create a calendar event"], ["When", `${day}, ${clock(proposal.start)}–${clock(proposal.end)}${zone ? ` (${zone})` : ""}`], ["Title", proposal.title]];
  }
  return [["Would do", proposal.summary]];
}

function approvalCard(item) {
  const owner = app.me?.account.name || "you";
  const isEditing = editing === item.id;
  const destination = item.sourceKind === "group" ? `Would post in ${item.sourceName} as ${app.assistant.name}, for ${owner}` : `Would reply to ${item.callerName} as ${app.assistant.name}`;
  const replyBlock = isEditing ? editForm(item) : h("div", { class: "exact" }, h("p", { class: "label" }, destination), h("p", {}, item.proposal?.reply ?? ""));
  return h("article", { class: "card attention", "data-testid": "assistant-approval" },
    h("div", { class: "card-top" }, chip("Awaiting your approval", "amber"), h("small", {}, `Proposal ${item.proposalRevision}`)),
    h("h3", {}, item.actionName ?? "Request"), h("p", { class: "muted" }, item.sourceKind === "group" ? `${item.callerName} asked in ${item.sourceName}` : `${item.callerName} · Direct request`),
    h("div", { class: "gap" }, trail(requestSteps("awaiting-approval", "your"))),
    h("blockquote", { class: "quote" }, `“${item.text}”`), kv(proposalRows(item.proposal)), replyBlock,
    h("div", { class: "exact" }, h("p", { class: "label" }, "The decision model asked you first"), h("p", { class: "fine" }, "Your instructions for this action say to ask you, or don't clearly allow it.")),
    isEditing ? null : h("div", { class: "actions" },
      h("button", { type: "button", onclick: () => act(item, "reject") }, "Reject"),
      h("button", { type: "button", onclick: () => { editing = item.id; render(); } }, "Edit"),
      h("button", { type: "button", class: "primary grow", "data-testid": "assistant-approve", onclick: () => act(item, "approve", { proposalRevision: item.proposalRevision }) }, "Approve once")),
    isEditing ? null : h("p", { class: "fine", style: "margin-top:8px" }, "Approval covers only this proposal and this reply, one time."));
}

function editForm(item) {
  const box = h("textarea", { name: "reply", rows: 3, required: true, maxlength: 4000 }, item.proposal?.reply ?? "");
  const form = h("form", {}, h("label", { class: "field gap" }, h("span", {}, "Reply"), box, h("small", {}, "Your edit becomes a new proposal, and the decision model checks it before you can approve it.")),
    h("div", { class: "actions" }, h("button", { type: "button", onclick: () => { editing = null; render(); } }, "Cancel"), h("button", { type: "submit", class: "primary grow" }, "Send for a new check")));
  form.addEventListener("submit", event => { event.preventDefault(); editing = null; act(item, "edit", { reply: box.value }); });
  return form;
}

function workRow(item) {
  const buttons = [];
  if (item.state === "uncertain") buttons.push(h("button", { type: "button", onclick: () => act(item, "resolve", { created: true }) }, "It was created"), h("button", { type: "button", onclick: () => act(item, "resolve", { created: false }) }, "It wasn't created"));
  if (item.sourceKind === "group") buttons.push(h("button", { type: "button", class: "ghost", onclick: () => navigate({ group: item.sourceId }) }, "Open group"));
  const where = item.sourceKind === "group" ? `${item.callerName} · ${item.sourceName}` : `${item.callerName} · Direct request`;
  return h("div", { class: "work", "data-testid": "assistant-work" }, stateChip(item.state),
    h("div", {}, h("strong", {}, item.actionName ?? (item.text.length > 80 ? `${item.text.slice(0, 80)}…` : item.text)), h("small", {}, `${where} · ${formatTime(item.updatedAt)}`), item.detail ? h("small", {}, item.detail) : null,
      buttons.length ? h("div", { class: "work-actions" }, buttons) : null));
}

function noticeRow(notice) {
  return h("div", { class: "work" }, h("div", {}, h("strong", {}, notice.title), h("small", {}, notice.sourceLabel),
    h("div", { class: "work-actions" }, notice.groupId ? h("button", { type: "button", onclick: () => navigate({ group: notice.groupId }) }, "Open group") : null,
      h("button", { type: "button", class: "ghost", onclick: () => readNotice(notice) }, "Mark as read"))));
}

function signInRows() {
  return (app.resources?.logins ?? []).filter(login => login.state === "needs-sign-in").map(login => h("div", { class: "work" }, chip("Needs sign-in", "amber"),
    h("div", {}, h("strong", {}, `${login.label} needs you to sign in`), h("small", {}, "The assistant paused a step that uses this login. Sign in to continue."),
      h("div", { class: "work-actions" }, h("button", { type: "button", onclick: () => { closeOverlay(); openSignIn(login); } }, "Sign in")))));
}

function body() {
  const activity = app.activity;
  const sections = [];
  sections.push(...activity.approvals.map(approvalCard));
  const notices = [...signInRows(), ...activity.notices.map(noticeRow)];
  if (notices.length) sections.push(h("div", { class: "sec" }, "Notices"), notices);
  if (activity.work.length) sections.push(h("div", { class: "sec" }, "Other work"), activity.work.slice(0, 30).map(workRow));
  if (activity.recordedToday.length) sections.push(h("div", { class: "sec" }, "Recorded today"), activity.recordedToday.map(entry => h("div", { class: "work" }, chip(stateLabel("recorded")), h("div", {}, h("strong", {}, `${entry.count} message${entry.count === 1 ? "" : "s"} in ${entry.sourceName}`), h("small", {}, "Nothing needed you, so nothing ran.")))));
  if (!sections.length) sections.push(h("div", { class: "empty" }, `Nothing yet. When ${app.assistant.name} joins a group or gets a request, it shows up here.`));
  return sections;
}

function render() { if (panel?.isConnected) refreshOverlay(panel, { body: body() }); }

export async function openActivity() {
  try {
    await loadActivity();
    editing = null;
    panel = openDrawer({ eyebrow: "Only you see this", title: `${app.assistant.name} activity`, body: body(), closeLabel: "Close activity and return to chat" });
    panel.dataset.testid = "assistant-activity";
  } catch (error) { fail(error); }
}

/** A change signal for this assistant: refresh an open drawer in place. */
export async function activityChanged() {
  await loadActivity();
  render();
}

async function act(item, action, body = {}) {
  try {
    await post(`${base()}/requests/${item.id}/${action}`, body);
    notify({ approve: "Approved. It runs now.", reject: "Rejected. Nothing happened.", edit: "Sent for a new check.", resolve: "Saved." }[action]);
    await activityChanged();
  } catch (error) { fail(error); await activityChanged().catch(() => {}); }
}

async function readNotice(notice) {
  try { await post(`${base()}/notices/${notice.id}/read`); await activityChanged(); }
  catch (error) { fail(error); }
}

export const activityOpen = () => Boolean(panel?.isConnected);
