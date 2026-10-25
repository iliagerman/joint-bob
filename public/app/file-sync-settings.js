// Settings → File sync (admin only). Status: the built-in engine's switch on this machine, the
// machines it syncs with, and each shared project: who moves its files (Syncthing or Joint Bob),
// what is left to copy, problems, and the owner's move between the two. Differences: where Joint
// Bob's view of a project's files differs from another machine's. Every action applies at once.
// Lists page to the height they are given instead of scrolling; a project's details replace the
// lists rather than growing a row.
import { api } from "./api.js";
import { twinName } from "./cluster-twins.js";
import { isNodeAdmin } from "./node-admin.js";
import { createFittedList, formatBytes, formatWhen, makeBadge, makeButton, makeNode, makeTwoStepButton, showStatus } from "./relay-ui.js";
import { state } from "./state.js";

const byId = (id) => document.getElementById(id);
const panel = byId("settingsPanel-file-sync");
const loadStatus = byId("fileSyncLoadStatus");
const engineStatus = byId("fileSyncEngineStatus");
const projectsStatus = byId("fileSyncProjectsStatus");
const detailStatus = byId("fileSyncDetailStatus");
const diffStatus = byId("fileSyncDiffStatus");
const enabledToggle = byId("fileSyncEnabled");
const tabs = byId("fileSyncTabs");

/** A moving or copying project is refreshed while the tab is visible, at most this often; nothing is refreshed otherwise. */
const BUSY_REFRESH_MS = 5_000;
/** The machines list gets room for the machines there are, up to three rows; the projects take the rest, and a short screen shrinks the machines to one row. */
const PEER_ROW_PX = 66;
const KIND_LABEL = { project: "Project files", tickets: "Ticket files", worktrees: "Worktree files" };
const WORKER_LABEL = { running: "Running", starting: "Starting", restarting: "Restarting", stopping: "Stopping", stopped: "Stopped", off: "Off", failed: "Stopped after repeated failures" };
const ROUTE_LABEL = { direct: "Direct connection", relay: "Through the relay", none: "Not connected yet" };
const DIFFERENCE_LABEL = { "only-here": "Only on this machine", content: "Different content", mode: "Different permissions" };
const ERROR_LABEL = { error: "Error", notice: "Note", blocked: "Blocked" };
const MOVING = new Set(["releasing", "bootstrapping", "restoring"]);

let status = null;
let projects = [];
let clusters = [];
let activeTab = "status";
let openProjectId = null;
/** The last checks loaded for the open project and the engine it would move to: `{projectId, engine, checks, cleanSince}`, or `{projectId, engine, loading: true}`. */
let checks = null;
let errorShare = null;
let errorSignature = "";
/** The differences being listed: `{projectId, peer, share}`. */
let openDiff = null;
let loadTicket = 0;
let refreshTimer;

// ---- wording ----

function plural(count, one, many = `${one}s`) { return `${count} ${count === 1 ? one : many}`; }

function duration(ms) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return plural(minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${plural(hours, "hour")} ${plural(minutes % 60, "minute")}` : plural(hours, "hour");
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${plural(days, "day")} ${plural(hours % 24, "hour")}` : plural(days, "day");
}

function since(iso) {
  const at = Date.parse(iso ?? "");
  return Number.isFinite(at) ? Date.now() - at : null;
}

function matchingText(cleanSince) {
  const elapsed = since(cleanSince);
  return elapsed === null ? "Not matching yet" : `Matching for ${duration(elapsed)}`;
}

function nodeName(nodeId) { return twinName(nodeId, clusters); }

function hostOf(origin) {
  try { return new URL(origin).host; } catch { return origin; }
}

function sharesOf(projectId) { return (status?.shares ?? []).filter((share) => share.projectId === projectId); }

function replacedShare(share) { return share.state === "error" && /looks replaced/i.test(share.message ?? ""); }

/** fix (P4+P5): the owner's view of the other machines whose own move has not finished (each says where it stands). */
function peersBehind(project) {
  const settled = project.engine === "builtin" ? "builtin" : "syncthing";
  return (project.peers ?? []).filter((peer) => peer.phase !== settled);
}

