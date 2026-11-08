// Control center: the Clusters tab. The running agents of other people in the person's clusters, grouped by machine, limited to
// what they share. A card opens its conversation to read; nothing here can act on another person's agent.
import { api } from "./api.js";
import { loadSessionNodes } from "./chat-controls.js";
import { refreshControlCenter, saveControlCenter } from "./control-center.js";
import { briefStatus } from "./control-cards.js";
import { createControlViewElement, registerControlView, showControlView } from "./control-views.js";
import { setMobileView, shortSessionTitle } from "./layout.js";
import { selectProject } from "./project-selection.js";
import { makeButton, makeNode } from "./relay-ui.js";
import { toast } from "./shell.js";
import { openSession } from "./socket.js";
import { state } from "./state.js";

const EMPTY = { clusters: [], machines: [], projects: [] };

let data = EMPTY;
let loading = null;
let reloadAfter = false;
let selectedCluster = null;
let page = 0;
let pageStarts = [0];
let liveFilterStale = false;
let filterKey = "";

const testid = (node, id) => { node.dataset.testid = id; return node; };

function ago(iso) {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "active just now";
  if (minutes < 90) return `active ${minutes} min ago`;
  return `active ${Math.round(minutes / 60)} h ago`;
}

// ── Layout ────────────────────────────────────────────────────────────────────────────────────────────

const root = createControlViewElement("clusters");
root.classList.add("clusters");
const head = makeNode("div", "clusters-head");
const heading = makeNode("div");
const hint = testid(makeNode("p", "clusters-hint"), "clusters-hint");
heading.append(makeNode("h2", "", "Clusters"), hint);
const refreshButton = makeButton("Refresh", "clusters-refresh", () => load().catch((error) => toast.error(error.message)));
head.append(heading, refreshButton);

const bar = makeNode("div", "control-bar clusters-bar");
const clusterChips = testid(makeNode("div", "control-filters clusters-chips"), "clusters-chips");
clusterChips.setAttribute("aria-label", "Clusters");
const projectChips = testid(makeNode("div", "control-filters"), "clusters-filters");
projectChips.setAttribute("aria-label", "Filter by project");
bar.append(clusterChips, projectChips);

const note = testid(makeNode("p", "clusters-note", "Only projects people share with you appear here, and only what is running. Their agents are read-only: open one to read it, nothing you do reaches it."), "clusters-note");
const list = testid(makeNode("div", "clusters-list"), "clusters-list");
const pager = testid(makeNode("div", "clusters-pager"), "clusters-pager");
const idle = testid(makeNode("p", "clusters-idle"), "clusters-idle");
root.append(head, bar, note, list, pager, idle);

// ── What is shown ─────────────────────────────────────────────────────────────────────────────────────

/** Agents in the chosen cluster and, where project ids match, in the projects the board is filtered to. */
function visibleAgents() {
  const filter = state.controlCenter.filter;
  return data.machines.flatMap((machine) => machine.agents
    .filter((agent) => (!selectedCluster || agent.clusterIds.includes(selectedCluster)) && (!filter.length || filter.includes(agent.projectId)))
    .map((agent) => ({ agent, machine })));
}

function renderClusterChips() {
  clusterChips.replaceChildren();
  if (!data.clusters.length) return;
  const all = testid(makeNode("button", "control-chip", "All clusters"), "clusters-chip-all");
  all.type = "button";
  all.classList.toggle("active", !selectedCluster);
  all.addEventListener("click", () => { selectedCluster = null; page = 0; pageStarts = [0]; paint(); });
  clusterChips.append(all);
  for (const cluster of data.clusters) {
    const chip = testid(makeNode("button", "control-chip", `${cluster.name} · ${cluster.running} running`), `clusters-chip-${cluster.id}`);
    chip.type = "button";
    chip.classList.toggle("active", selectedCluster === cluster.id);
    chip.title = `${cluster.machines} ${cluster.machines === 1 ? "machine" : "machines"} of other people`;
    chip.addEventListener("click", () => { selectedCluster = selectedCluster === cluster.id ? null : cluster.id; page = 0; pageStarts = [0]; paint(); });
    clusterChips.append(chip);
  }
}

function renderProjectChips() {
  projectChips.replaceChildren();
  const chosen = state.controlCenter.filter;
  const all = testid(makeNode("button", "control-chip", "All"), "clusters-filter-all");
  all.type = "button";
  all.classList.toggle("active", !chosen.length);
  all.addEventListener("click", () => setFilter([]));
  projectChips.append(all);
  for (const project of data.projects) {
    const chip = testid(makeNode("button", "control-chip", project.name), `clusters-filter-${project.id}`);
    chip.type = "button";
    chip.classList.toggle("active", chosen.includes(project.id));
    chip.addEventListener("click", () => setFilter(chosen.includes(project.id) ? chosen.filter((id) => id !== project.id) : [...chosen, project.id]));
    projectChips.append(chip);
  }
}

