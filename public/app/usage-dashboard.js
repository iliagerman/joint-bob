import { api } from "./api.js";
import { state } from "./state.js";
import { confirmAction, toast } from "./shell.js";
import { createMultiSelect } from "./multi-select.js";
import { formatPlanPrice, formatUsageCost } from "./usage-format.js";
import { renderModelSplit, renderUsageTrend } from "./usage-charts.js";

const dialog = document.querySelector("#usageDialog");
const filters = document.querySelector("#usageFilters");
const status = document.querySelector("#usageStatus");
const notice = document.querySelector("#usageNotice");
const summary = document.querySelector("#usageSummary");
const breakdowns = document.querySelector("#usageBreakdowns");
const dimensionNav = document.querySelector("#usageDimensions");
const trend = document.querySelector("#usageTrend");
const clusterField = document.querySelector("#usageClusterField");
const clearFilters = document.querySelector("#usageClearFilters");
const subscriptionList = document.querySelector("#subscriptionList");
const planStatus = document.querySelector("#subscriptionPlanStatus");
const editor = document.querySelector("#subscriptionEditor");
const planForm = document.querySelector("#subscriptionForm");
const quotaRows = document.querySelector("#quotaRows");
const refreshButton = document.querySelector("#usageRefresh");
const pagination = document.querySelector("#usageConversationPagination");

const DIMENSIONS = [
  { key: "projects", label: "Projects", column: "Project", filter: (key) => ({ projectId: key }) },
  { key: "conversations", label: "Conversations", column: "Conversation", filter: (key) => ({ conversationId: key }) },
  { key: "classifications", label: "Labels", column: "Label", filter: (key) => ({ classification: key }) },
  { key: "difficulties", label: "Difficulty", column: "Difficulty", filter: (key) => ({ difficulty: key }) },
  { key: "models", label: "Models", column: "Model" },
  { key: "days", label: "Days", column: "Day", filter: (key) => ({ from: key, to: key }) },
];
const COLUMNS = [
  { key: "cost", label: "Cost", value: (totals) => totals.apiCostUsd ?? -1 },
  { key: "share", label: "Share" },
  { key: "tokens", label: "Tokens", value: (totals) => totals.totalTokens },
  { key: "cache", label: "Cache", value: (totals) => cacheShare(totals) ?? -1 },
  { key: "requests", label: "Requests", value: (totals) => totals.requests },
  { key: "tools", label: "Tools", value: (totals) => totals.toolCalls },
  { key: "errors", label: "Errors", value: (totals) => totals.toolErrors },
];

let requestGeneration = 0;
let page = 1;
let pollTimer = null;
let hasSnapshot = false;
let snapshotScope = "";
let detections = [];
let detectionError = "";
let inventory = { projects: [], conversations: [], classifications: [] };
let plans = [];
let harnesses = [];
let latest = null;
let dimension = "projects";
const sorts = new Map();
let expanded = "";
const splits = new Map();
let clusterValues = new Set();

const clusterFilter = createMultiSelect({ id: "usageClusterFilter", testid: "usage-cluster-filter", label: "Clusters", prompt: "All clusters", placeholder: "Search clusters" });
clusterField.append(clusterFilter.root);

export function localDateTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function compactCount(value) {
  const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e4, "K"]];
  for (const [size, suffix] of units) if (value >= size) return `${(value / size).toFixed(size === 1e4 ? 1 : 2).replace(/\.?0+$/, "")}${suffix}`;
  return value.toLocaleString();
}
function cacheShare(totals) {
  const denominator = totals.input + totals.cacheRead + totals.cacheWrite5m + totals.cacheWrite1h + totals.cacheWriteUnknown;
  return denominator ? totals.cacheRead / denominator : null;
}
const percent = (value) => value === null ? "—" : `${(value * 100).toFixed(value > 0 && value < 0.01 ? 2 : 1)}%`;
function partialMark(totals) {
  const mark = element("span", undefined, "usage-partial");
  mark.setAttribute("role", "img");
  mark.setAttribute("aria-label", "partial");
  mark.title = `Partial: ${totals.requests - totals.pricedRequests} of ${totals.requests} requests unpriced; this is a lower bound`;
  return mark;
}
function costNode(tag, totals) {
  const node = element(tag, formatUsageCost({ ...totals, partial: false }));
  if (totals.partial) node.append(partialMark(totals));
  return node;
}
function countNode(tag, value) {
  const node = element(tag, compactCount(value));
  node.title = value.toLocaleString();
  return node;
}

