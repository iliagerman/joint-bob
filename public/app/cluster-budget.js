import { api } from "./api.js";
import { toast } from "./shell.js";

/**
 * Settings > Cluster > Budget. The cluster's manager sets a spending limit for the whole cluster
 * and defaults for each workspace, project and conversation in it; every other member sees the
 * same numbers read-only. Spend is the ledger's API-equivalent price, not an invoice.
 */
const PERIODS = [["hour", "Hour"], ["day", "Day"], ["week", "Week"], ["month", "Month"], ["year", "Year"], ["total", "Total"]];
const ROWS = [
  ["limits", "Whole cluster", "Everything shared into this cluster, added up"],
  ["workspace", "Each workspace", "Default for every workspace"],
  ["project", "Each project", "Default for every project"],
  ["conversation", "Each conversation", "Default for every conversation"],
];

function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}

export function installBudgetTab(tabs, pane) {
  if (tabs.querySelector('[data-cluster-tab="budget"]')) return;
  const tab = element("button", "Budget", "settings-subtab");
  tab.type = "button"; tab.setAttribute("role", "tab"); tab.dataset.clusterTab = "budget"; tab.dataset.testid = "cluster-tab-budget"; tab.setAttribute("aria-controls", "clusterBudget");
  tabs.append(tab);
  const section = element("section", undefined, "cluster-tab-panel cluster-budget");
  section.id = "clusterBudget"; section.setAttribute("role", "tabpanel"); section.dataset.clusterPanel = "budget"; section.dataset.testid = "cluster-budget"; section.hidden = true;
  pane.append(section);
}

const limitsOf = (policy, key) => key === "limits" ? policy.limits : policy.defaults[key];
const offsetLabel = (minutes) => `UTC${minutes < 0 ? "−" : "+"}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;

function readPolicy(grid, utcOffsetMinutes) {
  const read = (key) => PERIODS.flatMap(([period]) => {
    const value = grid.querySelector(`[data-budget-row="${key}"][data-budget-period="${period}"]`).value.trim();
    return value === "" ? [] : [{ period, usd: Number(value) }];
  });
  return { limits: read("limits"), defaults: { workspace: read("workspace"), project: read("project"), conversation: read("conversation") }, utcOffsetMinutes };
}

function render(section, view, nodeNames) {
  const editable = view.isManager;
  const offset = view.hasPolicy ? view.policy.utcOffsetMinutes : -new Date().getTimezoneOffset();
  const intro = element("p", editable
    ? "You manage this cluster, so these limits apply to everything shared into it, on every node. An owner can add a tighter limit to their own project, never a looser one."
    : "The cluster's manager sets these limits. They apply to everything shared into this cluster, on every node, and you can add a tighter limit to your own projects.", "cluster-muted");
  const grid = element("div", undefined, "budget-grid"); grid.dataset.testid = "cluster-budget-grid";
  grid.append(element("span"), ...PERIODS.map(([, label]) => element("span", label, "budget-head")));
  for (const [key, label, hint] of ROWS) {
    const name = element("span", label, "budget-row-name"); name.title = hint;
    grid.append(name);
    for (const [period] of PERIODS) {
      const current = limitsOf(view.policy, key).find((limit) => limit.period === period);
      const input = element("input"); input.type = "number"; input.min = "0.01"; input.step = "any"; input.inputMode = "decimal";
      input.placeholder = "none"; input.disabled = !editable; input.value = current ? String(current.usd) : "";
      input.dataset.budgetRow = key; input.dataset.budgetPeriod = period;
      input.setAttribute("aria-label", `${label}, ${period} limit in dollars`);
      grid.append(input);
    }
  }
  const footer = element("div", undefined, "budget-footer");
  const note = element("p", `Periods start at midnight ${offsetLabel(offset)}${editable ? ", your timezone" : ", the manager's"} so every node resets together. ${view.hasPolicy ? `Revision ${view.revision}.` : "No budget set yet."} Spend is the estimated API price of each request; it is not an invoice, and requests with no known price are not counted.`, "cluster-muted");
  footer.append(note);
  if (editable) {
    const save = element("button", "Save budget", "primary compact"); save.type = "button"; save.dataset.testid = "cluster-budget-save";
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        const saved = await api(`/api/budgets/clusters/${view.id}`, { method: "PUT", body: JSON.stringify(readPolicy(grid, -new Date().getTimezoneOffset())) });
        render(section, saved, nodeNames); toast("Budget saved");
      } catch (error) { toast(error.message); save.disabled = false; }
    });
    footer.append(save);
    if (view.pendingNodeIds.length) {
      const names = view.pendingNodeIds.map((id) => nodeNames(id)).join(", ");
      footer.append(element("p", `Waiting for ${names} to confirm. A node that is offline enforces the previous budget until it hears this one.`, "cluster-muted budget-pending"));
    }
  }
  section.replaceChildren(intro, grid, footer);
}

/** Loads this cluster's budget and shows it, editable for its manager. */
export async function renderClusterBudget(cluster, nodeNames) {
  const section = document.getElementById("clusterBudget");
  if (!section) return;
  section.replaceChildren(element("p", "Loading budget…", "cluster-muted"));
  try {
    const { clusters } = await api("/api/budgets/clusters");
    const view = clusters.find((item) => item.id === cluster.id);
    if (document.getElementById("clusterBudget") !== section) return;
    if (!view) { section.replaceChildren(element("p", "Budget unavailable for this cluster.", "cluster-muted")); return; }
    render(section, view, nodeNames);
  } catch (error) {
    section.replaceChildren(element("p", `Could not load the budget: ${error.message}`, "cluster-muted"));
  }
}

