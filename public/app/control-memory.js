// Control center: Bob's memory. Topic files Bob keeps for itself, what Bob changed, and the switch that makes every write ask first.
import { api } from "./api.js";
import { createControlViewElement, registerControlView } from "./control-views.js";
import { confirmAction, formatDate, toast } from "./shell.js";
import { state } from "./state.js";

const MEMORY = "/api/control-center/memory";
const SETTINGS = "/api/control-center/bob/settings";
// Rows and cards that fit the height are shown; these are only the most one page can hold.
const MAX_TOPIC_ROWS = 30;
const CHANGES_FETCH = 8;
const DIFF_LINES = 10;
const STATUS_LABELS = { pending: "Waiting for you", applied: "To review", kept: "Kept", reverted: "Reverted" };
const KIND_LABELS = { create: "new topic", update: "edited", delete: "deleted" };

const view = createControlViewElement("memory");
view.classList.add("memory");
view.dataset.testid = "control-memory";

let sub = "topics";
/** Every topic's name, so a link can tell a topic from one that does not exist yet. */
let allNames = new Set();
let topics = [];
let query = "";
let lastRead = null;
let selected = null;
let mode = "view";
let draft = { name: "", description: "", body: "", project: "" };
let changes = [];
let changesTotal = 0;
let editingChange = null;
const topicsPage = { start: 0, back: [], shown: 0 };
const changesPage = { start: 0, back: [], shown: 0 };
let handle = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function tagged(node, testid) {
  node.dataset.testid = testid;
  return node;
}

function button(label, testid, className, onClick) {
  const node = tagged(element("button", className, label), testid);
  node.type = "button";
  node.addEventListener("click", () => Promise.resolve(onClick()).catch((error) => toast(error.message)));
  return node;
}

function projectName(id) {
  return state.projects.find((project) => project.id === id)?.name ?? id;
}

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

// ── The view's frame ───────────────────────────────────────────────────────────────────────────────────

const search = tagged(element("input", "memory-search"), "memory-search");
search.type = "search";
search.placeholder = "Search topics…";
search.setAttribute("aria-label", "Search Bob's memory");

const intro = element("div");
intro.append(element("h2", "", "Bob's memory"), element("p", "", "One file per topic, linked to each other. Bob always sees the list of topics with one line each, and reads a topic when it matters for what you ask. Edit anything."));
const head = element("header", "memory-head");
head.append(intro, search, button("+ Topic", "memory-new", "primary compact", () => openNew("")));

const topicsTab = tagged(element("button", "", "Topics"), "memory-sub-topics");
const changesTab = tagged(element("button", "", "What Bob changed "), "memory-sub-changes");
const pill = tagged(element("span", "memory-pill"), "memory-changes-count");
changesTab.append(pill);
for (const [tab, id] of [[topicsTab, "topics"], [changesTab, "changes"]]) {
  tab.type = "button";
  tab.setAttribute("role", "tab");
  tab.addEventListener("click", () => showSub(id).catch((error) => toast(error.message)));
}
const seg = element("div", "memory-seg");
seg.setAttribute("role", "tablist");
seg.append(topicsTab, changesTab);
const ask = tagged(element("input"), "memory-ask-before");
ask.type = "checkbox";
const askLabel = element("label", "memory-ask");
askLabel.append(ask, document.createTextNode(" Ask me before Bob saves anything"));
const filterNote = tagged(element("span", "memory-filter-note"), "memory-filter-note");
const bar = element("div", "memory-bar");
bar.append(seg, askLabel, filterNote);

const lastReadNote = tagged(element("p", "memory-last-read"), "memory-last-read");
const rows = tagged(element("div", "memory-rows"), "memory-topic-list");
const topicsPager = tagged(element("div", "memory-pager"), "memory-topics-pager");
const list = element("div", "memory-list");
list.append(lastReadNote, rows, topicsPager);
const doc = tagged(element("section", "memory-doc"), "memory-doc");
const topicsView = tagged(element("div", "memory-topics"), "memory-topics-view");
topicsView.append(list, doc);

const changeList = tagged(element("div", "memory-change-list"), "memory-change-list");
const changesPager = tagged(element("div", "memory-pager"), "memory-changes-pager");
const changesView = tagged(element("div", "memory-changes"), "memory-changes-view");
changesView.hidden = true;
changesView.append(changeList, changesPager, element("p", "memory-note", "Every change keeps its history: what taught Bob, when, and the earlier text. Nothing is deleted without you."));

