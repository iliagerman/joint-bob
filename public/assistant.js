import { request, setCsrf, subscribe } from "./assistant/api.js";
import { activityChanged, activityCounts, activityOpen, loadActivity, openActivity } from "./assistant/activity.js";
import { showActions } from "./assistant/actions.js";
import { bindChat, showTranscript, showWaitingStrip } from "./assistant/chat.js";
import { app, closeOverlay, fail, installBackModel, isMobile, markShown, navigate, notify, setRouter } from "./assistant/context.js";
import { bot, h, icon, rowText } from "./assistant/dom.js";
import { currentGroup, leftGroupScreen, loadGroups, openNewGroupSheet, pendingInvitations, showGroup, showInvitations } from "./assistant/groups.js";
import { loadMe, showFind, showYou } from "./assistant/people.js";
import { refreshTelegram, showResources } from "./assistant/resources.js";
import { arrivesWithShare, bindSaved, prefillShare, showItems } from "./assistant/saved.js";
import { bindSettings, fillSettings, showSettings } from "./assistant/settings.js";
import { currentThread, leftThreadScreen, loadThreads, showThread, threadStatus } from "./assistant/threads.js";

const VIEWS = ["chat", "resources", "actions", "settings", "saved-items"];
const $ = selector => document.querySelector(selector);
const params = () => new URLSearchParams(location.search);

function findableOn(kind, id) {
  const me = app.me;
  if (!me) return "";
  const relays = me.relays.filter(relay => me.discovery.some(item => item.subjectKind === kind && item.subjectId === id && item.relayNodeId === relay.relayNodeId));
  return relays.length ? `Findable on ${relays.map(relay => relay.name).join(", ")}` : "Not findable";
}
const assistantSubtitle = entry => [app.me?.profile.defaultAssistantId === entry.id ? "Default" : "", findableOn("assistant", entry.id)].filter(Boolean).join(" · ");

// ---- Rail and mobile tabs ----

function badge(count) { return count ? h("span", { class: "badge", "aria-label": `${count} waiting` }, String(count)) : null; }

function renderRail() {
  const selected = params();
  $("#rail-assistants").replaceChildren(...(app.assistants.length ? app.assistants.map(entry => h("button", { type: "button", class: "row", "aria-current": String(selected.get("id") === entry.id), onclick: () => openAssistant(entry.id) },
    bot(), rowText(entry.name, assistantSubtitle(entry)), badge(app.pendingCounts.get(entry.id) ?? 0))) : [h("p", { class: "empty-line" }, "No assistant yet.")]));
  const invitations = pendingInvitations();
  $("#rail-groups").replaceChildren(
    h("button", { type: "button", class: "row", "aria-current": String(selected.get("screen") === "invitations"), onclick: () => navigate({ screen: "invitations" }) }, h("span", { class: "av ghost", "aria-hidden": "true" }, icon("send-out")), rowText("Invitations", invitations ? `${invitations} waiting for you` : "Nothing waiting"), badge(invitations)),
    ...app.groups.map(group => h("button", { type: "button", class: "row", "aria-current": String(selected.get("group") === group.groupId), onclick: () => navigate({ group: group.groupId }) }, h("span", { class: "av", "aria-hidden": "true" }, icon("people")), rowText(group.name, app.me?.relays.find(relay => relay.relayNodeId === group.relayNodeId)?.name ?? ""))));
  $("#rail-requests").replaceChildren(...(app.threads.length ? app.threads.map(thread => h("button", { type: "button", class: "row", "aria-current": String(selected.get("thread") === thread.threadId), onclick: () => navigate({ thread: thread.threadId }) }, bot("other"), rowText(thread.assistantName, threadStatus(thread))))
    : [h("p", { class: "empty-line" }, "Start one from Find.")]));
  $("#rail-you").setAttribute("aria-current", String(selected.get("screen") === "you"));
  if (app.me) { $("#rail-you-name").textContent = app.me.account.name; $("#rail-you .av").textContent = app.me.account.name.slice(0, 2).toUpperCase(); }
  const tab = selected.get("screen") === "find" ? "find" : selected.get("screen") === "groups" || selected.has("group") || selected.get("screen") === "invitations" ? "groups" : selected.get("screen") === "requests" || selected.has("thread") ? "requests" : "assistants";
  for (const button of document.querySelectorAll("#tabbar [data-tab]")) button.setAttribute("aria-current", button.dataset.tab === tab ? "page" : "false");
  const totals = { assistants: [...app.pendingCounts.values()].reduce((sum, count) => sum + count, 0), groups: invitations };
  for (const element of document.querySelectorAll("#tabbar [data-badge]")) { const count = totals[element.dataset.badge] ?? 0; element.textContent = String(count); element.classList.toggle("hidden", !count); }
}