/** What the project row and its details say about who moves its files and what is happening now. */
function projectView(project) {
  const shares = sharesOf(project.projectId);
  const left = shares.reduce((sum, share) => ({ files: sum.files + share.need.files, bytes: sum.bytes + share.need.bytes }), { files: 0, bytes: 0 });
  const problems = shares.reduce((sum, share) => sum + share.errors + share.blocked, 0);
  // A move held by something outside it (a person, sharing) changes nothing by itself: it is not refreshed for.
  const view = { shares, left, problems, replaced: shares.some(replacedShare), moving: !project.waiting && !project.phaseError, kind: "" };
  const behind = peersBehind(project);
  switch (project.phase) {
    case "releasing": return { ...view, label: "Waiting for Syncthing to let go of the folders" };
    case "bootstrapping": return { ...view, label: "Checking both machines' files" };
    case "restoring": return { ...view, label: "Moving back to Syncthing" };
    case "builtin":
      if (project.engine === "syncthing") return { ...view, label: "Moving back to Syncthing" };
      if (behind.length) return { ...view, moving: view.moving && behind.some((peer) => !peer.error), label: `Still moving on ${behind.map((peer) => peer.name).join(", ")}` };
      return { ...view, moving: false, label: "Synced by Joint Bob", kind: "ok" };
    default:
      if (project.engine === "builtin") return { ...view, label: "Moving to built-in sync" };
      if (behind.length) return { ...view, moving: view.moving && behind.some((peer) => !peer.error), label: `Still moving back on ${behind.map((peer) => peer.name).join(", ")}` };
      return { ...view, moving: false, label: "Synced by Syncthing" };
  }
}

function factsOf(project, view) {
  // integrate: "same files" only once a comparison said so; a project file sync does not check here has none.
  const facts = [project.differences > 0 ? `${plural(project.differences, "file")} differ right now`
    : !project.shares?.length ? "Not compared by built-in sync on this machine"
    : project.cleanSince ? "Same files on every machine" : "Not compared with the other machines yet"];
  if (project.cleanSince) facts.push(matchingText(project.cleanSince));
  if (view.left.files > 0) facts.push(`${plural(view.left.files, "file")} left to copy (${formatBytes(view.left.bytes)})`);
  return facts;
}

function problemText(project, view) {
  const parts = [];
  if (project.phaseError) parts.push(project.phaseError);
  for (const peer of peersBehind(project)) if (peer.error) parts.push(`${peer.name}: ${peer.error}`);
  if (view.replaced) parts.push("A folder looks replaced and waits for your confirmation");
  if (view.problems > 0) parts.push(`${plural(view.problems, "file")} could not be synced`);
  return parts.join(". ");
}

// ---- loading ----

function paged(items, page, size) { return { total: items.length, items: items.slice((page - 1) * size, page * size) }; }

/** Before the projects answer exists (or when it fails) the rows come from the folders the engine reports, named from the app's project list. */
function projectsFromShares(shares) {
  const ids = [...new Set(shares.map((share) => share.projectId))];
  return ids.map((projectId) => {
    const own = shares.filter((share) => share.projectId === projectId);
    const differences = own.reduce((sum, share) => sum + share.peers.reduce((count, peer) => count + peer.differences, 0), 0);
    return {
      projectId, name: state.projects?.find((project) => project.id === projectId)?.name ?? projectId, owner: false,
      engine: own.some((share) => share.phase === "builtin") ? "builtin" : "syncthing", phase: own[0]?.phase ?? "syncthing",
      phaseMessage: null, phaseError: null, cleanSince: null, differences, shares: own.map((share) => share.kind), waiting: false, peers: [],
    };
  });
}

/** `names`: also reread the clusters that name the machines (tab open and Refresh only, not the busy refresh). */
async function refresh(names = false) {
  const ticket = ++loadTicket;
  let projectsError = null;
  const [nextStatus, nextProjects, nextClusters] = await Promise.all([
    api("/api/file-sync/status"),
    api("/api/file-sync/projects").then((body) => body.projects, (error) => { projectsError = error; return null; }),
    names ? api("/api/clusters").then((body) => body.clusters ?? [], () => clusters) : clusters,
  ]);
  if (ticket !== loadTicket) return;
  status = nextStatus;
  clusters = nextClusters;
  projects = (nextProjects ?? projectsFromShares(status.shares ?? [])).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  showStatus(projectsStatus, projectsError ? `Could not load the projects: ${projectsError.message}` : "", projectsError ? "error" : "info");
  render();
  scheduleRefresh();
}

function visible() { return Boolean(panel.closest("dialog")?.open) && !panel.hidden && panel.checkVisibility(); }