/** The filter belongs to the whole control center, so the live board catches up when it is shown. */
function setFilter(next) {
  state.controlCenter.filter = next;
  saveControlCenter();
  liveFilterStale = true;
  page = 0;
  pageStarts = [0];
  paint();
}

function emptyText(nobodyRuns) {
  if (!data.clusters.length) return "You are not in a cluster. Join or create one in Settings → Cluster; people then share projects with you.";
  if (!data.machines.length) return "Nobody else is in your clusters yet.";
  if (!nobodyRuns) return "Nothing matches the cluster or project filter.";
  return "Nobody in your clusters is running anything they share with you right now.";
}

function renderCard({ agent, machine }) {
  const card = testid(makeNode("article", "control-card cluster-card"), "cluster-card");
  card.tabIndex = 0;
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `Read ${agent.title} on ${machine.name}`);
  card.dataset.key = `${agent.projectId}:${agent.conversationId}`;
  card.dataset.node = machine.nodeId;
  const top = makeNode("div", "control-card-top");
  top.append(makeNode("span", "control-project", agent.projectName), makeNode("span", "control-spacer"), testid(makeNode("span", "control-badge", machine.name), "cluster-card-machine"));
  const live = makeNode("div", "control-live");
  live.append(makeNode("span", `control-pulse ${agent.state === "running" ? "running" : "review"}`), makeNode("span", "control-live-text", briefStatus(agent.summary) ?? (agent.state === "running" ? "Working…" : "Background work is still running")));
  const meta = [agent.agentLabel, agent.agentModel, agent.state === "background" ? "background work" : null, ago(agent.updatedAt)].filter(Boolean).join(" · ");
  card.append(top, makeNode("h3", "control-title", agent.title), live, makeNode("div", "control-meta", meta), testid(makeNode("div", "cluster-card-foot", "Read-only · click to open"), "cluster-card-open"));
  const open = () => diveIn(agent, machine).catch((error) => toast.error(error.message));
  card.addEventListener("click", open);
  card.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); open(); } });
  return card;
}

function renderLane(machine, count) {
  const lane = testid(makeNode("div", "control-lane cluster-lane"), "cluster-lane");
  lane.dataset.node = machine.nodeId;
  const clusters = data.clusters.filter((cluster) => machine.clusterIds.includes(cluster.id)).map((cluster) => cluster.name).join(", ");
  lane.append(makeNode("b", "", machine.name), makeNode("span", "", ` · ${count} running · ${clusters}${machine.away ? " · not answering" : ""}`));
  return lane;
}

/** Draws the page that starts at `pageStarts[page]`: as many cards as fit the height, so the list pages instead of scrolling. */
function fill(entries) {
  list.replaceChildren();
  const counts = new Map();
  for (const entry of entries) counts.set(entry.machine.nodeId, (counts.get(entry.machine.nodeId) ?? 0) + 1);
  const room = list.clientHeight;
  const start = pageStarts[page];
  let index = start;
  let previous = null;
  while (index < entries.length) {
    const entry = entries[index];
    const added = [];
    if (previous !== entry.machine.nodeId) added.push(renderLane(entry.machine, counts.get(entry.machine.nodeId)));
    added.push(renderCard(entry));
    list.append(...added);
    if (index > start && room && list.scrollHeight > room + 1) { for (const node of added) node.remove(); break; }
    previous = entry.machine.nodeId;
    index += 1;
  }
  pageStarts = [...pageStarts.slice(0, page + 1), ...(index < entries.length ? [index] : [])];
  pager.replaceChildren();
  pager.hidden = pageStarts.length === 1 && page === 0;
  if (pager.hidden) return;
  const previousButton = makeButton("Previous", "clusters-page-previous", () => { page -= 1; paint(); });
  previousButton.disabled = page === 0;
  const label = testid(makeNode("span", "", `${start + 1}–${index} of ${entries.length}`), "clusters-page-label");
  const nextButton = makeButton("Next", "clusters-page-next", () => { page += 1; paint(); });
  nextButton.disabled = index >= entries.length;
  pager.append(previousButton, label, nextButton);
}

function paint() {
  filterKey = JSON.stringify(state.controlCenter.filter);
  renderClusterChips();
  renderProjectChips();
  const entries = visibleAgents();
  tab.setBadge(data.machines.reduce((total, machine) => total + machine.agents.length, 0));
  const people = data.machines.length;
  hint.textContent = people
    ? `${people} ${people === 1 ? "machine" : "machines"} of other people · only what each shares with you`
    : "Other people's running agents appear here, limited to what they share with you.";
  const quiet = data.machines.filter((machine) => !machine.agents.length);
  idle.hidden = !quiet.length;
  idle.textContent = quiet.length ? `Nothing running that is shared with you on: ${quiet.map((machine) => `${machine.name}${machine.away ? " (not answering)" : ""}`).join(", ")}.` : "";
  if (!entries.length) {
    list.replaceChildren(makeNode("p", "control-empty clusters-empty", emptyText(data.machines.every((machine) => !machine.agents.length))));
    pager.replaceChildren();
    pager.hidden = true;
    return;
  }
  if (pageStarts[page] === undefined || pageStarts[page] >= entries.length) { page = 0; pageStarts = [0]; }
  fill(entries);
}

