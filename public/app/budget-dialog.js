import { api } from "./api.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

/**
 * Spend limits an owner adds to their own workspace, project or conversation, and the strip above
 * the composer that says when one is used up. A cluster manager's limits show here too but are not
 * editable: these limits only ever tighten them.
 */
const PERIODS = [["hour", "Hour"], ["day", "Day"], ["week", "Week"], ["month", "Month"], ["year", "Year"], ["total", "Total"]];
const PERIOD_WORD = { hour: "hourly", day: "daily", week: "weekly", month: "monthly", year: "yearly", total: "total" };
const money = (usd) => `$${usd < 100 ? usd.toFixed(2) : Math.round(usd).toLocaleString("en-US")}`;

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

const query = (target) => new URLSearchParams({ kind: target.kind, subjectId: target.subjectId, ...(target.kind === "conversation" ? { projectId: target.projectId } : {}) });

function describe(budget) {
  const scope = budget.kind === "cluster" ? "cluster" : budget.kind;
  return `${PERIOD_WORD[budget.period]} ${scope} limit: ${money(budget.spentUsd)} of ${money(budget.limitUsd)}${budget.source === "cluster" ? " · set by the cluster manager" : ""}`;
}

let dialog;
function ensureDialog() {
  if (dialog) return dialog;
  dialog = element("dialog", undefined, "budget-dialog"); dialog.dataset.testid = "budget-dialog";
  document.body.append(dialog);
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  return dialog;
}

/** Opens the editor for one item. `target` is { kind, subjectId, projectId?, title }. */
export async function openBudgetDialog(target) {
  const box = ensureDialog();
  const [{ limits }, status] = await Promise.all([
    api(`/api/budgets/limits?${query(target)}`),
    target.kind === "workspace" ? Promise.resolve(null)
      : api(`/api/budgets/status?${new URLSearchParams({ projectId: target.kind === "project" ? target.subjectId : target.projectId, ...(target.kind === "conversation" ? { conversationId: target.subjectId } : {}) })}`),
  ]);
  const heading = element("h3", `Budget · ${target.title}`);
  const intro = element("p", "Your limit stops new work here once the estimated API price reaches it. It adds to any limit a cluster manager set; it never loosens one.", "cluster-muted");
  const grid = element("div", undefined, "budget-dialog-grid");
  for (const [period, label] of PERIODS) {
    const field = element("label", label, "budget-dialog-field");
    const input = element("input"); input.type = "number"; input.min = "0.01"; input.step = "any"; input.inputMode = "decimal"; input.placeholder = "none";
    input.dataset.budgetPeriod = period; input.value = limits.find((limit) => limit.period === period)?.usd ?? "";
    field.append(input); grid.append(field);
  }
  const list = element("ul", undefined, "budget-dialog-status"); list.dataset.testid = "budget-dialog-status";
  for (const budget of status?.budgets ?? []) list.append(element("li", describe(budget), budget.exceeded ? "budget-over" : budget.warning ? "budget-warn" : ""));
  const actions = element("div", undefined, "budget-dialog-actions");
  const save = element("button", "Save", "primary compact"); save.type = "button"; save.dataset.testid = "budget-dialog-save";
  const close = element("button", "Close", "ghost compact"); close.type = "button";
  close.addEventListener("click", () => box.close());
  save.addEventListener("click", async () => {
    save.disabled = true;
    const next = [...grid.querySelectorAll("input")].flatMap((input) => input.value.trim() === "" ? [] : [{ period: input.dataset.budgetPeriod, usd: Number(input.value) }]);
    try {
      await api(`/api/budgets/limits?${query(target)}`, { method: "PUT", body: JSON.stringify({ limits: next, utcOffsetMinutes: -new Date().getTimezoneOffset() }) });
      box.close(); toast(next.length ? "Budget saved" : "Budget removed"); refreshBudgetNotice();
    } catch (error) { toast(error.message); save.disabled = false; }
  });
  actions.append(save, close);
  box.replaceChildren(heading, intro, grid, ...(list.children.length ? [list] : []), actions);
  box.showModal();
}

/** Menu entries call these so every caller builds the same target. */
export const projectBudgetTarget = (project) => ({ kind: "project", subjectId: project.id, title: project.name });
export const conversationBudgetTarget = (projectId, conversationId, title) => ({ kind: "conversation", subjectId: conversationId, projectId, title });
export const workspaceBudgetTarget = (workspace) => ({ kind: "workspace", subjectId: workspace.id, title: workspace.label });

let notice;
function ensureNotice() {
  if (notice?.isConnected) return notice;
  const composer = document.getElementById("composer");
  if (!composer) return null;
  notice = element("div", undefined, "budget-notice"); notice.dataset.testid = "budget-notice"; notice.hidden = true; notice.setAttribute("role", "status");
  composer.before(notice);
  return notice;
}

let latest = 0;
/** Shows the strip for the open conversation: red when a budget is used up, amber from 80%. */
export async function refreshBudgetNotice() {
  const strip = ensureNotice();
  const projectId = state.activeConversationProjectId || state.activeProjectId, conversationId = state.activeConversationId;
  if (!strip || !projectId) return;
  const ticket = ++latest;
  try {
    const status = await api(`/api/budgets/status?${new URLSearchParams({ projectId, ...(conversationId ? { conversationId } : {}) })}`);
    if (ticket !== latest) return;
    const worst = status.budgets.find((budget) => budget.exceeded) ?? status.budgets.find((budget) => budget.warning);
    strip.hidden = !worst;
    strip.dataset.state = worst?.exceeded ? "over" : "warning";
    strip.textContent = worst ? (worst.exceeded ? status.message : `Nearing a budget: ${describe(worst)}.`) : "";
  } catch { if (ticket === latest) strip.hidden = true; }
}