view.append(head, bar, topicsView, changesView);

// ── Paging: whole rows that fit the height, never a scrollbar ──────────────────────────────────────────

function fit(container, nodes) {
  container.replaceChildren(...nodes);
  let shown = nodes.length;
  if (!container.clientHeight) return shown;
  while (shown > 1 && container.scrollHeight > container.clientHeight + 1) nodes[--shown].remove();
  return shown;
}

/** The pager keeps its room even when there is one page, so the rows that fit never change when it appears. */
function renderPager(container, page, total, prefix, reload) {
  container.replaceChildren();
  container.classList.toggle("idle", total <= page.shown && page.start === 0);
  const previous = button("Previous", `${prefix}-previous`, "ghost compact", () => { page.start = page.back.pop() ?? 0; return reload(); });
  previous.disabled = page.start === 0;
  const label = tagged(element("span", "memory-page-label", total ? `${page.start + 1}–${page.start + page.shown} of ${total}` : "0"), `${prefix}-label`);
  const next = button("Next", `${prefix}-next`, "ghost compact", () => { page.back.push(page.start); page.start += page.shown; return reload(); });
  next.disabled = page.start + page.shown >= total;
  container.append(previous, label, next);
}

function resetPage(page) {
  page.start = 0;
  page.back = [];
}

// ── Topics ─────────────────────────────────────────────────────────────────────────────────────────────

/** A topic tagged with a project follows the board's project filter; untagged topics always show. */
function visibleTopics() {
  const filter = new Set(state.controlCenter.filter);
  return topics.filter((topic) => !filter.size || !topic.project || filter.has(topic.project));
}

function renderFilterNote() {
  const filter = state.controlCenter.filter;
  filterNote.hidden = !filter.length;
  filterNote.textContent = filter.length ? `Topics for ${filter.map(projectName).join(", ")} and topics about no project. Change this on the board.` : "";
}

function renderTopicRow(topic) {
  const row = tagged(element("button", "memory-topic"), "memory-topic");
  row.type = "button";
  row.dataset.name = topic.name;
  row.classList.toggle("on", selected?.name === topic.name);
  const title = element("b", "", topic.name);
  if (topic.project) title.append(element("span", "memory-tag", projectName(topic.project)));
  if (lastRead?.topics.includes(topic.name)) title.append(tagged(element("span", "memory-read", "read for your last message"), "memory-read"));
  row.append(title, element("small", "", topic.description || "No description"));
  row.addEventListener("click", () => openTopic(topic.name).catch((error) => toast(error.message)));
  return row;
}

function renderTopics() {
  renderFilterNote();
  const items = visibleTopics();
  if (topicsPage.start >= items.length) resetPage(topicsPage);
  lastReadNote.hidden = !lastRead;
  lastReadNote.textContent = lastRead ? (lastRead.topics.length ? `For “${lastRead.message}” Bob read ${lastRead.topics.join(", ")}.` : `For “${lastRead.message}” Bob read no topic.`) : "";
  if (!items.length) {
    rows.replaceChildren(element("p", "memory-empty", query ? "No topic matches that search." : topics.length ? "No topic matches the project filter." : "Bob has not saved anything yet. Add a topic, or let Bob learn from your corrections and decisions."));
    topicsPage.shown = 0;
    renderPager(topicsPager, topicsPage, 0, "memory-topics-page", renderTopics);
    return;
  }
  topicsPage.shown = fit(rows, items.slice(topicsPage.start, topicsPage.start + MAX_TOPIC_ROWS).map(renderTopicRow));
  renderPager(topicsPager, topicsPage, items.length, "memory-topics-page", renderTopics);
}

async function loadTopics() {
  const all = await api(`${MEMORY}/topics`);
  allNames = new Set(all.topics.map((topic) => topic.name));
  topics = query ? (await api(`${MEMORY}/topics?query=${encodeURIComponent(query)}`)).topics : all.topics;
  lastRead = all.lastRead;
  handle?.setBadge(all.total);
  showWaiting(all.waiting);
  if (selected && !allNames.has(selected.name)) { selected = null; if (mode === "edit") mode = "view"; }
  // A form being filled in is left alone; reading a topic is refreshed, so its history and links are current.
  const target = mode === "view" ? selected?.name ?? visibleTopics()[0]?.name : undefined;
  if (target) await openTopic(target);
  else { renderTopics(); if (mode === "view") renderDoc(); }
}