function setOptions(select, options, firstLabel) {
  const selected = select.value;
  select.replaceChildren(new Option(firstLabel, ""));
  for (const option of options) select.add(new Option(option.label, option.value));
  if (selected && !options.some((option) => option.value === selected)) {
    select.add(new Option(selected, selected));
  }
  select.value = selected;
}

function harnessId(harness) {
  return harness.id || harness.harnessId || harness.engine || harness.key;
}

function harnessLabel(harness) {
  return harness.label || harness.name || harnessId(harness);
}

function updateHarnessOptions(selected = "") {
  const select = planForm.elements.harnessId;
  select.replaceChildren(new Option("Choose a harness", ""));
  for (const harness of harnesses) {
    select.add(new Option(harnessLabel(harness), harnessId(harness)));
  }
  if (selected && ![...select.options].some((option) => option.value === selected)) {
    select.add(new Option(`${selected} (stored harness)`, selected));
  }
  select.value = selected;
}
async function loadHarnesses() {
  if (state.harnesses?.length) {
    harnesses = state.harnesses;
  } else {
    const data = await api("/api/harnesses");
    harnesses = data.harnesses || [];
  }
  updateHarnessOptions(planForm.elements.harnessId.value);
  renderPlans();
}
function updateInventory(data) {
  const merge = (current, incoming, key) => [
    ...new Map([...current, ...incoming].map((item) => [item[key], item])).values(),
  ];
  inventory.projects = merge(inventory.projects, data.projects, "id");
  inventory.conversations = data.conversations;
  inventory.classifications = [...new Set([
    ...inventory.classifications,
    ...data.breakdowns.classifications.map((item) => item.key).filter(Boolean),
  ])].sort();
  setOptions(filters.elements.projectId, inventory.projects.map((project) => ({
    value: project.id, label: project.name,
  })), "All projects");
  setOptions(filters.elements.conversationId, inventory.conversations.map((conversation) => ({
    value: conversation.conversationId,
    label: conversation.title || conversation.conversationId,
  })), "All conversations");
  setOptions(filters.elements.classification, inventory.classifications.map((label) => ({
    value: label, label,
  })), "All labels");
}

/** "This node" is usage recorded here; a cluster is usage its other members recorded. */
function syncClusterOptions() {
  const clusters = [...(state.clusters || [])].sort((left, right) => left.name.localeCompare(right.name));
  const others = (cluster) => cluster.members.filter((member) => member.nodeId !== state.localNodeId).map((member) => member.name || member.nodeId);
  clusterFilter.setOptions([
    { value: "local", label: "This node", detail: "Usage recorded on this node" },
    ...clusters.map((cluster) => ({ value: cluster.id, label: cluster.name, detail: `Usage from ${others(cluster).join(", ") || "no other nodes yet"}` })),
  ]);
  const kept = new Set([...clusterValues].filter((value) => value === "local" || clusters.some((cluster) => cluster.id === value)));
  if (kept.size !== clusterValues.size) { clusterValues = kept; clusterFilter.setValues(kept); }
  clusterField.hidden = !clusters.length && !clusterValues.size;
}

function stat(label, value, detail) {
  const item = element("div", undefined, "usage-stat");
  item.append(element("span", label), value, element("small", detail));
  return item;
}
function renderSummary(totals) {
  const unpriced = Math.max(0, totals.requests - totals.pricedRequests);
  summary.replaceChildren(
    stat("API-equivalent cost", costNode("strong", totals), `${totals.pricedRequests.toLocaleString()} of ${totals.requests.toLocaleString()} requests priced`),
    stat("Tokens", countNode("strong", totals.totalTokens), `in ${compactCount(totals.input)} / out ${compactCount(totals.output)}`),
    stat("Cache read", element("strong", cacheShare(totals) === null ? "Unavailable" : percent(cacheShare(totals))), "of input tokens"),
    stat("Requests", element("strong", totals.requests.toLocaleString()), `${unpriced.toLocaleString()} unpriced`),
    stat("Tool calls", element("strong", totals.toolCalls.toLocaleString()), `${totals.toolErrors.toLocaleString()} errors`),
    stat("Reasoning", countNode("strong", totals.reasoning), "tokens"),
  );
}

