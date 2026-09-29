import { api } from "./api.js";
import { confirmAction, toast } from "./shell.js";
import { formatPlanPrice, formatUsageCost } from "./usage-format.js";

const dialog = document.querySelector("#usageDialog");
const filters = document.querySelector("#usageFilters");
const status = document.querySelector("#usageStatus");
const notice = document.querySelector("#usageNotice");
const summary = document.querySelector("#usageSummary");
const breakdowns = document.querySelector("#usageBreakdowns");
const subscriptionList = document.querySelector("#subscriptionList");
const editor = document.querySelector("#subscriptionEditor");
const planForm = document.querySelector("#subscriptionForm");
const quotaRows = document.querySelector("#quotaRows");
const refreshButton = document.querySelector("#usageRefresh");
let requestGeneration = 0;
let inventory = { projects: [], conversations: [], classifications: [] };
let plans = [];

export function localDateTime(iso) {
  if (!iso) return "";
  const date = new Date(iso); const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function setOptions(select, options, firstLabel) {
  const selected = select.value;
  select.replaceChildren(new Option(firstLabel, ""));
  for (const option of options) select.add(new Option(option.label, option.value));
  if (selected && !options.some((option) => option.value === selected)) select.add(new Option(selected, selected));
  select.value = selected;
}

function updateInventory(data) {
  const merge = (current, additions, key) => [...new Map([...current, ...additions].map((item) => [item[key], item])).values()];
  inventory.projects = merge(inventory.projects, data.projects, "id");
  inventory.conversations = merge(inventory.conversations, data.conversations, "conversationId");
  const labels = data.breakdowns.classifications.map(({ key }) => key).filter(Boolean);
  inventory.classifications = [...new Set([...inventory.classifications, ...labels])].sort();
  setOptions(filters.elements.projectId, inventory.projects.map((p) => ({ value: p.id, label: p.name })), "All projects");
  setOptions(filters.elements.conversationId, inventory.conversations.map((c) => ({ value: c.conversationId, label: c.title || c.conversationId })), "All conversations");
  setOptions(filters.elements.classification, inventory.classifications.map((label) => ({ value: label, label })), "All labels");
}

function metric(label, value) {
  const card = element("article", undefined, "usage-metric");
  card.append(element("span", label), element("strong", value));
  return card;
}

function renderSummary(totals) {
  const denominator = totals.input + totals.cacheRead + totals.cacheWrite5m + totals.cacheWrite1h + totals.cacheWriteUnknown;
  const cacheShare = denominator ? `${(totals.cacheRead / denominator * 100).toFixed(1)}%` : "Unavailable";
  summary.replaceChildren(
    metric("API-equivalent cost", formatUsageCost(totals)), metric("Total tokens", totals.totalTokens.toLocaleString()),
    metric("Input / output", `${totals.input.toLocaleString()} / ${totals.output.toLocaleString()}`),
    metric("Cache read share", cacheShare), metric("Requests priced", `${totals.pricedRequests} / ${totals.requests}`),
    metric("Tool calls / errors", `${totals.toolCalls} / ${totals.toolErrors}`), metric("Reasoning tokens", totals.reasoning.toLocaleString()),
  );
}

function renderTable(title, rows, names = new Map()) {
  const section = element("section", undefined, "usage-breakdown");
  section.append(element("h4", title));
  const table = element("table");
  const head = element("tr");
  for (const label of [title.slice(0, -1), "Cost", "Tokens", "Requests", "Tools"]) head.append(element("th", label));
  table.append(element("thead")); table.tHead.append(head);
  const body = element("tbody");
  if (!rows.length) { const cell = element("td", "No usage in this scope."); cell.colSpan = 5; const row = element("tr"); row.append(cell); body.append(row); }
  for (const item of rows) {
    const row = element("tr");
    const name = names.get(item.key) || item.key || "Not classified";
    for (const value of [name, formatUsageCost(item.totals), item.totals.totalTokens.toLocaleString(), String(item.totals.requests), String(item.totals.toolCalls)]) row.append(element("td", value));
    body.append(row);
  }
  table.append(body); section.append(table); return section;
}

function renderBreakdowns(data) {
  const projectNames = new Map(data.projects.map((p) => [p.id, p.name]));
  const conversationNames = new Map(data.conversations.map((c) => [c.conversationId, c.title || c.conversationId]));
  const labels = { projects: "Projects", conversations: "Conversations", classifications: "Existing labels", difficulties: "Classifier difficulties", models: "Models", days: "Days" };
  breakdowns.replaceChildren(...Object.entries(labels).map(([key, label]) => renderTable(label, data.breakdowns[key], key === "projects" ? projectNames : key === "conversations" ? conversationNames : new Map())));
}

function renderUsage(data) {
  updateInventory(data); renderSummary(data.summary); renderBreakdowns(data);
  notice.removeAttribute("role");
  const missing = data.summary.unavailableSessions || 0;
  const unpriced = Math.max(0, data.summary.requests - data.summary.pricedRequests);
  notice.className = missing || unpriced || data.summary.partial ? "usage-warning" : "";
  notice.textContent = missing || unpriced || data.summary.partial ? `Partial coverage: ${missing} sessions unavailable; ${unpriced} requests unpriced.` : "";
  plans = data.subscriptions;
  renderPlans();
}

function queryString() {
  const params = new URLSearchParams();
  for (const [key, value] of new FormData(filters)) if (value) params.set(key, String(value));
  return params.toString();
}

async function loadUsage() {
  const generation = ++requestGeneration;
  status.textContent = "Loading usage…"; refreshButton.disabled = true;
  try {
    const data = await api(`/api/usage?${queryString()}`);
    if (generation !== requestGeneration) return;
    renderUsage(data); status.textContent = `Usage refreshed ${new Date(data.coverage.refreshedAt).toLocaleString()}`;
  } catch (error) {
    if (generation !== requestGeneration) return;
    summary.replaceChildren(); breakdowns.replaceChildren(); subscriptionList.replaceChildren(); notice.className = "usage-error"; notice.setAttribute("role", "alert"); notice.textContent = error.message; status.textContent = "Usage unavailable";
  } finally {
    if (generation === requestGeneration) refreshButton.disabled = false;
  }
}

function quotaRow(quota = {}) {
  const row = element("div", undefined, "quota-row");
  row.dataset.id = quota.id || crypto.randomUUID(); row.dataset.capturedAt = quota.capturedAt || new Date().toISOString();
  const fields = [["Label", "label", "text", quota.label], ["Used", "used", "number", quota.used], ["Limit", "limit", "number", quota.limit], ["Reset", "resetsAt", "datetime-local", localDateTime(quota.resetsAt)]];
  for (const [label, name, type, value] of fields) {
    const wrapper = element("label", label); const input = element("input"); input.name = name; input.type = type;
    if (type === "number") { input.min = "0"; input.step = "any"; }
    if (name === "label") input.required = true;
    input.value = value ?? ""; input.dataset.testid = `quota-${name === "resetsAt" ? "reset" : name}`;
    if (name === "resetsAt" && quota.resetsAt) input.dataset.originalIso = quota.resetsAt;
    input.addEventListener("input", () => { row.dataset.dirty = "true"; }); wrapper.append(input); row.append(wrapper);
  }
  const unit = element("select"); unit.name = "unit"; unit.dataset.testid = "quota-unit";
  for (const value of ["percent", "credits", "requests", "tokens"]) unit.add(new Option(value, value)); unit.value = quota.unit || "percent";
  unit.addEventListener("change", () => { row.dataset.dirty = "true"; }); const unitLabel = element("label", "Unit"); unitLabel.append(unit); row.append(unitLabel);
  const remove = element("button", "Remove", "ghost"); remove.type = "button"; remove.dataset.testid = "quota-remove"; remove.addEventListener("click", () => row.remove()); row.append(remove);
  return row;
}

function quotaPayload(row) {
  const value = (name) => row.querySelector(`[name="${name}"]`).value;
  const number = (name) => value(name) === "" ? null : Number(value(name));
  const used = number("used"), limit = number("limit");
  const reset = row.querySelector('[name="resetsAt"]');
  const resetsAt = value("resetsAt") ? reset.dataset.originalIso && value("resetsAt") === localDateTime(reset.dataset.originalIso) ? reset.dataset.originalIso : new Date(value("resetsAt")).toISOString() : null;
  return { id: row.dataset.id, label: value("label"), used, limit, remaining: used !== null && limit !== null ? Math.max(0, limit - used) : null, unit: value("unit"), resetsAt, capturedAt: row.dataset.dirty ? new Date().toISOString() : row.dataset.capturedAt, source: "manual" };
}

function openEditor(plan) {
  planForm.reset(); quotaRows.replaceChildren(); editor.open = true;
  planForm.elements.id.value = "";
  planForm.elements.renewalAt.dataset.originalIso = "";
  if (plan) {
    for (const name of ["id", "provider", "accountLabel", "planName"]) planForm.elements[name].value = plan[name] || "";
    planForm.elements.amount.value = plan.price.amount; planForm.elements.currency.value = plan.price.currency; planForm.elements.billingPeriod.value = plan.price.billingPeriod;
    planForm.elements.renewalAt.value = localDateTime(plan.renewalAt);
    planForm.elements.renewalAt.dataset.originalIso = plan.renewalAt || "";
    for (const quota of plan.quotaWindows) quotaRows.append(quotaRow(quota));
  }
  planForm.elements.provider.focus();
}

function planCard(plan) {
  const card = element("article", undefined, "subscription-card"); card.dataset.testid = "subscription-card";
  card.append(element("h4", `${plan.planName} · ${plan.accountLabel}`), element("strong", formatPlanPrice(plan.price), "subscription-price"), element("p", `${plan.provider} · Manual account plan`));
  if (!plan.quotaWindows.length) card.append(element("p", "No manual quota snapshot. Automatic quota reporting unavailable."));
  for (const quota of plan.quotaWindows) {
    const stale = Date.now() - new Date(quota.capturedAt).getTime() > 3600000 || (quota.resetsAt && new Date(quota.resetsAt) < new Date());
    card.append(element("p", `${quota.label}: ${quota.used ?? "unknown"} of ${quota.limit ?? "unknown"} ${quota.unit}; ${quota.remaining ?? "unknown"} remaining · Manual snapshot ${new Date(quota.capturedAt).toLocaleString()}${quota.resetsAt ? ` · resets ${new Date(quota.resetsAt).toLocaleString()}` : ""}${stale ? " · stale" : ""}`));
  }
  const edit = element("button", "Edit", "ghost"); edit.type = "button"; edit.dataset.testid = "subscription-edit"; edit.addEventListener("click", () => openEditor(plan));
  const remove = element("button", "Delete", "ghost danger"); remove.type = "button"; remove.dataset.testid = "subscription-delete"; remove.addEventListener("click", () => void deletePlan(plan).catch((error) => toast(error.message))); card.append(edit, remove); return card;
}

function renderPlans() {
  subscriptionList.replaceChildren();
  if (!plans.length) subscriptionList.append(element("p", "Add your subscription price."));
  else subscriptionList.append(...plans.map(planCard));
}

async function deletePlan(plan) {
  if (!await confirmAction({ title: `Delete ${plan.planName}?`, confirmLabel: "Delete", destructive: true })) return;
  await api(`/api/subscription-usage/${encodeURIComponent(plan.id)}`, { method: "DELETE" }); await loadUsage();
}

planForm.addEventListener("submit", async (event) => {
  event.preventDefault(); if (!planForm.reportValidity()) return;
  const field = (name) => planForm.elements[name].value;
  const renewal = planForm.elements.renewalAt;
  const renewalAt = field("renewalAt") ? renewal.dataset.originalIso && field("renewalAt") === localDateTime(renewal.dataset.originalIso) ? renewal.dataset.originalIso : new Date(field("renewalAt")).toISOString() : null;
  const payload = { provider: field("provider"), accountLabel: field("accountLabel"), planName: field("planName"), price: { amount: Number(field("amount")), currency: field("currency").toUpperCase(), billingPeriod: field("billingPeriod") }, renewalAt, quotaWindows: [...quotaRows.children].map(quotaPayload), status: "available", source: "manual" };
  if (field("id")) payload.id = field("id");
  const error = document.querySelector("#subscriptionError"); error.hidden = true;
  try { await api("/api/subscription-usage", { method: "PUT", body: JSON.stringify(payload) }); editor.open = false; await loadUsage(); toast("Subscription saved"); }
  catch (failure) { error.textContent = failure.message; error.hidden = false; }
});

document.querySelectorAll("[data-usage-open]").forEach((button) => button.addEventListener("click", () => openUsageDashboard()));
document.querySelector("[data-testid='usage-close']").addEventListener("click", () => dialog.close());
document.querySelector("#subscriptionAdd").addEventListener("click", () => openEditor(null));
document.querySelector("#subscriptionCancel").addEventListener("click", () => { editor.open = false; });
document.querySelector("#quotaAdd").addEventListener("click", () => quotaRows.append(quotaRow()));
filters.addEventListener("change", loadUsage);
filters.addEventListener("submit", (event) => { event.preventDefault(); void loadUsage(); });
refreshButton.addEventListener("click", async () => { refreshButton.disabled = true; try { await api("/api/usage/refresh", { method: "POST" }); await loadUsage(); } catch (error) { toast(error.message); } finally { refreshButton.disabled = false; } });

export function openUsageDashboard(initialFilters = {}) {
  for (const [key, value] of Object.entries(initialFilters)) if (filters.elements[key]) filters.elements[key].value = value;
  if (!dialog.open) dialog.showModal();
  void loadUsage();
}