function showWaiting(count) {
  pill.textContent = String(count);
  pill.hidden = !count;
}

async function refreshCounts() {
  const all = await api(`${MEMORY}/topics`);
  handle?.setBadge(all.total);
  showWaiting(all.waiting);
}

async function openTopic(name) {
  selected = (await api(`${MEMORY}/topics/${encodeURIComponent(name)}`)).topic;
  mode = "view";
  renderTopics();
  renderDoc();
}

function openNew(name) {
  selected = null;
  mode = "new";
  draft = { name, description: "", body: "", project: "" };
  if (sub !== "topics") showSub("topics").catch((error) => toast(error.message));
  renderTopics();
  renderDoc();
}

function openEdit() {
  mode = "edit";
  draft = { name: selected.name, description: selected.description, body: selected.body, project: selected.project ?? "" };
  renderDoc();
}

/** The text with each [[topic]] as a link: to the topic when it exists, to a new topic with that name when it does not. */
function renderText(text) {
  const box = tagged(element("div", "memory-text"), "memory-text");
  for (const part of text.split(/(\[\[[a-z0-9][a-z0-9-]{0,59}\]\])/)) {
    const link = /^\[\[(.+)\]\]$/.exec(part);
    if (!link) { box.append(document.createTextNode(part)); continue; }
    const missing = !allNames.has(link[1]);
    const anchor = button(link[1], "memory-link", `memory-link${missing ? " missing" : ""}`, () => missing ? openNew(link[1]) : openTopic(link[1]));
    anchor.title = missing ? "No such topic yet. Create it." : "Open this topic";
    box.append(anchor);
  }
  return box;
}

function projectSelect(value) {
  const select = tagged(element("select"), "memory-project");
  select.append(new Option("No project", ""));
  const known = state.projects.map((project) => project.id);
  for (const project of state.projects) select.append(new Option(project.name, project.id));
  if (value && !known.includes(value)) select.append(new Option(value, value));
  select.value = value;
  return select;
}

function field(label, control) {
  const wrap = element("label", "memory-field");
  wrap.append(element("span", "", label), control);
  return wrap;
}

function renderDocForm() {
  const form = tagged(element("form", "memory-form"), "memory-form");
  const creating = mode === "new";
  const name = tagged(element("input"), "memory-name");
  name.value = draft.name;
  name.placeholder = "for example release-gate";
  name.maxLength = 60;
  name.disabled = !creating;
  const description = tagged(element("input"), "memory-description");
  description.value = draft.description;
  description.maxLength = 200;
  description.placeholder = "One line Bob sees in the list";
  const project = projectSelect(draft.project);
  const body = tagged(element("textarea", "memory-body"), "memory-body");
  body.value = draft.body;
  body.placeholder = "What Bob should know. Link another topic with [[topic-name]].";
  const buttons = element("div", "memory-form-actions");
  const save = tagged(element("button", "primary compact", "Save"), "memory-save");
  save.type = "submit";
  buttons.append(save, button("Cancel", "memory-cancel", "ghost compact", () => { mode = "view"; renderDoc(); }));
  form.append(...creating ? [field("Name", name)] : [element("h3", "", draft.name)], field("One line", description), field("Project", project), field("Text", body), buttons);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    save.disabled = true;
    saveTopic({ name: slug(name.value), description: description.value, body: body.value, project: project.value || null }, creating)
      .catch((error) => toast(error.message)).finally(() => { save.disabled = false; });
  });
  return form;
}

async function saveTopic(input, creating) {
  const result = creating
    ? await api(`${MEMORY}/topics`, { method: "POST", body: JSON.stringify(input) })
    : await api(`${MEMORY}/topics/${encodeURIComponent(selected.name)}`, { method: "PUT", body: JSON.stringify({ description: input.description, body: input.body, project: input.project }) });
  selected = result.topic;
  mode = "view";
  toast(result.change ? "Saved. The change is under What Bob changed." : "Nothing changed.");
  if (creating) resetPage(topicsPage);
  await loadTopics();
}

async function removeTopic() {
  const topic = selected;
  if (!await confirmAction({
    title: `Delete “${topic.name}”?`,
    message: "Bob forgets this topic. Its text stays in What Bob changed, where you can revert the deletion.",
    confirmLabel: "Delete topic", destructive: true,
  })) return;
  await api(`${MEMORY}/topics/${encodeURIComponent(topic.name)}`, { method: "DELETE" });
  selected = null;
  toast(`Deleted “${topic.name}”.`);
  await loadTopics();
}