function renderChooser() {
  const target = $("#assistants");
  target.replaceChildren(...(app.assistants.length ? app.assistants.map(entry => h("button", { type: "button", class: "row", "aria-label": entry.name, onclick: () => openAssistant(entry.id, true) }, bot(), rowText(entry.name, assistantSubtitle(entry)), badge(app.pendingCounts.get(entry.id) ?? 0)))
    : [h("p", { class: "empty" }, "No assistant yet. Open a conversation, then choose Create assistant in its toolbar.")]));
}

function mobileList(kind) {
  const target = $("#social-view");
  if (kind === "groups") {
    const invitations = pendingInvitations();
    target.replaceChildren(h("div", { class: "m-head" }, h("h1", { class: "page-title" }, "Groups"), h("button", { type: "button", class: "icon ghost", "aria-label": "New group", onclick: openNewGroupSheet }, icon("plus"))),
      h("div", { class: "m-lists" }, h("button", { type: "button", class: "row", onclick: () => navigate({ screen: "invitations" }) }, h("span", { class: "av ghost", "aria-hidden": "true" }, icon("send-out")), rowText("Invitations", invitations ? `${invitations} waiting for you` : "Nothing waiting"), badge(invitations)),
        app.groups.map(group => h("button", { type: "button", class: "row", onclick: () => navigate({ group: group.groupId }) }, h("span", { class: "av", "aria-hidden": "true" }, icon("people")), rowText(group.name, app.me?.relays.find(relay => relay.relayNodeId === group.relayNodeId)?.name ?? "")))));
    return;
  }
  target.replaceChildren(h("h1", { class: "page-title" }, "Requests"), h("div", { class: "m-lists" },
    app.threads.map(thread => h("button", { type: "button", class: "row", onclick: () => navigate({ thread: thread.threadId }) }, bot("other"), rowText(thread.assistantName, threadStatus(thread)))),
    h("p", { class: "fine", style: "padding:12px 16px" }, "Your requests to other people's assistants. Start one from Find.")));
}

// ---- The assistant ----

async function refreshCounts() {
  const local = new Set((app.me?.assistants ?? []).filter(entry => entry.local).map(entry => entry.id));
  await Promise.all(app.assistants.filter(entry => local.has(entry.id)).map(async entry => {
    try {
      const activity = await request(`/api/personal-assistants/${entry.id}/activity`);
      const resources = app.resources && app.assistant?.id === entry.id ? app.resources : null;
      app.pendingCounts.set(entry.id, activityCounts(activity, resources).total);
      if (app.assistant?.id === entry.id) app.activity = activity;
    } catch (error) { console.warn(`Activity for ${entry.name} is unavailable:`, error.message); }
  }));
}

function updateActivityBadge() {
  if (!app.assistant) return;
  const counts = activityCounts();
  const element = $("#activity-badge");
  element.textContent = String(counts.total);
  element.classList.toggle("hidden", !counts.total);
  $("#activity-button").setAttribute("aria-label", counts.total ? `Activity, ${counts.total} waiting` : "Activity");
  showWaitingStrip(counts, openActivity);
}

function openAssistant(id, keepShare = false) {
  const target = new URL(location.pathname, location.origin);
  if (keepShare) for (const key of ["share", "url", "title", "text"]) if (params().has(key)) target.searchParams.set(key, params().get(key));
  target.searchParams.set("id", id);
  history.replaceState({ top: true }, "", target);
  closeOverlay();
  render().catch(fail);
}

async function showAssistantView(view) {
  for (const name of VIEWS) $(`#${name}-view`).classList.toggle("hidden", name !== view);
  for (const button of document.querySelectorAll("#assistant-nav [data-assistant-view]")) {
    if (button.dataset.assistantView === view) button.setAttribute("aria-current", "page"); else button.removeAttribute("aria-current");
  }
  if (view === "chat") await showTranscript();
  if (view === "resources") await showResources();
  if (view === "actions") await showActions();
  if (view === "settings") await showSettings();
  if (view === "saved-items") await showItems();
}

