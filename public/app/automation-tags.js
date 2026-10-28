import { api } from "./api.js";
import { createFittedList, makeButton, makeNode, showStatus } from "./relay-ui.js";
import { selectProject } from "./project-selection.js";
import { openSession } from "./socket.js";

const byId = id => document.getElementById(id);
const workspaceSelect = byId("automationTagsWorkspace");
const status = byId("automationTagsStatus");
const tagFilter = byId("automationExecutionsTag");
const kindFilter = byId("automationExecutionsKind");
const sourceFilter = byId("automationExecutionsSource");
const statusFilter = byId("automationExecutionsStatus");
const list = byId("automationExecutionsList");
const pager = byId("automationExecutionsPager");
let workspaces = [];
let fitted;
let catalogFitted;
let catalogTags = [];
let sources = [];

function endpoint(suffix) { return `/api/workspaces/${encodeURIComponent(workspaceSelect.value)}${suffix}`; }
function localDate(value, end = false) {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  if (end) date.setDate(date.getDate() + 1);
  return date.toISOString();
}

function renderTag(tag) {
  const row = makeNode("div", "relay-row"); row.dataset.testid = "automation-tag-row";
  const input = document.createElement("input"); input.value = tag.name; input.maxLength = 80; input.dataset.testid = "automation-tag-name"; input.setAttribute("aria-label", `Tag name ${tag.name}`);
  const save = makeButton("Rename", "automation-tag-rename", async () => {
    try { await api(endpoint(`/automation-tags/${encodeURIComponent(tag.id)}`), { method: "PATCH", body: JSON.stringify({ name: input.value }) }); await loadCatalog(); showStatus(status, "Tag renamed."); }
    catch (error) { showStatus(status, error.message, "error"); }
  });
  const retire = makeButton("Retire", "automation-tag-retire", async () => {
    try { await api(endpoint(`/automation-tags/${encodeURIComponent(tag.id)}`), { method: "DELETE" }); await loadCatalog(); showStatus(status, "Tag retired. Past executions keep their tag."); }
    catch (error) { showStatus(status, error.message, "error"); }
  });
  row.append(input, save, retire); return row;
}

async function loadCatalog() {
  if (!workspaceSelect.value) return;
  const { tags } = await api(endpoint("/automation-tags"));
  catalogTags = tags;
  const active = tags.filter(tag => !tag.retired);
  const selected = tagFilter.value;
  tagFilter.replaceChildren(new Option("All tags", ""), ...active.map(tag => new Option(tag.name, tag.normalizedName)));
  if (selected && [...tagFilter.options].some(option => option.value === selected)) tagFilter.value = selected;
  const container = byId("automationTagsList");
  if (!catalogFitted) catalogFitted = createFittedList({ list: container, pager: byId("automationTagsPager"), testPrefix: "automation-tags", fetchPage: async (page, size) => ({ items: catalogTags.slice((page - 1) * size, page * size), total: catalogTags.length }), renderItem: renderTag, emptyText: "No managed tags in this workspace." });
  else await catalogFitted.reload();
}