function renderDocView() {
  const box = element("div", "memory-view");
  const title = element("div", "memory-doc-head");
  const name = element("h3", "", selected.name);
  if (selected.project) name.append(element("span", "memory-tag", projectName(selected.project)));
  title.append(name, element("span", "memory-spacer"), button("Edit", "memory-edit", "ghost compact", openEdit), button("Delete", "memory-delete", "ghost compact destructive", removeTopic));
  box.append(title, tagged(element("p", "memory-description-line", selected.description || "No description"), "memory-description-line"), renderText(selected.body));
  if (selected.linkedFrom.length) {
    const from = tagged(element("p", "memory-linked-from"), "memory-linked-from");
    from.append("Linked from: ");
    for (const name of selected.linkedFrom) from.append(button(name, "memory-link", "memory-link", () => openTopic(name)), " ");
    box.append(from);
  }
  box.append(element("p", "memory-note", `Last updated ${formatDate(selected.updatedAt)}.`));
  if (selected.history.length) {
    const history = tagged(element("ul", "memory-history"), "memory-history");
    for (const entry of selected.history.slice(0, 5)) {
      history.append(element("li", "", `${formatDate(entry.createdAt)} · ${entry.author === "bob" ? "Bob" : "You"} · ${STATUS_LABELS[entry.status].toLowerCase()} · ${entry.why}`));
    }
    box.append(element("p", "memory-note", "History"), history);
  }
  return box;
}

function renderDoc() {
  if (mode === "edit" || mode === "new") doc.replaceChildren(renderDocForm());
  else if (selected) doc.replaceChildren(renderDocView());
  else doc.replaceChildren(element("p", "memory-empty", "Select a topic to read it, or add one with + Topic."));
}

// ── What Bob changed ───────────────────────────────────────────────────────────────────────────────────

function sourceText(change) {
  const source = change.source;
  if (change.author === "person" || source.kind === "person") return `You · ${change.why}`;
  const where = source.kind === "conversation" ? "a project conversation" : "chat with Bob";
  return `From your message “${source.text}” in ${where}${source.projectName ? ` (${source.projectName})` : ""} · why: ${change.why}`;
}

function renderDiff(change) {
  const diff = tagged(element("div", "memory-diff"), "memory-diff");
  for (const line of change.diff.slice(0, DIFF_LINES)) diff.append(element("div", `memory-diff-line ${line.type}`, `${line.type === "add" ? "+" : "-"} ${line.text}`));
  if (change.diff.length > DIFF_LINES) diff.append(element("div", "memory-diff-more", `… ${change.diff.length - DIFF_LINES} more lines`));
  if (!change.diff.length) diff.append(element("div", "memory-diff-more", "No visible difference"));
  return diff;
}

async function settle(change, action, body) {
  await api(`${MEMORY}/changes/${encodeURIComponent(change.id)}/${action}`, { method: "POST", ...body ? { body: JSON.stringify(body) } : {} });
  editingChange = null;
  await Promise.all([loadChanges(), loadTopics()]);
}

async function revert(change) {
  if (change.status === "kept" && !await confirmAction({
    title: `Revert the change to “${change.topic}”?`,
    message: change.kind === "create" ? "The topic goes away again." : "The text before this change comes back.",
    confirmLabel: "Revert",
  })) return;
  await settle(change, "revert");
}

function renderChangeForm(change) {
  const form = tagged(element("form", "memory-form"), "memory-change-form");
  const description = tagged(element("input"), "memory-change-description");
  description.value = change.after.description;
  description.maxLength = 200;
  const body = tagged(element("textarea", "memory-body"), "memory-change-body");
  body.value = change.after.body;
  const buttons = element("div", "memory-form-actions");
  const save = tagged(element("button", "primary compact", change.status === "pending" ? "Save and keep" : "Save"), "memory-change-save");
  save.type = "submit";
  buttons.append(save, button("Cancel", "memory-change-cancel", "ghost compact", () => { editingChange = null; return renderChanges(); }));
  form.append(field("One line", description), field("Text", body), buttons);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    save.disabled = true;
    settle(change, "edit", { description: description.value, body: body.value, project: change.after.project })
      .catch((error) => toast(error.message)).finally(() => { save.disabled = false; });
  });
  return form;
}