/** Files are on their way only while a machine that could send them is reachable; ones waiting for an away machine are not. */
function copying(share) {
  const reachable = new Set((status?.peers ?? []).filter((peer) => peer.present).map((peer) => peer.nodeId));
  return share.need.files > 0 && (share.peers ?? []).some((peer) => reachable.has(peer.peer));
}

function busy() {
  if (["starting", "restarting"].includes(status?.worker)) return true;
  return projects.some((project) => projectView(project).moving) || (status?.shares ?? []).some(copying);
}

/** One-shot, armed by the load before it: a quiet engine is never asked again until something happens here. */
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (!busy() || !visible()) return;
  refreshTimer = setTimeout(() => {
    if (visible()) void refresh().catch((error) => showStatus(loadStatus, `Could not refresh file sync: ${error.message}`, "error"));
  }, BUSY_REFRESH_MS);
}

/** Called when the File sync tab opens and by its Refresh button. Errors stay on the screen. */
export async function loadFileSyncSettings() {
  if (!isNodeAdmin()) return;
  showStatus(loadStatus, "Loading…");
  try {
    await refresh(true);
    showStatus(loadStatus, "");
    if (openProjectId) await reloadErrors();
    if (openDiff && activeTab === "differences") await reloadDiffItems();
  } catch (error) { showStatus(loadStatus, `Could not load file sync: ${error.message}`, "error"); }
}

function render() {
  renderEngine();
  byId("fileSyncPeerList").style.flexBasis = `${Math.min(3, Math.max(1, status.peers.length)) * PEER_ROW_PX}px`;
  void peerList.reload();
  void projectList.reload();
  if (openProjectId) renderProjectDetail();
  renderDiffCount();
  if (activeTab === "differences") { void diffList.reload(); if (openDiff) renderDiffDetail(); }
}

// ---- engine ----

function renderEngine() {
  const { config, worker, origins } = status;
  enabledToggle.checked = status.enabled;
  enabledToggle.disabled = config.enabledBy === "environment";
  enabledToggle.title = enabledToggle.disabled ? `JOINT_BOB_FILE_SYNC in this machine's service settings keeps it ${status.enabled ? "on" : "off"}` : "";
  const badge = byId("fileSyncWorker");
  badge.textContent = WORKER_LABEL[worker] ?? worker;
  badge.className = `cluster-badge ${worker === "running" ? "ok" : worker === "failed" ? "error" : ""}`.trim();
  byId("fileSyncRetry").hidden = worker !== "failed";
  byId("fileSyncAddresses").textContent = !status.enabled ? "Off: Syncthing moves every project's files."
    : origins.length ? `Other machines reach it directly at ${origins.map(hostOf).join(", ")}`
    : "No direct address here, so other machines reach it through Joint Bob's usual, slower connection.";
}

async function saveEnabled(enabled) {
  showStatus(engineStatus, "");
  try {
    status = await api("/api/file-sync/config", { method: "PUT", body: JSON.stringify({ enabled }) });
    await refresh();
    showStatus(engineStatus, enabled ? "Built-in file sync is on. Projects stay with Syncthing until their owner moves them." : "Built-in file sync is off.", "ok");
  } catch (error) {
    enabledToggle.checked = !enabled;
    showStatus(engineStatus, error.message, "error");
  }
}

// ---- machines ----

function peerFacts(peer) {
  const facts = [ROUTE_LABEL[peer.route] ?? peer.route];
  const elapsed = since(peer.heardAt);
  facts.push(elapsed === null ? "Not heard from since this machine started" : `Last heard ${elapsed < 60_000 ? "just now" : `${duration(elapsed)} ago`}`);
  if (peer.protocol === 0 || peer.switchCapable === false) facts.push("Needs a newer Joint Bob for built-in sync");
  else if (peer.enabled === false) facts.push("Built-in sync is off there");
  return facts.join(" · ");
}

const peerList = createFittedList({
  list: byId("fileSyncPeerList"), pager: byId("fileSyncPeerPager"), testPrefix: "file-sync-peers", initialSize: 3,
  emptyText: "No other machine syncs files with this one right now.",
  fetchPage: async (page, size) => paged(status?.peers ?? [], page, size),
  renderItem: (peer) => {
    const row = makeNode("div", "relay-row relay-row-compact");
    row.dataset.testid = "file-sync-peer-row";
    row.dataset.peer = peer.nodeId;
    const dot = makeNode("span", "relay-dot");
    dot.dataset.online = String(peer.present);
    const main = makeNode("div", "relay-row-main");
    const title = makeNode("div", "relay-row-title");
    const reach = makeBadge(peer.present ? "Reachable" : "Not reachable", peer.present ? "ok" : "error");
    reach.dataset.testid = "file-sync-peer-reachable";
    title.append(makeNode("strong", "relay-row-name", nodeName(peer.nodeId)), reach);
    const facts = makeNode("p", "relay-row-meta", peerFacts(peer));
    facts.dataset.testid = "file-sync-peer-facts";
    main.append(title, facts);
    row.append(dot, main);
    return row;
  },
});

