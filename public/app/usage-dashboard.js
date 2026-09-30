import { api } from "./api.js";
import { state } from "./state.js";
import { confirmAction, toast } from "./shell.js";
import { formatPlanPrice, formatUsageCost } from "./usage-format.js";
import { renderUsageCharts } from "./usage-charts.js";

const dialog = document.querySelector("#usageDialog");
const filters = document.querySelector("#usageFilters");
const status = document.querySelector("#usageStatus");
const notice = document.querySelector("#usageNotice");
const summary = document.querySelector("#usageSummary");
const breakdowns = document.querySelector("#usageBreakdowns");
const subscriptionList = document.querySelector("#subscriptionList");
const planStatus = document.querySelector("#subscriptionPlanStatus");
const editor = document.querySelector("#subscriptionEditor");
const planForm = document.querySelector("#subscriptionForm");
const quotaRows = document.querySelector("#quotaRows");
const refreshButton = document.querySelector("#usageRefresh");
const charts = document.querySelector("#usageCharts");
const pagination = document.querySelector("#usageConversationPagination");

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

function harnessId(harness) {
  return harness.id || harness.harnessId || harness.engine || harness.key;
}

function harnessLabel(harness) {
  return harness.label || harness.name || harnessId(harness);
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
function metric(label, value) {
  const article = element("article", undefined, "usage-metric");
  article.append(element("span", label), element("strong", value));
  return article;
}
function renderSummary(totals) {
  const denominator = totals.input + totals.cacheRead + totals.cacheWrite5m
    + totals.cacheWrite1h + totals.cacheWriteUnknown;
  summary.replaceChildren(
    metric("API-equivalent cost", formatUsageCost(totals)),
    metric("Total tokens", totals.totalTokens.toLocaleString()),
    metric("Input / output", `${totals.input.toLocaleString()} / ${totals.output.toLocaleString()}`),
    metric("Cache read share", denominator ? `${(totals.cacheRead / denominator * 100).toFixed(1)}%` : "Unavailable"),
    metric("Requests priced", `${totals.pricedRequests} / ${totals.requests}`),
    metric("Tool calls / errors", `${totals.toolCalls} / ${totals.toolErrors}`),
    metric("Reasoning tokens", totals.reasoning.toLocaleString()),
  );
}
function renderTable(title, rows, names = new Map()) {
  const section = element("section", undefined, "usage-breakdown");
  section.append(element("h4", title));
  const table = element("table");
  const head = element("tr");
  for (const label of [title.slice(0, -1), "Cost", "Tokens", "Requests", "Tools"]) head.append(element("th", label));
  const thead = element("thead");
  thead.append(head);
  table.append(thead);
  const body = element("tbody");
  for (const item of rows.slice(0, 20)) {
    const row = element("tr");
    const name = names.get(item.key) || item.key || "Not classified";
    for (const value of [name, formatUsageCost(item.totals), item.totals.totalTokens.toLocaleString(), String(item.totals.requests), String(item.totals.toolCalls)]) row.append(element("td", value));
    body.append(row);
  }
  if (!rows.length) {
    const cell = element("td", "No usage in this scope."); cell.colSpan = 5;
    const row = element("tr"); row.append(cell); body.append(row);
  }
  table.append(body); section.append(table); return section;
}
function renderUsage(data) {
  hasSnapshot = true;
  updateInventory(data); renderSummary(data.summary); renderUsageCharts(charts, data);
  const projectNames = new Map(data.projects.map((item) => [item.id, item.name]));
  const conversationNames = new Map(data.conversations.map((item) => [item.conversationId, item.title || item.conversationId]));
  const labels = { projects: "Projects", conversations: "Conversations", classifications: "Existing labels", difficulties: "Classifier difficulties", models: "Models", days: "Days" };
  const sections = Object.entries(labels).map(([key, label]) => {
    const section = renderTable(label, data.breakdowns[key], key === "projects" ? projectNames : key === "conversations" ? conversationNames : new Map());
    if (key === "conversations") { section.dataset.testid = "usage-conversations-table"; section.querySelector("h4").after(pagination); }
    return section;
  });
  breakdowns.replaceChildren(...sections);
  const paging = data.conversationPagination;
  pagination.querySelector("span").textContent = paging.totalPages ? `Page ${paging.page} of ${paging.totalPages}` : "Page 0 of 0";
  pagination.querySelector('[data-page="previous"]').disabled = paging.page <= 1;
  pagination.querySelector('[data-page="next"]').disabled = !paging.totalPages || paging.page >= paging.totalPages;
  page = paging.page;
  notice.removeAttribute("role");
  const missing = data.summary.unavailableSessions || 0;
  const unpriced = Math.max(0, data.summary.requests - data.summary.pricedRequests);
  notice.className = missing || unpriced || data.summary.partial ? "usage-warning" : "";
  notice.textContent = data.coverage.error || (missing || unpriced || data.summary.partial ? `Partial coverage: ${missing} sessions unavailable; ${unpriced} requests unpriced.` : "");
}
function queryString() {
  const parameters = new URLSearchParams();
  for (const [key, value] of new FormData(filters)) {
    if (value) parameters.set(key, String(value));
  }
  return parameters.toString();
}
function stopPolling(){if(pollTimer)clearTimeout(pollTimer);pollTimer=null;}
async function loadUsage({ polling = false } = {}) {
  stopPolling();
  const scope = queryString();
  if (scope !== snapshotScope) { hasSnapshot = false; snapshotScope = scope; }
  const generation = ++requestGeneration;
  status.textContent = hasSnapshot ? "Updating usage…" : "Loading usage…";
  if (!hasSnapshot) {
    notice.className = "";
    notice.removeAttribute("role");
    notice.textContent = "";
    summary.replaceChildren(element("p", "Loading totals…"));
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
  editor.open = false;
  void loadHarnesses().catch((error) => {
    planStatus.textContent = `Harnesses unavailable: ${error.message}`;
  });
  void loadPlans();
  void loadDetections();
  page=1;
  void loadUsage();
}