function renderChange(change) {
  const card = tagged(element("article", `memory-change ${change.status}`), "memory-change");
  card.dataset.id = change.id;
  card.dataset.topic = change.topic;
  card.dataset.status = change.status;
  const head = element("div", "memory-change-head");
  head.append(element("b", "", change.topic), element("span", "memory-kind", KIND_LABELS[change.kind] + (change.edited ? " · edited by you" : "")),
    tagged(element("span", `memory-status ${change.status}`, STATUS_LABELS[change.status]), "memory-change-status"), element("span", "memory-spacer"),
    element("span", "memory-when", formatDate(change.createdAt)));
  card.append(head, renderDiff(change), tagged(element("div", "memory-source", sourceText(change)), "memory-change-source"));
  if (editingChange === change.id && change.after) { card.append(renderChangeForm(change)); return card; }
  const open = change.status === "pending" || change.status === "applied";
  const actions = element("div", "memory-actions");
  if (open) actions.append(button("Keep", "memory-keep", "primary compact", () => settle(change, "keep")));
  if (open && change.after) actions.append(button("Edit", "memory-edit-change", "ghost compact", () => { editingChange = change.id; return renderChanges(); }));
  if (change.status !== "reverted") actions.append(button("Revert", "memory-revert", "ghost compact", () => revert(change)));
  if (actions.children.length) card.append(actions);
  return card;
}

function renderChanges() {
  if (!changes.length) {
    changeList.replaceChildren(element("p", "memory-empty", "Bob has not changed anything yet, and neither have you."));
    changesPage.shown = 0;
    renderPager(changesPager, changesPage, 0, "memory-changes-page", loadChanges);
    return;
  }
  changesPage.shown = fit(changeList, changes.map(renderChange));
  renderPager(changesPager, changesPage, changesTotal, "memory-changes-page", loadChanges);
}

async function loadChanges() {
  const result = await api(`${MEMORY}/changes?offset=${changesPage.start}&limit=${CHANGES_FETCH}`);
  changes = result.changes;
  changesTotal = result.total;
  showWaiting(result.waiting);
  renderChanges();
}

function applySub(next) {
  sub = next;
  topicsTab.classList.toggle("active", next === "topics");
  changesTab.classList.toggle("active", next === "changes");
  topicsTab.setAttribute("aria-selected", String(next === "topics"));
  changesTab.setAttribute("aria-selected", String(next === "changes"));
  topicsView.hidden = next !== "topics";
  changesView.hidden = next !== "changes";
  search.hidden = next !== "topics";
}

async function showSub(next) {
  applySub(next);
  if (next === "changes") { resetPage(changesPage); await loadChanges(); } else await loadTopics();
}

// ── Settings and wiring ────────────────────────────────────────────────────────────────────────────────

async function loadAsk() {
  ask.checked = (await api(SETTINGS)).askBeforeSaving === true;
}

ask.addEventListener("change", () => {
  const wanted = ask.checked;
  api(SETTINGS, { method: "PUT", body: JSON.stringify({ askBeforeSaving: wanted }) }).catch((error) => { ask.checked = !wanted; toast(error.message); });
});

let searching = null;
search.addEventListener("input", () => {
  clearTimeout(searching);
  searching = setTimeout(() => {
    query = search.value.trim();
    resetPage(topicsPage);
    loadTopics().catch((error) => toast(error.message));
  }, 250);
});

handle = registerControlView({
  id: "memory", title: "Bob's memory", order: 10, element: view,
  onShow() {
    loadAsk().catch((error) => toast(error.message));
    showSub(sub).catch((error) => toast(error.message));
  },
});
applySub("topics");
showWaiting(0);

// The badge and the count of changes waiting for you stay current while the control center is open.
window.addEventListener("control-center-activated", () => {
  refreshCounts().catch((error) => console.warn("Could not read Bob's memory", error));
});

// The board's project filter also filters topics; the board announces each time it draws.
window.addEventListener("control-center-rendered", () => {
  if (!view.hidden && sub === "topics") renderTopics();
});

// The rows that fit follow the size of the view. A change being edited is left alone so typing is not lost.
new ResizeObserver(() => {
  if (view.hidden) return;
  if (sub === "topics") renderTopics(); else if (!editingChange) renderChanges();
}).observe(view);