// ---- projects ----

async function rescan(project, statusNode) {
  showStatus(statusNode, `Rescanning ${project.name}…`);
  try {
    await api(`/api/projects/${encodeURIComponent(project.projectId)}/sync/rescan`, { method: "POST" });
    showStatus(statusNode, `${project.name} was rescanned.`, "ok");
    await refresh();
  } catch (error) { showStatus(statusNode, error.message, "error"); }
}

function moveLabel(project) { return project.engine === "builtin" ? "Move back to Syncthing" : "Move to built-in sync"; }

const projectList = createFittedList({
  list: byId("fileSyncProjectList"), pager: byId("fileSyncProjectPager"), testPrefix: "file-sync-projects",
  emptyText: "No project is shared with another machine.",
  fetchPage: async (page, size) => paged(projects, page, size),
  renderItem: (project) => {
    const view = projectView(project);
    const row = makeNode("div", "relay-row");
    row.dataset.testid = "file-sync-project-row";
    row.dataset.projectId = project.projectId;
    const main = makeNode("div", "relay-row-main");
    const title = makeNode("div", "relay-row-title");
    const badge = makeBadge(view.label, view.kind);
    badge.dataset.testid = "file-sync-project-state";
    title.append(makeNode("strong", "relay-row-name", project.name), badge);
    main.append(title, makeNode("p", "relay-row-meta", factsOf(project, view).join(" · ")));
    const problem = problemText(project, view);
    if (problem) main.append(makeNode("p", "relay-error", problem));
    const actions = makeNode("div", "relay-row-actions");
    actions.append(
      makeButton("Rescan files", "file-sync-project-rescan", () => void rescan(project, projectsStatus)),
      makeButton("Details", "file-sync-project-details", () => openProject(project.projectId, false)),
    );
    if (project.owner) actions.append(makeButton(`${moveLabel(project)}…`, "file-sync-project-move", () => openProject(project.projectId, true)));
    row.append(main, actions);
    return row;
  },
});

// ---- one project's details ----

function openProject(projectId, withChecks) {
  openProjectId = projectId;
  if (checks?.projectId !== projectId) checks = null;
  errorShare = null;
  errorSignature = "";
  showStatus(detailStatus, "");
  byId("fileSyncOverview").hidden = true;
  byId("fileSyncProjectDetail").hidden = false;
  // Rendering loads the problem list, since its signature was just reset.
  renderProjectDetail();
  if (withChecks) void loadChecks(projectId);
  // integrate: a quiet page is not refreshed on a timer, so the counts shown are as old as the last load; opening asks once.
  void refresh().catch((error) => showStatus(detailStatus, `Could not refresh file sync: ${error.message}`, "error"));
}

function closeProject() {
  openProjectId = null;
  checks = null;
  byId("fileSyncProjectDetail").hidden = true;
  byId("fileSyncOverview").hidden = false;
  void projectList.reload();
}

function targetOf(project) { return project.engine === "builtin" ? "syncthing" : "builtin"; }

async function loadChecks(projectId) {
  const project = projects.find((candidate) => candidate.projectId === projectId);
  if (!project) return;
  const engine = targetOf(project);
  checks = { projectId, engine, loading: true };
  renderProjectDetail();
  try {
    // Each direction has its own checks: moving back needs only the owner and machines that answer.
    const body = await api(`/api/file-sync/engine/checks?projectId=${encodeURIComponent(projectId)}&engine=${engine}`);
    if (openProjectId !== projectId) return;
    checks = { projectId, engine: body.engine ?? engine, checks: body.checks ?? [], cleanSince: body.cleanSince ?? null };
  } catch (error) {
    if (openProjectId !== projectId) return;
    checks = null;
    showStatus(detailStatus, `Could not check this project: ${error.message}`, "error");
  }
  renderProjectDetail();
}

/** Checks loaded for the move the button would make now (the project may have moved since). */
function currentChecks(project) { return checks?.projectId === project.projectId && checks.engine === targetOf(project) ? checks : null; }