function dimensionCount(data, key) {
  return key === "conversations" ? data.conversationPagination.total : data.breakdowns[key].length;
}
function renderDimensions(data) {
  dimensionNav.replaceChildren(...DIMENSIONS.map((item) => {
    const button = element("button", undefined, "usage-dimension");
    button.type = "button";
    button.dataset.dimension = item.key;
    button.dataset.testid = `usage-dimension-${item.key}`;
    button.setAttribute("aria-pressed", String(item.key === dimension));
    button.append(element("span", item.label), element("small", dimensionCount(data, item.key).toLocaleString()));
    return button;
  }));
}

const HARNESS_PREFIXES = [[/^\[Claude\]\s*/, "Claude", "claude"], [/^\[F\]\s*/, "Fork", "fork"]];
function rowName(data, key) {
  if (dimension === "projects") return { text: data.names.projects.get(key) || key };
  if (dimension === "conversations") {
    const conversation = data.names.conversations.get(key);
    const title = conversation?.title || key;
    const project = conversation ? data.names.projects.get(conversation.projectId) : undefined;
    for (const [pattern, label, kind] of HARNESS_PREFIXES) {
      if (pattern.test(title)) return { text: title.replace(pattern, ""), full: title, badge: label, kind, detail: project };
    }
    return { text: title, detail: project };
  }
  if (dimension === "classifications") return { text: key || "Unclassified" };
  if (dimension === "difficulties") return { text: key === "not-classified" || !key ? "Not classified" : `Level ${key}` };
  if (dimension === "models") return { text: key || "Unknown model", mono: true };
  return { text: key };
}
function nameOrder(left, right) {
  if (dimension === "difficulties") {
    const level = (key) => key === "not-classified" ? 11 : Number(key);
    return level(left.key) - level(right.key);
  }
  return String(left.label).localeCompare(String(right.label));
}
function currentSort() {
  return sorts.get(dimension) || (dimension === "days" ? { key: "name", direction: -1 } : { key: "cost", direction: -1 });
}
function sortedRows(rows) {
  // Conversations arrive one server page at a time, already ordered by cost.
  if (dimension === "conversations") return rows;
  const { key, direction } = currentSort();
  const column = COLUMNS.find((item) => item.key === key);
  return [...rows].sort((left, right) => {
    const order = column ? column.value(left.totals) - column.value(right.totals) : nameOrder(left, right);
    return order * direction || String(left.key).localeCompare(String(right.key));
  });
}
function sortDescription() {
  const { key, direction } = currentSort();
  const column = COLUMNS.find((item) => item.key === key);
  const descending = direction < 0;
  if (column) return `Sorted by ${column.label.toLowerCase()}, ${descending ? "highest" : "lowest"} first`;
  if (dimension === "days") return `Sorted by day, ${descending ? "newest" : "oldest"} first`;
  if (dimension === "difficulties") return `Sorted by difficulty, ${descending ? "hardest" : "easiest"} first`;
  return `Sorted by name, ${descending ? "Z to A" : "A to Z"}`;
}
function headerCell(label, key) {
  const header = element("th");
  header.scope = "col";
  if (dimension === "conversations" || !key) { header.textContent = label; return header; }
  const sort = currentSort();
  const button = element("button", label, "usage-sort");
  button.type = "button";
  button.dataset.sort = key;
  if (sort.key === key) header.setAttribute("aria-sort", sort.direction < 0 ? "descending" : "ascending");
  header.append(button);
  return header;
}
function nameCell(name, item, expandable) {
  const cell = element("td", undefined, "usage-name-cell");
  cell.title = name.full || name.text;
  const target = expandable ? element("button", undefined, "usage-expand") : element("div", undefined, "usage-expand static");
  if (expandable) {
    target.type = "button";
    target.dataset.expand = item.key;
    target.setAttribute("aria-expanded", String(expanded === item.key));
  }
  if (name.badge) target.append(element("span", name.badge, `usage-harness ${name.kind}`));
  target.append(element("span", name.text, `usage-name${name.mono ? " mono" : ""}`));
  cell.append(target);
  if (name.detail) cell.append(element("small", name.detail, "usage-name-detail"));
  return cell;
}
function shareCell(item, max, total) {
  const cell = element("td", undefined, "usage-share-cell");
  cell.dataset.label = "Share";
  const cost = item.totals.apiCostUsd;
  const track = element("i", undefined, "usage-share-track");
  const fill = element("b");
  fill.style.width = `${cost && max ? cost / max * 100 : 0}%`;
  track.append(fill);
  cell.append(track, element("span", cost !== null && total ? percent(cost / total) : "—"));
  return cell;
}
function detailRow(item) {
  const row = element("tr", undefined, "usage-detail-row");
  const cell = element("td");
  cell.colSpan = COLUMNS.length + 1;
  const split = splits.get(`${dimension}:${item.key}`);
  if (!split) cell.append(element("p", "Loading model split…", "usage-split-empty"));
  else if (split.error) cell.append(element("p", `Model split unavailable: ${split.error}`, "usage-split-empty"));
  else cell.append(element("p", "Cost by model", "usage-split-title"), renderModelSplit(split.rows));
  row.append(cell);
  return row;
}
function renderTable(data) {
  const config = DIMENSIONS.find((item) => item.key === dimension);
  const rows = data.breakdowns[dimension].map((item) => ({ ...item, label: rowName(data, item.key).text }));
  const section = element("section", undefined, "usage-breakdown");
  section.dataset.dimension = dimension;
  if (dimension === "conversations") section.dataset.testid = "usage-conversations-table";
  const table = element("table");
  table.append(element("caption", `${config.label} by API-equivalent cost`, "sr-only"));
  const head = element("tr");
  head.append(headerCell(config.column, "name"), ...COLUMNS.map((column) => headerCell(column.label, column.value ? column.key : "")));
  const thead = element("thead");
  thead.append(head);
  const body = element("tbody");
  const max = Math.max(0, ...rows.map((item) => item.totals.apiCostUsd ?? 0));
  const total = data.summary.apiCostUsd;
  for (const item of sortedRows(rows)) {
    const row = element("tr");
    const isExpanded = expanded === item.key;
    if (isExpanded) row.className = "expanded";
    row.append(nameCell(rowName(data, item.key), item, Boolean(config.filter)));
    const cost = costNode("td", item.totals);
    cost.className = "usage-cost-cell";
    cost.dataset.label = "Cost";
    row.append(cost, shareCell(item, max, total));
    for (const [label, node] of [
      ["Tokens", countNode("td", item.totals.totalTokens)],
      ["Cache", element("td", percent(cacheShare(item.totals)))],
      ["Requests", element("td", item.totals.requests.toLocaleString())],
      ["Tools", element("td", item.totals.toolCalls.toLocaleString())],
      ["Errors", element("td", item.totals.toolErrors.toLocaleString())],
    ]) { node.dataset.label = label; row.append(node); }
    body.append(row);
    if (isExpanded) body.append(detailRow(item));
  }
  if (!rows.length) {
    const cell = element("td", "No usage in this scope.", "usage-empty"); cell.colSpan = COLUMNS.length + 1;
    const row = element("tr"); row.append(cell); body.append(row);
  }
  table.append(thead, body);
  section.append(table);
  const shown = dimension === "conversations" ? data.conversationPagination.total : rows.length;
  const footer = element("footer", undefined, "usage-breakdown-foot");
  footer.append(element("span", `${shown.toLocaleString()} ${config.label.toLowerCase()}`));
  if (dimension === "conversations") footer.append(pagination);
  else footer.append(element("span", sortDescription()));
  pagination.hidden = dimension !== "conversations";
  section.append(footer);
  breakdowns.replaceChildren(section);
}
function renderBreakdowns() {
  if (!latest) return;
  renderDimensions(latest);
  renderTable(latest);
}

