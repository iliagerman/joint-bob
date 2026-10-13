import { api } from "./api.js";
import { confirmAction } from "./shell.js";
import { money } from "./usage-insight-data.js";

/**
 * The Suggestions view of the Skills & time tab: installed skills to remove or review, and kinds
 * of work that keep recurring with no skill for them. Nothing is read until the person asks, and
 * nothing is installed or removed: a draft is saved for review and installed only after approval.
 */

export const PAGE = 3;
const KINDS = { unused: "Unused", overlap: "Overlaps", failing: "Fails often" };
const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

function node(tag, text, className) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (className) item.className = className;
  return item;
}
const count = (value, noun) => `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;

/** A file-safe skill name for a phrase, or "" when the phrase has letters a name cannot hold. */
export function suggestedName(phrase) {
  const name = phrase.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 59);
  return /^[a-z][a-z0-9-]{1,59}$/.test(name) ? name : "";
}

function removalCard(item, index) {
  const card = node("article", undefined, "usage-suggest-card");
  card.dataset.testid = "usage-suggest-removal";
  const head = node("header");
  head.append(node("strong", item.name), node("span", KINDS[item.kind], `usage-suggest-kind ${item.kind}`));
  const facts = [count(item.turns, "turn"), item.lastUsedAt ? `last used ${dateFormat.format(new Date(item.lastUsedAt))}` : "never loaded", item.turns ? money(item.knownCostUsd) : ""].filter(Boolean).join(" · ");
  const actions = node("div", undefined, "usage-suggest-actions");
  const view = node("button", "Read it", "ghost");
  view.type = "button"; view.dataset.openSkill = item.name; view.dataset.testid = "usage-suggest-open";
  actions.append(view);
  if (item.other) {
    const other = node("button", `Read ${item.other}`, "ghost");
    other.type = "button"; other.dataset.openSkill = item.other;
    actions.append(other);
  }
  card.append(head, node("p", item.reason), node("small", facts), actions);
  card.dataset.index = String(index);
  return card;
}

function creationCard(item, index) {
  const card = node("article", undefined, "usage-suggest-card");
  card.dataset.testid = "usage-suggest-creation";
  const head = node("header");
  head.append(node("strong", item.phrase), node("span", `${item.kind} · ${Math.round(item.confidence * 100)}%`, "usage-suggest-kind"));
  card.append(head);
  if (item.coveredBy) {
    const covered = node("p", undefined, "usage-suggest-note");
    const link = node("button", item.coveredBy, "usage-link");
    link.type = "button"; link.dataset.openSkill = item.coveredBy;
    covered.append("May already be covered by ", link, ".");
    card.append(covered);
  }
  card.append(node("small", [count(item.conversations, "conversation"), count(item.projects, "project"), count(item.days, "day"), money(item.knownCostUsd)].join(" · ")));
  const examples = node("ul", undefined, "usage-suggest-examples");
  for (const example of item.examples.slice(0, 3)) {
    const line = node("li", example.title);
    line.title = `${example.projectName}\n${example.title}`;
    examples.append(line);
  }
  card.append(examples);
  const actions = node("div", undefined, "usage-suggest-actions");
  if (item.draftProjectId) {
    const draft = node("button", `Draft a ${item.kind}`, "ghost");
    draft.type = "button"; draft.dataset.draft = String(index); draft.dataset.testid = "usage-suggest-draft";
    draft.title = `Cites ${item.draftEvidenceIds.length} of these conversations in ${item.draftProjectName}`;
    actions.append(draft);
  } else actions.append(node("small", "Spread across projects: no project has three of them to cite.", "usage-suggest-note"));
  card.append(actions);
  return card;
}

function column(title, hint, items, card, key, page, empty) {
  const section = node("section", undefined, "usage-suggest-column");
  section.dataset.testid = `usage-suggest-${key}`;
  const head = node("header");
  head.append(node("h4", `${title} `), node("small", hint));
  head.firstChild.append(node("span", String(items.length), "usage-suggest-count"));
  const pages = Math.max(1, Math.ceil(items.length / PAGE));
  const current = Math.min(page, pages);
  const list = node("div", undefined, "usage-suggest-cards");
  if (!items.length) list.append(node("p", empty, "usage-split-empty"));
  items.slice((current - 1) * PAGE, current * PAGE).forEach((item, offset) => list.append(card(item, (current - 1) * PAGE + offset)));
  section.append(head, list);
  if (pages > 1) {
    const pager = node("div", undefined, "usage-pagination");
    const previous = node("button", "Previous"), next = node("button", "Next");
    previous.type = next.type = "button";
    previous.dataset.suggestPage = `${key}:-1`; next.dataset.suggestPage = `${key}:1`;
    previous.disabled = current <= 1; next.disabled = current >= pages;
    pager.append(previous, node("span", `Page ${current} of ${pages}`), next);
    section.append(pager);
  }
  return section;
}

/** `entry` is the tab's state: undefined before the person asks, then { loading }, { value } or { error }. */
export function renderSuggestions(entry, pages) {
  const root = node("div", undefined, "usage-suggest");
  const intro = node("div", undefined, "usage-suggest-intro");
  intro.append(node("p", "Looks at which skills agents load and at the titles of your conversations, on this node only: no model, no transcript text. Skills to remove are judged over all recorded usage, and ideas for new skills follow the filters above. It only suggests; nothing is installed or removed."));
  const run = node("button", entry?.value ? "Look again" : "Find suggestions");
  run.type = "button"; run.dataset.suggestRun = ""; run.dataset.testid = "usage-suggest-run";
  run.disabled = Boolean(entry?.loading);
  intro.append(run);
  root.append(intro);
  if (!entry) return root;
  if (entry.loading) { root.append(node("p", "Looking through usage and conversation titles…")); return root; }
  if (entry.error) { root.append(node("p", `Suggestions unavailable: ${entry.error}`, "usage-error")); return root; }
  const { removals, creations, installedSkills, conversationsConsidered, truncated } = entry.value;
  const grid = node("div", undefined, "usage-suggest-grid");
  grid.append(
    column("Skills to remove or review", `${count(installedSkills, "installed skill")} checked`, removals, removalCard, "removals", pages.removals, "Every installed skill has been loaded recently and looks distinct."),
    column("Skills worth adding", `${count(conversationsConsidered, "conversation")} considered${truncated ? ", the costliest" : ""}`, creations, creationCard, "creations", pages.creations, "No kind of work recurs in at least three conversations on two different days."),
  );
  root.append(grid);
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
