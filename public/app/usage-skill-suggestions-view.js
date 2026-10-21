import { api } from "./api.js";
import { confirmAction } from "./shell.js";
import { money } from "./usage-insight-data.js";
import { skeleton } from "./usage-progress.js";

/**
 * The Suggestions view of the Skills & time tab: one ranked list of kinds of work worth a skill,
 * failing skills to fix, overlapping skills to merge and idle skills to remove, each with its
 * evidence and one action. Nothing is installed or removed: a draft is saved for review and
 * installed only after approval.
 */

export const PAGE = 6;
const TYPES = [["all", "All"], ["new", "New skill"], ["fix", "Fix"], ["merge", "Merge"], ["remove", "Remove"]];
const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}
const count = (value, noun) => `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
const button = (text, className, data = {}) => {
  const item = node("button", text, className);
  item.type = "button";
  for (const [key, value] of Object.entries(data)) item.dataset[key] = value;
  return item;
};
/** A heading with the skill names in code type: `parts` alternates plain text and names. */
function title(...parts) {
  const heading = node("h5");
  parts.forEach((part, index) => heading.append(index % 2 ? node("code", part) : part));
  return heading;
}

/** A file-safe skill name for a phrase, or "" when the phrase has letters a name cannot hold. */
export function suggestedName(phrase) {
  const name = phrase.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 59);
  return /^[a-z][a-z0-9-]{1,59}$/.test(name) ? name : "";
}

export function checkedAgo(at, now = Date.now()) {
  const minutes = Math.round((now - at) / 60000);
  if (minutes < 1) return "Checked just now";
  if (minutes < 60) return `Checked ${minutes} min ago`;
  return `Checked at ${new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`;
}

function describe(entry) {
  const { type, item } = entry;
  if (type === "new") {
    const why = node("p", `You asked for this by hand in ${count(item.conversations, "conversation")}, in ${count(item.projects, "project")}, over ${count(item.days, "different day")}.`);
    if (item.coveredBy) {
      const link = button(item.coveredBy, "usage-link", { openSkill: item.coveredBy });
      why.append(" It may already be covered by ", link, ".");
    }
    const match = node("span", undefined, "usage-suggest-match");
    const bar = node("i"); bar.style.setProperty("--match", `${Math.round(item.confidence * 100)}%`);
    match.append("Match ", bar, ` ${Math.round(item.confidence * 100)}%`);
    return { label: `New ${item.kind}`, heading: title(item.phrase[0].toUpperCase() + item.phrase.slice(1)), why: [why, match],
      impact: [money(item.knownCostUsd), "spent on it in this period"] };
  }
  const facts = item.turns ? [count(item.turns, "turn"), "loaded in recorded usage"] : ["0 turns", "never loaded"];
  if (type === "fix") return { label: "Fix", heading: title("", item.name, " fails often"), why: [node("p", item.reason)], impact: item.knownCostUsd ? [money(item.knownCostUsd), `spent in its ${count(item.turns, "turn")}`] : facts };
  if (type === "merge") return { label: "Merge", heading: title("", item.name, " overlaps ", item.other ?? "another skill"), why: [node("p", item.reason)], impact: facts };
  return { label: "Remove", heading: title("", item.name, item.turns ? " is rarely used" : " is not used"), why: [node("p", item.reason)], impact: facts };
}

function actions(entry) {
  const { type, item, key } = entry;
  const wrap = node("div", undefined, "usage-suggest-actions");
  if (type === "new") {
    const draft = button(`Draft ${item.kind}`, "primary", { draft: String(entry.index), suggestOpen: key });
    draft.dataset.testid = "usage-suggest-draft";
    if (!item.draftProjectId) { draft.disabled = true; draft.title = "Spread across projects: no project has three of them to cite."; }
    wrap.append(draft);
  } else if (type === "fix") {
    const open = button("See skill", "primary", { openSkillStats: item.name });
    open.dataset.testid = "usage-suggest-open";
    wrap.append(open);
  } else {
    const open = button(type === "merge" ? "Compare" : "Read it", type === "merge" ? "primary" : "", { openSkill: item.name });
    open.dataset.testid = "usage-suggest-open";
    wrap.append(open);
  }
  const dismiss = button(type === "remove" ? "Keep" : "Dismiss", "ghost", { suggestDismiss: key });
  dismiss.dataset.testid = "usage-suggest-dismiss";
  dismiss.title = "Hide this suggestion until the page reloads";
  wrap.append(dismiss);
  return wrap;
}

function evidence(entry) {
  const { type, item } = entry;
  const wrap = node("div", undefined, "usage-suggest-evidence");
  if (type !== "new") {
    const facts = [count(item.turns, "turn"), item.lastUsedAt ? `last used ${dateFormat.format(new Date(item.lastUsedAt))}` : "never loaded", item.turns ? money(item.knownCostUsd) : ""].filter(Boolean).join(" · ");
    wrap.append(node("p", facts, "usage-suggest-note"));
    if (item.other) wrap.append(button(`Read ${item.other}`, "ghost", { openSkill: item.other }));
    return wrap;
  }
  const list = node("div");
  list.append(node("h6", "Conversations it is based on"));
  const rows = node("ul", undefined, "usage-suggest-examples");
  for (const example of item.examples.slice(0, 3)) {
    const line = node("li");
    line.title = `${example.projectName}\n${example.title}`;
    line.append(node("span", example.title), node("small", example.projectName), node("b", money(example.knownCostUsd)));
    rows.append(line);
  }
  list.append(rows);
  if (item.conversations > item.examples.length) list.append(node("p", `and ${count(item.conversations - Math.min(3, item.examples.length), "more conversation")}`, "usage-suggest-note"));
  const draft = node("div", undefined, "usage-suggest-draft");
  draft.append(node("p", item.draftProjectId
    ? `The draft cites ${count(item.draftEvidenceIds.length, "conversation")} in ${item.draftProjectName}. It is saved for you to read first; nothing is installed until you approve it.`
    : "Spread across projects: no project has three of these conversations to cite, so there is nothing to draft from yet.", "usage-suggest-note"));
  wrap.append(list, draft);
  return wrap;
}

function row(entry, open) {
  const article = node("article", undefined, `usage-suggest-row${open ? " open" : ""}`);
  article.dataset.testid = "usage-suggest-item";
  article.dataset.type = entry.type;
  article.dataset.key = entry.key;
  const parts = describe(entry);
  const label = node("span", parts.label, `usage-suggest-type ${entry.type}`);
  const main = node("div", undefined, "usage-suggest-main");
  const toggle = button("", "usage-suggest-toggle", { suggestOpen: entry.key });
  toggle.setAttribute("aria-expanded", String(open));
  toggle.append(parts.heading);
  main.append(toggle, ...parts.why);
  const impact = node("div", undefined, "usage-suggest-impact");
  impact.append(node("strong", parts.impact[0]), node("small", parts.impact[1]));
  article.append(label, main, impact, actions(entry));
  if (open) article.append(evidence(entry));
  return article;
}

/**
 * `entry` is the report's state: undefined or { loading } while it is read, then { value } or { error }.
 * `ui` holds the person's choices: { type, page, open, dismissed (Set), showDismissed, checkedAt }.
 */
export function renderSuggestions(entry, ranked, ui) {
  const root = node("div", undefined, "usage-suggest");
  const top = node("div", undefined, "usage-suggest-top");
  const run = button(entry?.value ? "↻ Check again" : "Find suggestions", "", { suggestRun: "" });
  run.dataset.testid = "usage-suggest-run";
  run.disabled = Boolean(entry?.loading);
  const source = node("span", entry?.loading ? "Looking through skill loads and conversation titles…" : ui.checkedAt ? `${checkedAgo(ui.checkedAt)}, from skill loads and conversation titles on this node` : "From skill loads and conversation titles on this node", "usage-suggest-source");
  if (!entry?.value) {
    top.append(source, run);
    root.append(top);
    if (entry?.error) root.append(node("p", `Suggestions unavailable: ${entry.error}`, "usage-error"));
    else root.append(skeleton(4, "usage-suggest-loading"));
    return root;
  }
  const visible = ranked.filter((item) => ui.showDismissed || !ui.dismissed.has(item.key));
  const total = visible.reduce((sum, item) => sum + item.cost, 0);
  const sum = node("div", undefined, "usage-suggest-sum");
  sum.append(node("strong", money(total)), node("small", `spent on the work behind ${count(visible.length, "suggestion")}`));
  const types = node("div", undefined, "usage-seg small");
  types.setAttribute("role", "group"); types.setAttribute("aria-label", "Kinds of suggestion");
  for (const [key, label] of TYPES) {
    const size = key === "all" ? visible.length : visible.filter((item) => item.type === key).length;
    if (key !== "all" && !size) continue;
    const choice = button(`${label} ${size}`, "", { suggestFilter: key });
    choice.dataset.testid = `usage-suggest-filter-${key}`;
    choice.setAttribute("aria-pressed", String(ui.type === key));
    types.append(choice);
  }
  top.append(sum, types, source, run);
  root.append(top);
  const rows = visible.filter((item) => ui.type === "all" || item.type === ui.type);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const current = Math.min(ui.page, pages);
  const list = node("div", undefined, "usage-suggest-list");
  list.dataset.testid = "usage-suggest-list";
  if (!rows.length) list.append(node("p", ranked.length ? "Nothing left here: every suggestion of this kind was dismissed." : "No suggestions: every installed skill is in use and looks distinct, and no kind of work keeps recurring.", "usage-split-empty"));
  for (const item of rows.slice((current - 1) * PAGE, current * PAGE)) list.append(row(item, ui.open === item.key));
  root.append(list);
  const foot = node("div", undefined, "usage-suggest-foot");
  const hiddenCount = ranked.filter((item) => ui.dismissed.has(item.key)).length;
  const summary = node("span", count(rows.length, "suggestion"));
  if (hiddenCount) {
    summary.append(` · ${hiddenCount.toLocaleString()} dismissed `);
    const toggle = button(ui.showDismissed ? "hide" : "show", "usage-link", { suggestShowDismissed: "" });
    toggle.dataset.testid = "usage-suggest-show-dismissed";
    summary.append(toggle);
  }
  foot.append(summary);
  if (pages > 1) {
    const pager = node("div", undefined, "usage-pagination");
    const previous = button("‹", "", { suggestPage: "-1" }), next = button("›", "", { suggestPage: "1" });
    previous.setAttribute("aria-label", "Previous page"); next.setAttribute("aria-label", "Next page");
    previous.disabled = current <= 1; next.disabled = current >= pages;
    pager.append(previous, node("span", `Page ${current} of ${pages}`), next);
    foot.append(pager);
  }
  root.append(foot);
  return root;
}

/**
 * The review-first draft form: save a draft, read the exact text, then approve to install it in
 * the project. Shared by suggestions here and by the repeated-work analysis.
 */
export function buildDraftForm({ project, kind, evidenceIds, name = "" }) {
  const form = node("form", undefined, "usage-analysis-draft");
  const input = node("input"); input.name = "name"; input.placeholder = "new-skill-name"; input.required = true; input.pattern = "[a-z][a-z0-9-]{1,59}"; input.value = name; input.dataset.testid = "usage-draft-name";
  const contents = node("textarea"); contents.name = "content"; contents.placeholder = "Write instructions or a script after reviewing the evidence (20–10000 characters)."; contents.required = true; contents.minLength = 20; contents.maxLength = 10000; contents.dataset.testid = "usage-draft-content";
  const save = node("button", "Save draft for review", "ghost"); save.type = "submit"; save.dataset.testid = "usage-draft-save";
  form.append(input, contents, save);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    save.disabled = true;
    try {
      const draft = await api("/api/usage/analysis/drafts", { method: "POST", body: JSON.stringify({ projectId: project, name: input.value, kind, content: contents.value, evidenceConversationIds: evidenceIds }) });
      const review = node("pre", draft.content); review.dataset.testid = "usage-draft-review";
      const install = node("button", "Approve and install locally", "ghost"); install.type = "button"; install.dataset.testid = "usage-draft-approve";
      form.replaceChildren(node("p", `Draft saved. Review exact content below. SHA-256: ${draft.reviewedSha256}. Never shared automatically.`), review, install);
      install.addEventListener("click", async () => {
        if (!await confirmAction({ title: `Install reviewed ${draft.kind} ${draft.name} in this project?`, confirmLabel: "Install locally" })) return;
        install.disabled = true;
        try {
          const result = await api(`/api/usage/analysis/drafts/${encodeURIComponent(draft.id)}/install`, { method: "POST", body: JSON.stringify({ approved: true, reviewedSha256: draft.reviewedSha256 }) });
          form.append(node("p", `Installed locally: ${result.path}. Sharing requires separate approval.`));
          install.remove();
        } catch (error) { form.append(node("p", `Installation failed: ${error.message}`)); install.disabled = false; }
      });
    } catch (error) { form.append(node("p", `Draft unavailable: ${error.message}`)); save.disabled = false; }
  });
  return form;
}