// ── Reading another person's agent ───────────────────────────────────────────────────────────────────

const banner = testid(makeNode("div", "cluster-dive-banner"), "cluster-dive-banner");
banner.hidden = true;
const bannerText = makeNode("span");
banner.append(bannerText, makeButton("Back to Clusters", "cluster-dive-back", () => { setMobileView("control"); showControlView("clusters"); }));
document.querySelector("#controlLeaseBanner")?.after(banner);

let dive = null;

/** While another person's conversation is open from here, nothing in the page can write to it or act on it. */
function syncDive() {
  const open = Boolean(dive) && state.activeProjectId === dive.projectId
    && (state.activeSessionId === dive.sessionId || state.activeConversationId === dive.conversationId);
  if (!open) dive = null;
  document.body.classList.toggle("cluster-dive", open);
  banner.hidden = !open;
}
window.addEventListener("app-view-changed", syncDive);

/**
 * Opens the conversation in the normal view, on the machine that runs it. It does not use the list's open, which marks the
 * conversation reviewed and takes ownership of one whose machine is away: another person's conversation is never taken
 * over from here. The machine is asked first, without leaving the control center, and one that does not answer cannot be opened.
 */
async function diveIn(agent, machine) {
  const { nodes } = await api(`/api/projects/${encodeURIComponent(agent.projectId)}/session-nodes?nodeId=${encodeURIComponent(agent.nodeId)}`);
  if (!nodes.find((node) => node.id === agent.nodeId)?.online) {
    toast.error(`${machine.name} is not answering, so ${agent.title} cannot be opened right now`);
    return;
  }
  if (state.activeProjectId !== agent.projectId) await selectProject(agent.projectId);
  const session = state.sessions.find((candidate) => (candidate.conversationId ?? candidate.id) === agent.conversationId) ?? state.sessions.find((candidate) => candidate.path === agent.path);
  if (!session) {
    toast("That conversation is no longer listed");
    setMobileView("control");
    await load();
    return;
  }
  await loadSessionNodes(agent.projectId, agent.nodeId);
  state.activeSessionId = session.id;
  state.activeTaskId = session.taskId || null;
  state.activeNodeId = agent.nodeId;
  dive = { projectId: agent.projectId, sessionId: session.id, conversationId: agent.conversationId };
  bannerText.textContent = `Read-only: ${agent.title}, an agent on ${machine.name} that is shared with you. You can read it; nothing you do here reaches it.`;
  document.body.classList.add("cluster-dive");
  banner.hidden = false;
  openSession(session.path, shortSessionTitle(session), false, Boolean(state.activeTaskId));
}

// ── The tab ───────────────────────────────────────────────────────────────────────────────────────────

/** Reads the list again; a refresh asked for while one is under way runs once more afterwards. */
export function load() {
  if (loading) { reloadAfter = true; return loading; }
  loading = (async () => {
    do {
      reloadAfter = false;
      data = await api("/api/control-center/clusters");
      if (selectedCluster && !data.clusters.some((cluster) => cluster.id === selectedCluster)) selectedCluster = null;
      paint();
    } while (reloadAfter);
  })().finally(() => { loading = null; });
  return loading;
}

const tab = registerControlView({ id: "clusters", title: "Clusters", order: 3, element: root, onShow: () => { load().catch((error) => toast.error(error.message)); } });

// The badge shows as soon as the control center opens, and follows the same signals as the board.
window.addEventListener("control-center-activated", () => { load().catch((error) => console.warn("Could not load the clusters", error)); });
window.addEventListener("running-refreshed", () => {
  if (document.body.classList.contains("view-control")) load().catch((error) => console.warn("Could not refresh the clusters", error));
});
// The filter is shared: the board's chips or the project list may have changed it while this tab was hidden.
window.addEventListener("control-center-rendered", () => {
  if (JSON.stringify(state.controlCenter.filter) !== filterKey) { page = 0; pageStarts = [0]; paint(); }
});
window.addEventListener("control-view-changed", (event) => {
  if (event.detail.id === "live" && liveFilterStale) { liveFilterStale = false; refreshControlCenter().catch(() => undefined); }
  if (event.detail.id === "clusters") { page = 0; pageStarts = [0]; paint(); }
});
// The page count follows the height the list has.
let lastHeight = 0;
new ResizeObserver(() => {
  const height = list.clientHeight;
  if (height === lastHeight) return;
  lastHeight = height;
  if (height && data.machines.length) requestAnimationFrame(() => { page = 0; pageStarts = [0]; paint(); });
}).observe(list);