async function fetchExecutions(page, pageSize) {
  const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (tagFilter.value) query.set("tag", tagFilter.value);
  if (kindFilter.value) query.set("sourceKind", kindFilter.value);
  if (sourceFilter.value) query.set("sourceId", sourceFilter.value);
  if (statusFilter.value) query.set("status", statusFilter.value);
  const from = localDate(byId("automationExecutionsFrom").value), to = localDate(byId("automationExecutionsTo").value, true);
  if (from) query.set("from", from);
  if (to) query.set("to", to);
  query.set("timeZone", Intl.DateTimeFormat().resolvedOptions().timeZone);
  const report = await api(`${endpoint("/automation-executions")}?${query}`);
  const stats = report.statistics;
  byId("automationExecutionsSummary").textContent = `Executions ${stats.executions} · conversations ${stats.conversations} · succeeded ${stats.succeeded} · failed ${stats.failed} · queued ${stats.queued} · running ${stats.running} · success rate ${stats.successRate === null ? "n/a" : `${Math.round(stats.successRate * 100)}%`} · average duration ${stats.averageDurationMs === null ? "n/a" : `${Math.round(stats.averageDurationMs / 1000)} s`} · tokens ${stats.tokens} · cost $${stats.costUsd.toFixed(4)} (${stats.pricedExecutions} priced, ${stats.missingUsage} missing)`;
  byId("automationExecutionsTrend").replaceChildren(...report.trend.map(item => makeNode("p", "settings-hint", `${item.day}: ${item.count} executions`)));
  const previousTag = tagFilter.value;
  const tagOptions = new Map(report.tags.map(tag => [tag.key, tag.name]));
  for (const tag of await api(endpoint("/automation-tags")).then(body => body.tags)) if (!tag.retired) tagOptions.set(tag.normalizedName, tag.name);
  tagFilter.replaceChildren(new Option("All tags", ""), ...[...tagOptions].sort((a,b) => a[1].localeCompare(b[1])).map(([key,name]) => new Option(name, key)));
  tagFilter.value = previousTag;
  sources = report.sources;
  const previousSource = sourceFilter.value;
  sourceFilter.replaceChildren(new Option("All automations", ""), ...sources.map(source => new Option(`${source.kind === "scheduled" ? "Scheduled" : "Webhook"}: ${source.name}`, source.id)));
  if (sources.some(source => source.id === previousSource)) sourceFilter.value = previousSource;
  return { items: report.rows, total: report.total };
}

function renderExecution(item) {
  const row = makeNode("div", "relay-row"); row.dataset.testid = "automation-execution-row";
  const details = makeNode("span", "", `${item.sourceKind === "scheduled" ? "Scheduled task" : "Webhook"} · ${item.sourceName} · ${item.status} · ${new Date(item.acceptedAt).toLocaleString()} · ${item.tags.map(tag => tag.name).join(", ") || "No tags"}${item.error ? ` · ${item.error}` : ""}`);
  row.append(details);
  if (item.sessionId) {
    const open = makeButton("Open conversation", "automation-execution-open", async () => {
      try {
        await selectProject(item.projectId);
        const sessions = await api(`/api/projects/${encodeURIComponent(item.projectId)}/sessions`);
        const session = sessions.sessions.find(candidate => candidate.id === item.sessionId);
        if (!session) throw new Error("Conversation is not available on this node");
        openSession(session.path, session.title || item.sourceName);
      } catch (error) { showStatus(status, error.message, "error"); }
    });
    row.append(open);
  } else row.append(makeNode("span", "settings-hint", "Conversation not assigned"));
  return row;
}

export async function loadAutomationTags() {
  showStatus(status, "Loading workspace tags…");
  try {
    workspaces = (await api("/api/workspaces")).workspaces;
    workspaceSelect.replaceChildren(...workspaces.map(workspace => new Option(workspace.label, workspace.id)));
    if (!workspaceSelect.value && workspaces.length) workspaceSelect.value = workspaces[0].id;
    await loadCatalog();
    if (!fitted) fitted = createFittedList({ list, pager, testPrefix: "automation-executions", fetchPage: fetchExecutions, renderItem: renderExecution, emptyText: "No executions match these filters." });
    else await fitted.first();
    showStatus(status, "");
  } catch (error) { showStatus(status, error.message, "error"); }
}

byId("automationTagsAdd").addEventListener("click", async () => {
  try {
    await api(endpoint("/automation-tags"), { method: "POST", body: JSON.stringify({ name: byId("automationTagsNewName").value }) });
    byId("automationTagsNewName").value = ""; await loadAutomationTags(); showStatus(status, "Managed tag added.");
  } catch (error) { showStatus(status, error.message, "error"); }
});
workspaceSelect.addEventListener("change", () => void loadAutomationTags());
for (const filter of [tagFilter, kindFilter, sourceFilter, statusFilter, byId("automationExecutionsFrom"), byId("automationExecutionsTo")]) filter.addEventListener("change", () => fitted?.first());
