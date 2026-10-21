import { api } from "./api.js";
import { state } from "./state.js";
import { presetRange } from "./usage-periods.js";
import { formatUsageCost } from "./usage-format.js";
import { buildDraftForm } from "./usage-skill-suggestions-view.js";

const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const options = (select, rows, prompt) => {
  const previous = select.value;
  select.replaceChildren(new Option(prompt, ""), ...rows.map(({ id, name }) => new Option(name, id)));
  select.value = rows.some(({ id }) => id === previous) ? previous : "";
};

/** Controls belong to one report. No reads from, or writes to, the dashboard form. */
function controls(kind) {
  const form = element("form", undefined, "usage-toolbar usage-feature-controls");
  form.dataset.testid = `usage-${kind}-controls`;
  form.setAttribute("aria-label", `${kind === "cluster" ? "Cluster report" : "Repeated work"} filters`);
  function field(name, label, type = "select") {
    const wrapper = element("label", label), input = element(type === "select" ? "select" : "input");
    input.name = name;
    input.dataset.testid = `usage-${kind}-${name}`;
    if (type !== "select") input.type = type;
    wrapper.append(input); form.append(wrapper);
    return input;
  }
  function dates() {
    const period = field("period", "Period");
    for (const [value, label] of [["all", "All time"], ["month", "This month"], ["30d", "Last 30 days"], ["90d", "Last 90 days"], ["custom", "Custom dates"]]) period.add(new Option(label, value));
    const from = field("from", "From", "date"), to = field("to", "To", "date");
    const sync = () => {
      const custom = period.value === "custom";
      from.parentElement.hidden = to.parentElement.hidden = !custom;
      from.disabled = to.disabled = !custom;
      from.required = to.required = custom;
      to.setCustomValidity(custom && from.value && to.value && from.value > to.value ? "End date must not be before start date." : "");
    };
    form.addEventListener("change", sync);
    sync();
    return () => {
      sync();
      if (!form.checkValidity()) return null;
      const range = period.value === "custom" ? { from: from.value, to: to.value } : presetRange(period.value);
      return { ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" };
    };
  }
  return { form, field, dates };
}

export function createClusterReport(changed) {
  const { form, field, dates } = controls("cluster");
  const cluster = field("cluster", "Cluster"), project = field("project", "Shared project");
  const dateScope = dates();
  const retry = element("button", "Refresh report", "ghost");
  retry.type = "submit"; retry.dataset.testid = "usage-cluster-refresh";
  form.append(retry);
  options(cluster, [], "Choose a cluster");
  options(project, [], "All shared projects");
  let entry, ticket = 0, key = "", loadedAt = 0, selectedCluster = "";

  function sync() {
    options(cluster, state.clusters || [], "Choose a cluster");
    if (!cluster.value && state.clusters?.length === 1) cluster.value = state.clusters[0].id;
    if (selectedCluster !== cluster.value) {
      selectedCluster = cluster.value;
      options(project, [], "All shared projects");
      project.disabled = true;
      reset();
    }
  }
  async function load(force = false) {
    sync();
    const scope = dateScope();
    if (!cluster.value || !scope) {
      ++ticket; key = "";
      entry = { unavailable: !cluster.value ? "Choose a cluster here to see its shared projects." : "Choose a valid start and end date for this report." };
      changed(); return;
    }
    const query = new URLSearchParams({ ...scope, refresh: "false", ...(project.value ? { projectId: project.value } : {}) });
    const url = `/api/usage/clusters/${encodeURIComponent(cluster.value)}/report?${query}`;
    if (!force && url === key && (entry?.loading || Date.now() - loadedAt < 60_000)) return;
    key = url;
    const current = ++ticket;
    entry = { loading: true }; changed();
    try {
      const value = await api(url, { signal: AbortSignal.timeout(30000) });
      if (current !== ticket) return;
      entry = { value }; loadedAt = Date.now();
      if (!query.has("projectId")) options(project, value.projects, "All shared projects");
      project.disabled = false;
    } catch (error) {
      if (current !== ticket) return;
      entry = { error: error.name === "TimeoutError" ? "the request timed out" : error.message };
    }
    changed();
  }
  function reset() { ++ticket; entry = undefined; key = ""; loadedAt = 0; }
  form.addEventListener("change", () => { void load(true); });
  form.addEventListener("submit", (event) => { event.preventDefault(); void load(true); });
  return { controls: form, ensure: () => { void load(); }, reset, get entry() { return entry; } };
}

export function createRepeatedWork() {
  const root = element("div", undefined, "usage-insight-flows");
  const { form, field, dates } = controls("flows");
  const project = field("project", "Project");
  project.required = true;
  options(project, [], "Choose a project");
  const dateScope = dates();
  const limit = field("limit", "Recent conversations");
  for (const size of [25, 50, 100]) limit.add(new Option(`Up to ${size}`, String(size)));
  limit.value = "100";
  const analyse = element("button", "Look for repeated work");
  analyse.type = "submit"; analyse.dataset.testid = "usage-analysis";
  form.append(analyse);
  const results = element("div");
  results.dataset.testid = "usage-analysis-results";
  results.setAttribute("aria-live", "polite");
  root.append(form,
    element("p", "Choose a project and period here. These controls do not use the global filters. Analysis reads the most recently active conversations within the limit, using saved titles, turn times and usage on this node. No model or transcript text. Nothing is installed or shared without your review."), results);
  let ticket = 0;
  function reset() { ++ticket; results.replaceChildren(); analyse.disabled = false; }
  function sync() {
    const previous = project.value;
    options(project, state.projects || [], "Choose a project");
    if (previous !== project.value) reset();
  }
  function coverage(value) {
    return `${value.conversations} of ${value.totalConversations} conversations${value.truncated ? ", most recently active first; narrow the period to include different work" : ""}`;
  }
  function suggestionCard(suggestion, projectId) {
    const card = element("article", undefined, "subscription-card");
    card.append(element("h4", `${suggestion.label} · candidate ${suggestion.kind}`), element("p", `Heuristic confidence ${(suggestion.confidence * 100).toFixed(0)}% · ${formatUsageCost({ apiCostUsd: suggestion.associatedCostUsd, partial: false })} associated known cost. No savings estimated. Review evidence before drafting; nothing installed or shared.`));
    for (const evidence of suggestion.evidence) {
      const link = element("a", evidence.conversationId);
      link.href = evidence.href; link.target = "_blank"; link.rel = "noopener noreferrer";
      card.append(link);
    }
    card.append(buildDraftForm({ project: projectId, kind: suggestion.kind, evidenceIds: suggestion.evidence.map((item) => item.conversationId) }));
    return card;
  }
  form.addEventListener("change", reset);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const dates = dateScope();
    if (!dates || !project.value) return;
    reset();
    const current = ticket;
    const scope = { projectId: project.value, ...dates, limit: limit.value };
    analyse.disabled = true;
    results.append(element("p", "Checking selected conversations…"));
    try {
      const preview = await api(`/api/usage/analysis/preview?${new URLSearchParams(scope)}`, { signal: AbortSignal.timeout(30000) });
      if (current !== ticket) return;
      results.replaceChildren(element("p", `Preflight: ${coverage(preview)} · no model · $0 estimated model cost · ${preview.data}.`));
      if (!preview.conversations) { results.append(element("p", "No saved conversations in this period. Choose another period or project.")); return; }
      const run = element("button", "Run local analysis");
      run.type = "button"; run.dataset.testid = "usage-analysis-run";
      results.append(run);
      run.addEventListener("click", async () => {
        run.disabled = true;
        try {
          const result = await api("/api/usage/analysis", { method: "POST", body: JSON.stringify(scope), signal: AbortSignal.timeout(30000) });
          if (current !== ticket) return;
          results.replaceChildren(element("p", `Analyzed ${coverage(result.coverage)}.`));
          if (!result.coverage.timingComplete || !result.coverage.eventsComplete) results.append(element("p", "Some timing or skill-event data exceeded the safety limit and was omitted. Narrow the period for fuller results."));
          if (!result.suggestions.length) results.append(element("p", "No repeated title patterns or skill improvements found in this selection. No savings inferred."));
          results.append(...result.suggestions.map((suggestion) => suggestionCard(suggestion, scope.projectId)));
        } catch (error) {
          if (current !== ticket) return;
          results.append(element("p", `Analysis unavailable: ${error.message}`)); run.disabled = false;
        }
      });
    } catch (error) {
      if (current === ticket) results.replaceChildren(element("p", `Preflight unavailable: ${error.message}`));
    } finally { if (current === ticket) analyse.disabled = false; }
  });
  return { root, sync, reset };
}