async function showAssistant(id) {
  const entry = app.assistants.find(candidate => candidate.id === id);
  if (!entry) { notify("Assistant not found or unavailable on this machine", true); showChooser(); return; }
  const changed = app.assistant?.id !== entry.id;
  app.assistant = entry;
  if (changed) { app.resources = null; app.activity = null; }
  $("#detail").classList.remove("hidden");
  document.body.classList.add("in-detail");
  $("#heading").textContent = entry.name;
  $("#detail-subtitle").textContent = assistantSubtitle(entry);
  fillSettings();
  if (changed && arrivesWithShare()) await prefillShare();
  const requested = params().get("view");
  await showAssistantView(VIEWS.includes(requested) ? requested : arrivesWithShare() ? "saved-items" : "chat");
  loadActivity().then(updateActivityBadge).catch(error => console.warn("Assistant activity is unavailable:", error.message));
}

function showChooser() {
  app.assistant = null;
  $("#chooser").classList.remove("hidden");
  renderChooser();
}

// ---- Routing ----

async function render() {
  markShown();
  for (const id of ["#chooser", "#detail", "#social-view"]) $(id).classList.add("hidden");
  document.body.classList.remove("in-detail");
  const current = params();
  if (!current.has("group")) leftGroupScreen();
  if (!current.has("thread")) leftThreadScreen();
  renderRail();
  if (current.has("id")) { await showAssistant(current.get("id")); renderRail(); return; }
  app.assistant = null;
  const screen = current.get("screen");
  const social = $("#social-view");
  social.classList.remove("hidden");
  if (current.has("group") || current.has("thread") || ["you", "invitations"].includes(screen)) document.body.classList.add("in-detail");
  if (current.has("group")) await showGroup(current.get("group"));
  else if (current.has("thread")) await showThread(current.get("thread"));
  else if (screen === "find") await showFind();
  else if (screen === "you") await showYou();
  else if (screen === "invitations") await showInvitations();
  else if ((screen === "groups" || screen === "requests") && isMobile()) mobileList(screen);
  else { social.classList.add("hidden"); showChooser(); }
  renderRail();
}
setRouter(() => render().catch(fail));

function onChange(change) {
  if (change.kind === "group") {
    if (currentGroup() === change.groupId) showGroup(change.groupId).catch(fail);
    loadGroups().then(renderRail).catch(() => {});
  } else if (change.kind === "thread") {
    if (currentThread() === change.threadId) showThread(change.threadId).catch(fail);
  } else if (change.kind === "invitations") {
    loadGroups().then(() => { renderRail(); if (params().get("screen") === "invitations") return showInvitations(); }).catch(fail);
  } else if (change.kind === "activity") {
    refreshCounts().then(() => {
      renderRail();
      if (app.assistant?.id !== change.assistantId) return undefined;
      updateActivityBadge();
      refreshTelegram().catch(fail);
      return activityOpen() ? activityChanged() : undefined;
    }).catch(fail);
  }
}

function bindShell() {
  for (const button of document.querySelectorAll("#assistant-nav [data-assistant-view]")) {
    button.addEventListener("click", () => navigate({ id: app.assistant.id, view: button.dataset.assistantView === "chat" ? "" : button.dataset.assistantView }));
  }
  for (const button of document.querySelectorAll("[data-go]")) button.addEventListener("click", () => navigate({ screen: button.dataset.go }));
  for (const button of document.querySelectorAll("[data-sheet=new-group]")) button.addEventListener("click", openNewGroupSheet);
  for (const button of document.querySelectorAll("#tabbar [data-tab]")) {
    button.addEventListener("click", () => navigate(button.dataset.tab === "assistants" ? {} : { screen: button.dataset.tab }));
  }
  $("#detail-back").addEventListener("click", () => navigate({}));
  $("#activity-button").addEventListener("click", openActivity);
  bindChat();
  bindSettings();
  bindSaved(showTranscript);
}

async function loadSocial() {
  try {
    await loadMe();
    await Promise.all([loadGroups(), loadThreads(), refreshCounts()]);
  } catch (error) { console.warn("Groups and discovery are unavailable:", error.message); }
}

async function boot() {
  const status = await (await fetch("/api/auth/status", { credentials: "same-origin" })).json();
  if (!status.authenticated) {
    notify("Sign in to Joint Bob, then reopen this link.", true);
    $("#chooser").classList.remove("hidden");
    $("#assistants").replaceChildren(h("a", { href: "/" }, "Sign in"));
    return;
  }
  setCsrf(status.csrfToken);
  bindShell();
  installBackModel();
  const { assistants } = await request("/api/personal-assistants");
  app.assistants = assistants;
  await loadSocial();
  await render();
  subscribe(onChange);
}

boot().catch(fail);