async function loadSplit(key) {
  const config = DIMENSIONS.find((item) => item.key === dimension);
  const cacheKey = `${dimension}:${key}`;
  if (splits.has(cacheKey) || !config.filter) return;
  const parameters = new URLSearchParams(queryString());
  for (const [name, value] of Object.entries(config.filter(key))) parameters.set(name, value);
  parameters.set("refresh", "false"); parameters.set("pageSize", "1");
  const scope = snapshotScope;
  try {
    const data = await api(`/api/usage?${parameters}`, { signal: AbortSignal.timeout(20000) });
    if (scope === snapshotScope) splits.set(cacheKey, { rows: data.breakdowns.models });
  } catch (error) {
    if (scope === snapshotScope) splits.set(cacheKey, { error: error.message });
  }
  if (scope === snapshotScope) renderBreakdowns();
}

function renderUsage(data) {
  hasSnapshot = true;
  updateInventory(data);
  latest = {
    ...data,
    names: {
      projects: new Map(data.projects.map((item) => [item.id, item.name])),
      conversations: new Map(data.conversations.map((item) => [item.conversationId, item])),
    },
  };
  renderSummary(data.summary);
  renderUsageTrend(trend, data.breakdowns.days);
  renderBreakdowns();
  const paging = data.conversationPagination;
  pagination.querySelector("span").textContent = paging.totalPages ? `Page ${paging.page} of ${paging.totalPages}` : "Page 0 of 0";
  pagination.querySelector('[data-page="previous"]').disabled = paging.page <= 1;
  pagination.querySelector('[data-page="next"]').disabled = !paging.totalPages || paging.page >= paging.totalPages;
  page = paging.page;
  notice.removeAttribute("role");
  const missing = data.summary.unavailableSessions || 0;
  const unpriced = Math.max(0, data.summary.requests - data.summary.pricedRequests);
  const partial = missing || unpriced || data.summary.partial;
  notice.className = data.coverage.error ? "usage-error" : partial ? "usage-warning" : "";
  notice.replaceChildren();
  if (data.coverage.error) notice.textContent = data.coverage.error;
  else if (partial) notice.append(element("strong", "Partial coverage"), ` ${missing.toLocaleString()} sessions unavailable · ${unpriced.toLocaleString()} requests unpriced. Values marked `, partialMark(data.summary), " are lower bounds.");
}
function activeFilterCount() {
  return [...new FormData(filters)].filter(([, value]) => value).length + clusterValues.size;
}
function queryString() {
  const parameters = new URLSearchParams();
  for (const [key, value] of new FormData(filters)) {
    if (value) parameters.set(key, String(value));
  }
  if (clusterValues.size) parameters.set("clusters", [...clusterValues].sort().join(","));
  return parameters.toString();
}
function stopPolling(){if(pollTimer)clearTimeout(pollTimer);pollTimer=null;}
async function loadUsage({ polling = false } = {}) {
  stopPolling();
  const scope = queryString();
  clearFilters.hidden = !activeFilterCount();
  if (scope !== snapshotScope) { hasSnapshot = false; snapshotScope = scope; splits.clear(); expanded = ""; }
  const generation = ++requestGeneration;
  status.textContent = hasSnapshot ? "Updating usage…" : "Loading usage…";
  if (!hasSnapshot) {
    notice.className = "";
    notice.removeAttribute("role");
    notice.textContent = "";
    latest = null;
    summary.replaceChildren(element("p", "Loading totals…"));
    trend.replaceChildren();
    breakdowns.replaceChildren(element("p", "Loading breakdowns…"));
  }
  refreshButton.disabled = true;
  try {
    const parameters = new URLSearchParams(queryString()); parameters.set("page", String(page)); parameters.set("pageSize", "20"); if(polling)parameters.set("refresh","false");
    const data = await api(`/api/usage?${parameters}`, {
      signal: AbortSignal.timeout(20000),
    });
    if (generation !== requestGeneration) return;
    renderUsage(data);
    status.textContent = data.coverage.refreshing ? "Refreshing transcripts in background…" : data.coverage.refreshedAt ? `Usage refreshed ${new Date(data.coverage.refreshedAt).toLocaleString()}` : "Showing saved usage; first transcript refresh pending";
    stopPolling();
    if (dialog.open && !document.hidden && data.coverage.refreshing) pollTimer=setTimeout(()=>void loadUsage({polling:true}),2000);
  } catch (error) {
    if (generation !== requestGeneration) return;
    const guidance = error.name === "TimeoutError"
      ? "Usage timed out. Select Refresh usage to try again."
      : `${error.message}. Select Refresh usage to try again.`;
    notice.className = "usage-error";
    notice.setAttribute("role", "alert");
    notice.textContent = guidance;
    if (!hasSnapshot) {
      summary.replaceChildren(element("p", "Usage totals unavailable. Select Refresh usage to try again."));
      breakdowns.replaceChildren(element("p", "Usage breakdowns unavailable. Select Refresh usage to try again."));
    }
    status.textContent = "Usage unavailable";
  } finally {
    if (generation === requestGeneration) refreshButton.disabled = false;
  }
}
async function loadDetections(){try{detections=(await api("/api/subscription-usage/detected")).detections||[];detectionError="";renderPlans();}catch(error){detections=[];detectionError=`Detection unavailable: ${error.message}`;renderPlans();}}
async function loadPlans() {
  planStatus.textContent = "Loading subscription prices…";
  try {
    const data = await api("/api/subscription-usage");
    plans = data.plans || [];
    planStatus.textContent = "";
    planStatus.classList.remove("usage-error");
    renderPlans();
  } catch (error) {
    planStatus.textContent = `Subscription prices unavailable: ${error.message}`;
    planStatus.className = "usage-error";
  }
}
function quotaRow(q={}){const row=element("div",undefined,"quota-row");row.dataset.id=q.id||crypto.randomUUID();row.dataset.capturedAt=q.capturedAt||new Date().toISOString();for(const [label,name,type,value] of [["Label","label","text",q.label],["Used","used","number",q.used],["Limit","limit","number",q.limit],["Reset","resetsAt","datetime-local",localDateTime(q.resetsAt)]]){const w=element("label",label),input=element("input");input.name=name;input.type=type;if(type==="number"){input.min="0";input.step="any";}if(name==="label")input.required=true;input.value=value??"";input.dataset.testid=`quota-${name==="resetsAt"?"reset":name}`;if(name==="resetsAt"&&q.resetsAt)input.dataset.originalIso=q.resetsAt;input.addEventListener("input",()=>row.dataset.dirty="true");w.append(input);row.append(w);}const unit=element("select");unit.name="unit";unit.dataset.testid="quota-unit";for(const v of ["percent","credits","requests","tokens"])unit.add(new Option(v,v));unit.value=q.unit||"percent";unit.addEventListener("change",()=>row.dataset.dirty="true");const label=element("label","Unit");label.append(unit);row.append(label);const remove=element("button","Remove","ghost");remove.type="button";remove.dataset.testid="quota-remove";remove.addEventListener("click",()=>row.remove());row.append(remove);return row;}
function quotaPayload(row){const value=n=>row.querySelector(`[name="${n}"]`).value,num=n=>value(n)===""?null:Number(value(n)),used=num("used"),limit=num("limit"),reset=row.querySelector('[name="resetsAt"]');return{id:row.dataset.id,label:value("label"),used,limit,remaining:used!==null&&limit!==null?Math.max(0,limit-used):null,unit:value("unit"),resetsAt:value("resetsAt")?(reset.dataset.originalIso&&value("resetsAt")===localDateTime(reset.dataset.originalIso)?reset.dataset.originalIso:new Date(value("resetsAt")).toISOString()):null,capturedAt:row.dataset.dirty?new Date().toISOString():row.dataset.capturedAt,source:"manual"};}
function showTab(name) {
  for (const button of dialog.querySelectorAll(".usage-tabs button")) {
    button.setAttribute("aria-pressed", String(button.dataset.testid === `usage-tab-${name}`));
  }
  for (const panel of dialog.querySelectorAll("[data-usage-panel]")) {
    panel.hidden = panel.dataset.usagePanel !== name;
  }
}
function openEditor(plan, harness) {
  showTab("subscriptions");
  planForm.reset();
  quotaRows.replaceChildren();
  editor.open = true;
  planForm.elements.id.value = "";
  planForm.elements.accountLabel.value = "Personal";
  planForm.elements.currency.value = "USD";
  planForm.elements.renewalAt.dataset.originalIso = "";
  updateHarnessOptions(plan?.harnessId || harness || "");
  if (plan) {
    for (const name of ["id", "provider", "accountLabel", "planName"]) {
      planForm.elements[name].value = plan[name] || "";
    }
    planForm.elements.amount.value = plan.price.amount;
    planForm.elements.currency.value = plan.price.currency;
    planForm.elements.billingPeriod.value = plan.price.billingPeriod;
    planForm.elements.renewalAt.value = localDateTime(plan.renewalAt);
    planForm.elements.renewalAt.dataset.originalIso = plan.renewalAt || "";
    for (const quota of plan.quotaWindows) quotaRows.append(quotaRow(quota));
  }
  planForm.elements.harnessId.focus();
}
function planCard(plan,label){const card=element("article",undefined,"subscription-card");card.dataset.testid="subscription-card";card.append(element("h4",`${plan.planName} · ${plan.accountLabel}`),element("strong",formatPlanPrice(plan.price),"subscription-price"),element("p",`${label}${plan.provider?` · ${plan.provider}`:""} · Price override`));if(!plan.quotaWindows.length)card.append(element("p","No manual quota snapshot. Automatic quota reporting unavailable."));for(const q of plan.quotaWindows){const stale=Date.now()-new Date(q.capturedAt).getTime()>3600000||(q.resetsAt&&new Date(q.resetsAt)<new Date());card.append(element("p",`${q.label}: ${q.used??"unknown"} of ${q.limit??"unknown"} ${q.unit}; ${q.remaining??"unknown"} remaining · Manual snapshot ${new Date(q.capturedAt).toLocaleString()}${q.resetsAt?` · resets ${new Date(q.resetsAt).toLocaleString()}`:""}${stale?" · stale":""}`));}const edit=element("button","Edit","ghost");edit.type="button";edit.dataset.testid="subscription-edit";edit.addEventListener("click",()=>openEditor(plan));const remove=element("button","Delete","ghost danger");remove.type="button";remove.dataset.testid="subscription-delete";remove.addEventListener("click",()=>void deletePlan(plan).catch(e=>toast(e.message)));card.append(edit,remove);return card;}
function renderPlans() {
  subscriptionList.replaceChildren();
  const groups = harnesses.map((harness) => ({ id: harnessId(harness), label: harnessLabel(harness) }));
  for (const plan of plans) {
    if (plan.harnessId && !groups.some((group) => group.id === plan.harnessId)) {
      groups.push({ id: plan.harnessId, label: `${plan.harnessId} (stored harness)` });
    }
  }
  if (plans.some((plan) => !plan.harnessId)) groups.push({ id: null, label: "Unassigned — choose a harness" });
  for (const group of groups) {
    const section = element("section", undefined, "subscription-harness-group");
    section.append(element("h4", group.label));
    const detected=detections.find(item=>item.harnessId===group.id);
    if (detected || detectionError) {
      const report = element("article", undefined, "subscription-detected");
      const available = detected?.status === "detected";
      report.append(
        element("strong", available ? "Detected from harness" : "Detection unavailable"),
        element("p", available ? `${detected.planName}${detected.authMethod ? ` · ${detected.authMethod}` : ""}. Billed price unavailable.` : detected?.message || detectionError),
      );
      section.append(report);
    }
    const matching = plans.filter((plan) => (plan.harnessId ?? null) === group.id);
    if (matching.length) {
      section.append(...matching.map((plan) => planCard(plan, group.label)));
    } else {
      if (!detected || detected.status === "detected") section.append(element("p", "Not configured"));
      const setPrice = element("button", detected?.status==="detected" ? "Add price override" : "Set price", "ghost");
      setPrice.type = "button";
      setPrice.dataset.testid = "subscription-set-price";
      setPrice.addEventListener("click", () => { openEditor(null, group.id); if(detected?.planName)planForm.elements.planName.value=detected.planName; });
      section.append(setPrice);
    }
    subscriptionList.append(section);
  }
  if (!groups.length) subscriptionList.append(element("p", "No harness metadata available. Refresh or configure a harness first."));
}
async function deletePlan(plan) {
  const confirmed = await confirmAction({
    title: `Delete ${plan.planName}?`,
    confirmLabel: "Delete",
    destructive: true,
  });
  if (!confirmed) return;
  await api(`/api/subscription-usage/${encodeURIComponent(plan.id)}`, { method: "DELETE" });
  await loadPlans();
}
planForm.addEventListener("submit",async event=>{event.preventDefault();if(!planForm.reportValidity())return;const save=planForm.querySelector('[data-testid="subscription-save"]');if(save.disabled)return;const field=n=>planForm.elements[n].value,renewal=planForm.elements.renewalAt,renewalAt=field("renewalAt")?(renewal.dataset.originalIso&&field("renewalAt")===localDateTime(renewal.dataset.originalIso)?renewal.dataset.originalIso:new Date(field("renewalAt")).toISOString()):null,payload={harnessId:field("harnessId"),provider:field("provider"),accountLabel:field("accountLabel"),planName:field("planName"),price:{amount:Number(field("amount")),currency:field("currency").toUpperCase(),billingPeriod:field("billingPeriod")},renewalAt,quotaWindows:[...quotaRows.children].map(quotaPayload),status:"available",source:"manual"};if(field("id"))payload.id=field("id");const error=document.querySelector("#subscriptionError");error.hidden=true;save.disabled=true;try{await api("/api/subscription-usage",{method:"PUT",body:JSON.stringify(payload)});editor.open=false;await loadPlans();toast("Subscription saved");}catch(failure){error.textContent=failure.message;error.hidden=false;}finally{save.disabled=false;}});
dialog.querySelectorAll(".usage-tabs button").forEach((button) => {
  button.addEventListener("click", () => showTab(button.dataset.testid.replace("usage-tab-", "")));
});
document.querySelectorAll("[data-usage-open]").forEach((button) => {
  button.addEventListener("click", () => openUsageDashboard());
});
document.querySelector("[data-testid='usage-close']").addEventListener("click", () => dialog.close());
dialog.addEventListener("close",()=>{stopPolling();requestGeneration++;});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { stopPolling(); requestGeneration++; }
  else if (dialog.open && hasSnapshot) void loadUsage({ polling: true });
});
pagination.addEventListener("click",event=>{const direction=event.target.closest("button")?.dataset.page;if(!direction)return;page=Math.max(1,page+(direction==="next"?1:-1));void loadUsage();});
document.querySelector("#subscriptionAdd").addEventListener("click", () => openEditor(null));
document.querySelector("#subscriptionCancel").addEventListener("click", () => {
  editor.open = false;
});
document.querySelector("#quotaAdd").addEventListener("click", () => quotaRows.append(quotaRow()));
filters.addEventListener("change", () => { page=1; void loadUsage(); });
clusterFilter.onChange((values) => { clusterValues = values; page = 1; void loadUsage(); });
window.addEventListener("cluster-filters-changed", syncClusterOptions);
clearFilters.addEventListener("click", () => {
  filters.reset();
  clusterValues = new Set();
  clusterFilter.setValues(clusterValues);
  page = 1;
  void loadUsage();
});
dimensionNav.addEventListener("click", (event) => {
  const button = event.target.closest("[data-dimension]");
  if (!button || button.dataset.dimension === dimension) return;
  dimension = button.dataset.dimension;
  expanded = "";
  renderBreakdowns();
});
breakdowns.addEventListener("click", (event) => {
  const sort = event.target.closest("[data-sort]");
  if (sort) {
    const current = currentSort();
    const key = sort.dataset.sort;
    sorts.set(dimension, { key, direction: current.key === key ? -current.direction : key === "name" ? 1 : -1 });
    renderBreakdowns();
    return;
  }
  const toggle = event.target.closest("[data-expand]");
  if (!toggle) return;
  expanded = expanded === toggle.dataset.expand ? "" : toggle.dataset.expand;
  renderBreakdowns();
  if (expanded) void loadSplit(expanded);
});
filters.addEventListener("submit", (event) => {
  event.preventDefault();
  page = 1;
  void loadUsage();
});
refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  try {
    await api("/api/usage/refresh", { method: "POST" });
    await loadUsage({polling:true});
  } catch (error) {
    toast(error.message);
  } finally {
    refreshButton.disabled = false;
  }
});

export function openUsageDashboard(initialFilters = {}) {
  for (const [key, value] of Object.entries(initialFilters)) {
    if (filters.elements[key]) filters.elements[key].value = value;
  }
  if (!dialog.open) dialog.showModal();
  showTab("overview");
  syncClusterOptions();
  editor.open = false;
  void loadHarnesses().catch((error) => {
    planStatus.textContent = `Harnesses unavailable: ${error.message}`;
  });
  void loadPlans();
  void loadDetections();
  page=1;
  void loadUsage();
}