/** Only a blocking check holds the move back; how long the files have matched is shown, not required. */
function checksPass(held) { return Boolean(held?.checks) && held.checks.filter((check) => check.blocking !== false).every((check) => check.ok); }

function moveBlockedReason(project) {
  if (!project.owner) return "Only the machine that owns this project can move it.";
  if (targetOf(project) === "builtin" && project.phase !== "syncthing") return "Wait until the move back to Syncthing finishes.";
  const held = currentChecks(project);
  if (held?.loading) return "Checking…";
  if (!held?.checks) return "Check the project first.";
  if (!checksPass(held)) return "Every check must pass first.";
  return "";
}

async function move(project, engine) {
  showStatus(detailStatus, engine === "builtin" ? "Moving…" : "Moving back…");
  try {
    // Not api(): a refusal's body carries the checks that failed.
    const response = await fetch("/api/file-sync/engine", {
      method: "POST", cache: "no-store", headers: { "Content-Type": "application/json", ...(state.csrfToken ? { "X-CSRF-Token": state.csrfToken } : {}) },
      body: JSON.stringify({ projectId: project.projectId, engine }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (Array.isArray(body.checks)) {
        checks = { projectId: project.projectId, engine, checks: body.checks, cleanSince: body.cleanSince ?? checks?.cleanSince ?? null };
        renderProjectDetail();
      }
      showStatus(detailStatus, body.error || response.statusText || "The move was refused", "error");
      return;
    }
    checks = null;
    await refresh();
    showStatus(detailStatus, engine === "builtin"
      ? `${project.name} is moving to built-in sync. Each machine first makes Syncthing let go of its folders, then checks both machines' files. Nothing is deleted.`
      : `${project.name} is moving back to Syncthing.`, "ok");
  } catch (error) { showStatus(detailStatus, error.message, "error"); }
}

function checkRow(check) {
  const row = makeNode("li", "relay-check-row");
  row.dataset.testid = "file-sync-check-row";
  row.dataset.key = check.key;
  row.dataset.ok = String(Boolean(check.ok));
  const mark = makeNode("span", "relay-check-mark", check.ok ? "✓" : "✗");
  mark.setAttribute("aria-hidden", "true");
  const message = makeNode("span", check.ok ? "" : "relay-check-error", check.message);
  message.dataset.testid = "file-sync-check-message";
  row.append(mark, makeNode("span", "sr-only", check.ok ? "Passed: " : "Failed: "), message);
  return row;
}

/** fix (P4+P5): the checks that passed fold into one line (their messages in its tooltip), so the details fit the panel with the server's full list. */
function passedRow(passed, others) {
  const row = makeNode("li", "relay-check-row");
  row.dataset.testid = "file-sync-checks-passed";
  row.dataset.ok = "true";
  row.dataset.count = String(passed.length);
  row.title = passed.map((check) => check.message).join("\n");
  const mark = makeNode("span", "relay-check-mark", "✓");
  mark.setAttribute("aria-hidden", "true");
  const text = others ? `${plural(passed.length, "other check")} passed` : passed.length === 1 ? "The check passed" : `All ${passed.length} checks passed`;
  const label = makeNode("span", "", text);
  label.dataset.testid = "file-sync-checks-passed-text";
  row.append(mark, label, makeNode("span", "sr-only", `: ${passed.map((check) => check.message).join("; ")}`));
  return row;
}

async function confirmReplaced(share) {
  showStatus(detailStatus, "");
  try {
    await api("/api/file-sync/replaced/confirm", { method: "POST", body: JSON.stringify({ share: share.share }) });
    await refresh();
    showStatus(detailStatus, `${KIND_LABEL[share.kind] ?? "The folder"} will sync as it is now.`, "ok");
  } catch (error) { showStatus(detailStatus, error.message, "error"); }
}

function shareLine(share) {
  const line = makeNode("div", "file-sync-share");
  line.dataset.testid = "file-sync-share";
  line.dataset.share = share.share;
  const progress = share.state === "idle" ? (share.need.files > 0 ? `${plural(share.need.files, "file")} left to copy (${formatBytes(share.need.bytes)})` : "Up to date") : share.message ?? share.state;
  const watch = share.watch === "watching" ? "watching for changes" : share.watch === "degraded" ? "not watching for changes; files are checked when the project is used" : "";
  line.append(makeNode("strong", "", KIND_LABEL[share.kind] ?? share.kind), makeNode("span", "relay-row-meta", [`${plural(share.liveFiles, "file")}, ${formatBytes(share.liveBytes)}`, replacedShare(share) ? "" : progress, watch].filter(Boolean).join(" · ")));
  if (replacedShare(share)) {
    const ask = makeNode("p", "relay-error", "This folder holds far fewer files than before, so syncing it is paused. If it was replaced on purpose, confirm to sync it as it is now. Files missing from it are not deleted on other machines.");
    line.append(ask, makeTwoStepButton({ label: "Use this folder", armedLabel: "Click again to confirm", testid: "file-sync-replaced-confirm", className: "ghost compact", onConfirm: () => confirmReplaced(share) }));
  }
  return line;
}

function renderProjectDetail() {
  const project = projects.find((candidate) => candidate.projectId === openProjectId);
  if (!project) { closeProject(); return; }
  const view = projectView(project);
  byId("fileSyncDetailName").textContent = project.name;
  const badge = byId("fileSyncDetailState");
  badge.textContent = view.label;
  badge.className = `cluster-badge ${view.kind}`.trim();

  const facts = [makeNode("p", "relay-row-meta", factsOf(project, view).join(" · "))];
  if (view.moving && project.phaseMessage) facts.push(makeNode("p", "relay-row-meta", project.phaseMessage));
  if (project.phaseError) facts.push(makeNode("p", "relay-error", project.phaseError));
  for (const peer of peersBehind(project)) if (peer.error) facts.push(makeNode("p", "relay-error", `${peer.name}: ${peer.error}`));
  facts.push(...view.shares.map(shareLine));
  byId("fileSyncDetailFacts").replaceChildren(...facts);

  const target = targetOf(project);
  const held = currentChecks(project);
  const reason = moveBlockedReason(project);
  const moveButton = makeTwoStepButton({
    label: moveLabel(project), armedLabel: target === "builtin" ? "Click again to move" : "Click again to move back",
    testid: "file-sync-move-button", className: "primary compact", onConfirm: () => move(project, target),
  });
  moveButton.disabled = Boolean(reason);
  byId("fileSyncDetailActions").replaceChildren(
    makeButton("Rescan files", "file-sync-detail-rescan", () => void rescan(project, detailStatus)),
    makeButton(held?.checks ? "Check again" : "Check this project", "file-sync-detail-check", () => void loadChecks(project.projectId)),
    moveButton,
  );
  const reasonNode = byId("fileSyncMoveReason");
  reasonNode.textContent = reason;
  reasonNode.hidden = !reason;

  // Failing checks first, each with its reason; the ones that passed in one line.
  const failed = (held?.checks ?? []).filter((check) => !check.ok);
  const passed = (held?.checks ?? []).filter((check) => check.ok);
  byId("fileSyncChecks").replaceChildren(...failed.map(checkRow), ...(passed.length ? [passedRow(passed, failed.length > 0)] : []));
  const clean = byId("fileSyncCleanSince");
  clean.hidden = !held?.checks || target !== "builtin";
  const elapsed = since(held?.cleanSince);
  clean.textContent = elapsed === null ? "The files do not match on every machine yet."
    : `The files have matched on every machine for ${duration(elapsed)}. A week without differences is a good sign, but it is not required.`;

  const troubled = view.shares.filter((share) => share.errors + share.blocked > 0);
  if (!troubled.some((share) => share.share === errorShare)) errorShare = troubled[0]?.share ?? null;
  const chooser = byId("fileSyncErrorShares");
  chooser.replaceChildren(...troubled.map((share) => {
    const button = makeButton(`${KIND_LABEL[share.kind] ?? share.kind} (${share.errors + share.blocked})`, "file-sync-error-share", () => { errorShare = share.share; renderProjectDetail(); void reloadErrors(); }, "settings-subtab");
    button.setAttribute("aria-pressed", String(share.share === errorShare));
    return button;
  }));
  chooser.hidden = troubled.length < 2;
  byId("fileSyncErrorsHeading").hidden = !troubled.length;
  byId("fileSyncErrorList").hidden = !troubled.length;
  // The problem list asks the engine; it reloads when the counts it shows have changed, not on every refresh.
  const signature = `${errorShare}:${troubled.map((share) => `${share.share}=${share.errors + share.blocked}`).join(",")}`;
  if (signature !== errorSignature) { errorSignature = signature; void reloadErrors(); }
}

const errorList = createFittedList({
  list: byId("fileSyncErrorList"), pager: byId("fileSyncErrorPager"), testPrefix: "file-sync-errors",
  emptyText: "No files with problems.",
  fetchPage: async (page, size) => errorShare
    ? api(`/api/file-sync/errors?share=${encodeURIComponent(errorShare)}&page=${page}&pageSize=${size}`)
    : { total: 0, items: [] },
  renderItem: (item) => {
    const row = makeNode("div", "relay-row relay-row-compact");
    row.dataset.testid = "file-sync-error-row";
    const main = makeNode("div", "relay-row-main");
    const title = makeNode("div", "relay-row-title");
    title.append(makeBadge(ERROR_LABEL[item.kind] ?? item.kind, item.kind === "notice" ? "" : "error"), makeNode("span", "file-sync-path", item.path), makeNode("span", "relay-row-meta", `${item.reason} · ${formatWhen(item.at)}`));
    main.append(title);
    row.append(main);
    return row;
  },
});

async function reloadErrors() {
  try { await errorList.first(); } catch (error) { showStatus(detailStatus, `Could not load the files with problems: ${error.message}`, "error"); }
}

// ---- differences ----

/** One row per project and machine: the counts of its folders added up; it matches since the latest of their clean times. */
function differenceRows() {
  const rows = new Map();
  for (const share of status?.shares ?? []) {
    for (const peer of share.peers ?? []) {
      const key = `${share.projectId}\n${peer.peer}`;
      const row = rows.get(key) ?? { projectId: share.projectId, peer: peer.peer, differences: 0, cleanSince: undefined, shares: [] };
      row.differences += peer.differences;
      row.cleanSince = row.cleanSince === null || !peer.cleanSince ? null : !row.cleanSince || peer.cleanSince > row.cleanSince ? peer.cleanSince : row.cleanSince;
      row.shares.push({ share: share.share, kind: share.kind, differences: peer.differences });
      rows.set(key, row);
    }
  }
  const name = (projectId) => projects.find((project) => project.projectId === projectId)?.name ?? state.projects?.find((project) => project.id === projectId)?.name ?? projectId;
  return [...rows.values()].map((row) => ({ ...row, name: name(row.projectId) })).sort((a, b) => a.name.localeCompare(b.name) || nodeName(a.peer).localeCompare(nodeName(b.peer)));
}

function renderDiffCount() {
  const total = (status?.shares ?? []).reduce((sum, share) => sum + (share.peers ?? []).reduce((count, peer) => count + peer.differences, 0), 0);
  byId("fileSyncDifferencesCount").textContent = total ? String(total) : "";
}

const diffList = createFittedList({
  list: byId("fileSyncDiffList"), pager: byId("fileSyncDiffPager"), testPrefix: "file-sync-diffs",
  emptyText: "Nothing to compare yet. Turn on built-in file sync and share a project with another machine.",
  fetchPage: async (page, size) => paged(differenceRows(), page, size),
  renderItem: (item) => {
    const row = makeNode("div", "relay-row relay-row-compact");
    row.dataset.testid = "file-sync-diff-row";
    row.dataset.projectId = item.projectId;
    row.dataset.peer = item.peer;
    const main = makeNode("div", "relay-row-main");
    const title = makeNode("div", "relay-row-title");
    const count = makeBadge(item.differences ? plural(item.differences, "difference") : "Same files", item.differences ? "error" : "ok");
    count.dataset.testid = "file-sync-diff-count";
    title.append(makeNode("strong", "relay-row-name", `${item.name} with ${nodeName(item.peer)}`), count);
    main.append(title, makeNode("p", "relay-row-meta", matchingText(item.cleanSince)));
    const actions = makeNode("div", "relay-row-actions");
    actions.append(makeButton("Show files", "file-sync-diff-open", () => openDifferences(item)));
    row.append(main, actions);
    return row;
  },
});

function openDifferences(item) {
  const first = item.shares.find((share) => share.differences > 0) ?? item.shares[0];
  openDiff = { projectId: item.projectId, peer: item.peer, share: first?.share ?? null };
  showStatus(diffStatus, "");
  byId("fileSyncDiffOverview").hidden = true;
  byId("fileSyncDiffDetail").hidden = false;
  renderDiffDetail();
  void reloadDiffItems();
}

function closeDifferences() {
  openDiff = null;
  byId("fileSyncDiffDetail").hidden = true;
  byId("fileSyncDiffOverview").hidden = false;
  void diffList.reload();
}

function renderDiffDetail() {
  const item = differenceRows().find((row) => row.projectId === openDiff.projectId && row.peer === openDiff.peer);
  if (!item) { closeDifferences(); return; }
  byId("fileSyncDiffName").textContent = `${item.name} with ${nodeName(item.peer)}`;
  byId("fileSyncDiffMatching").textContent = matchingText(item.cleanSince);
  const chooser = byId("fileSyncDiffShares");
  chooser.replaceChildren(...item.shares.map((share) => {
    const button = makeButton(`${KIND_LABEL[share.kind] ?? share.kind} (${share.differences})`, "file-sync-diff-share", () => { openDiff.share = share.share; renderDiffDetail(); void reloadDiffItems(); }, "settings-subtab");
    button.setAttribute("aria-pressed", String(share.share === openDiff.share));
    return button;
  }));
  chooser.hidden = item.shares.length < 2;
  const repair = makeButton("Repair", "file-sync-diff-repair", () => void repairDifferences(item));
  repair.title = `Reloads ${nodeName(item.peer)}'s list of these files from the start. Files are not changed.`;
  byId("fileSyncDiffActions").replaceChildren(repair);
}

async function repairDifferences(item) {
  const share = openDiff?.share;
  if (!share) return;
  showStatus(diffStatus, `Reloading ${nodeName(item.peer)}'s list of files…`);
  try {
    await api("/api/file-sync/repair", { method: "POST", body: JSON.stringify({ share, peer: item.peer }) });
    showStatus(diffStatus, `${nodeName(item.peer)}'s list of files was reloaded.`, "ok");
    await refresh();
    await reloadDiffItems();
  } catch (error) { showStatus(diffStatus, error.message, "error"); }
}

function differenceText(item) {
  const label = item.kind === "only-there" ? `Only on ${nodeName(openDiff?.peer)}` : DIFFERENCE_LABEL[item.kind] ?? item.kind;
  const sizes = [item.local && !item.local.deleted ? `here ${formatBytes(item.local.size)}` : "", item.remote && !item.remote.deleted ? `there ${formatBytes(item.remote.size)}` : ""].filter(Boolean).join(", ");
  return [label, sizes, `since ${formatWhen(item.since)}`].filter(Boolean).join(" · ");
}

const diffItems = createFittedList({
  list: byId("fileSyncDiffItems"), pager: byId("fileSyncDiffItemsPager"), testPrefix: "file-sync-diff-items",
  emptyText: "No files differ.",
  fetchPage: async (page, size) => openDiff?.share
    ? api(`/api/file-sync/differences?share=${encodeURIComponent(openDiff.share)}&peer=${encodeURIComponent(openDiff.peer)}&page=${page}&pageSize=${size}`)
    : { total: 0, items: [] },
  renderItem: (item) => {
    const row = makeNode("div", "relay-row relay-row-compact");
    row.dataset.testid = "file-sync-diff-item";
    const main = makeNode("div", "relay-row-main");
    const title = makeNode("div", "relay-row-title");
    const path = makeNode("span", "file-sync-path", item.path);
    path.dataset.testid = "file-sync-diff-path";
    title.append(path, makeNode("span", "relay-row-meta", differenceText(item)));
    main.append(title);
    row.append(main);
    return row;
  },
});

async function reloadDiffItems() {
  try { await diffItems.first(); } catch (error) { showStatus(diffStatus, `Could not load the differing files: ${error.message}`, "error"); }
}

// ---- tabs and events ----

function showTab(name) {
  activeTab = name;
  for (const tab of tabs.querySelectorAll("[data-file-sync-tab]")) tab.setAttribute("aria-selected", String(tab.dataset.fileSyncTab === name));
  byId("fileSyncStatusSection").hidden = name !== "status";
  byId("fileSyncDifferencesSection").hidden = name !== "differences";
  if (name === "differences" && status) {
    void diffList.reload();
    if (openDiff) { renderDiffDetail(); void reloadDiffItems(); }
  }
}

tabs.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-file-sync-tab]");
  if (tab) showTab(tab.dataset.fileSyncTab);
});
enabledToggle.addEventListener("change", () => void saveEnabled(enabledToggle.checked));
byId("fileSyncRetry").addEventListener("click", () => void saveEnabled(true));
byId("fileSyncRefresh").addEventListener("click", () => void loadFileSyncSettings());
byId("fileSyncDetailBack").addEventListener("click", closeProject);
byId("fileSyncDiffBack").addEventListener("click", closeDifferences);
byId("settingsDialog").addEventListener("close", () => clearTimeout(refreshTimer));
