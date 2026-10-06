import { api } from "./api.js";
import { openDiffDialog } from "./git-diff-view.js";
import { h, s } from "./git-story-dom.js";
import { diagramLegend, mountStoryDiagram } from "./git-story-diagram.js";
import { toast } from "./shell.js";

// A change story explains a conversation's commits and pending files. A separate read-only
// reviewer writes it; nothing here is posted to the conversation.
const story = {
  ctx: null,
  state: "idle",
  latest: null,
  previous: null,
  commits: [],
  error: "",
  request: 0,
  section: "overview",
  phase: 0,
  example: 0,
  step: 0,
  implTab: "components",
  pages: {},
  jumpPhase: false,
  // Picking commits from history instead of explaining the conversation.
  picking: false,
  pick: { tab: "pushes", pushes: null, history: null, error: "", selected: new Map(), typed: "", typedError: "", adding: false },
};

const PICK_LIMIT = 20;

const SECTIONS = [
  { id: "overview", title: "Overview", sub: "What it is and how it flows" },
  { id: "conversation", title: "Conversation", sub: "How the change evolved" },
  { id: "examples", title: "Examples", sub: "How the app behaves" },
  { id: "implementation", title: "Implementation", sub: "What changed in the code" },
];
const EXAMPLE_TONE = { "Happy path": "is-accent", "Edge case": "is-amber", Failure: "is-danger", Navigation: "is-info" };
const sum = (values) => values.reduce((total, value) => total + value, 0);
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

function relativeTime(iso) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function clock(iso) {
  const date = iso ? new Date(iso) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
}

const turnsLabel = (turns) => turns.length > 1 ? `Turns ${turns[0]}-${turns.at(-1)}` : `Turn ${turns[0]}`;

/** Called when the Git view opens, so a story never leaks between conversations. */
export function resetStory(ctx) {
  story.ctx = ctx;
  story.state = "idle";
  story.latest = null;
  story.previous = null;
  story.commits = [];
  story.error = "";
  story.request += 1;
  story.section = "overview";
  story.phase = 0;
  story.example = 0;
  story.step = 0;
  story.implTab = "components";
  story.pages = {};
  story.picking = false;
  story.pick = { tab: "pushes", pushes: null, history: null, error: "", selected: new Map(), typed: "", typedError: "", adding: false };
}

export function storyCommitCount() { return story.commits.length; }
export function storyIsFresh() { return Boolean(story.latest?.freshness.fresh); }
export function storyHasSaved() { return Boolean(story.latest); }
export function storyPicking() { return story.picking; }
export function storyFromCommits() { return story.latest?.saved.sources.kind === "commits"; }
/** The commits to explain on Generate: picked ones, or the shown commits story's own when regenerating it. */
export function storyCommitsToExplain() {
  if (story.picking) return [...story.pick.selected.keys()];
  return storyFromCommits() && story.state !== "empty" ? story.latest.saved.sources.commits : null;
}
export function storyHidesScope() { return story.picking || storyFromCommits(); }

/** Label and status text for the shared reviewer bar while the Story tab is open. */
export function storyChrome() {
  const freshness = story.latest?.freshness;
  if (story.state === "writing") return { button: "Writing…", disabled: true, status: "Writing the story. The reviewer reads but never edits. This can take a few minutes." };
  if (story.state === "loading" || story.state === "idle") return { button: "Generate story", disabled: true, status: "Loading the saved story…" };
  if (story.picking && story.state !== "rejected") {
    const count = story.pick.selected.size;
    return { button: count ? `Generate story for ${plural(count, "commit")}` : "Generate story", disabled: !count, status: "The story explains the picked commits from their messages and diffs, without this conversation. Nothing is posted to the chat." };
  }
  if (story.state === "rejected") return { button: "Try again", disabled: false, status: story.latest ? "Nothing was saved. Your previous story is still available." : "Nothing was saved." };
  if (story.state === "empty" || story.state === "error") return { button: "Generate story", disabled: false, status: "Stories are written in a separate read-only reviewer session. Nothing is posted to this conversation." };
  if (freshness && !freshness.fresh) return { button: "Regenerate story", disabled: false, status: "This story is outdated. Regenerate to include the latest turns and changes." };
  return { button: "Regenerate story", disabled: false, status: `Story saved until ${new Date(story.latest.thread.expiresAt).toLocaleDateString()}. A separate read-only reviewer wrote it. Nothing was posted to this conversation.` };
}

function changed() {
  story.ctx?.onChange();
  renderStory();
}

export async function loadStory(threadId) {
  const request = ++story.request;
  story.state = "loading";
  changed();
  try {
    const params = { conversationId: story.ctx.conversationId ?? undefined, threadId };
    const body = await api(story.ctx.apiUrl("story-latest", params));
    if (request !== story.request) return;
    story.commits = body.commits ?? [];
    story.latest = body.latest;
    story.state = body.latest ? "ready" : "empty";
    story.phase = 0;
    story.example = 0;
    story.step = 0;
    story.pages = {};
  } catch (error) {
    if (request !== story.request) return;
    story.state = "error";
    story.error = error.message;
  }
  changed();
}

export async function generateStory(payload) {
  const request = ++story.request;
  story.state = "writing";
  story.error = "";
  changed();
  try {
    const body = await api(story.ctx.apiUrl("story"), { method: "POST", body: JSON.stringify(payload) });
    if (request !== story.request) return;
    story.latest = { thread: body.thread, saved: body.saved, freshness: body.freshness };
    story.state = "ready";
    story.picking = false;
    story.section = "overview";
    story.phase = 0;
    story.example = 0;
    story.step = 0;
    story.pages = {};
  } catch (error) {
    if (request !== story.request) return;
    story.state = "rejected";
    story.error = error.message;
  }
  changed();
}

/* ---- Paging: rows per page come from the height the list gets ---- */

function splitPages(items, available, heightOf, continuedHeader) {
  const pages = [];
  let page = [];
  let used = 0;
  items.forEach((item, index) => {
    const next = items[index + 1];
    // A group heading keeps its first row on the same page.
    const height = heightOf(item) + (item.type === "group" && next ? heightOf(next) : 0);
    if (page.length && used + height > available) {
      pages.push(page);
      page = [];
      used = 0;
      const header = continuedHeader?.(item);
      if (header) { page.push(header); used += heightOf(header); }
    }
    page.push(item);
    used += heightOf(item);
  });
  if (page.length) pages.push(page);
  return pages;
}

function pager(key, index, count, text, rerender) {
  return h("div", { class: "gs-pager" },
    h("button", { class: "ghost compact gs-boxed", type: "button", disabled: index === 0, onclick: () => { story.pages[key] = index - 1; rerender(); } }, "‹ Previous"),
    h("span", { title: `Page ${index + 1} of ${count}` }, text),
    h("button", { class: "ghost compact gs-boxed", type: "button", disabled: index === count - 1, onclick: () => { story.pages[key] = index + 1; rerender(); } }, "Next ›"));
}

function pagedList(box, key, items, heightOf, renderItem, noun, continuedHeader, jumpTo) {
  box.replaceChildren();
  if (!items.length) return;
  const rows = h("div", { class: "gs-paged-rows" });
  box.append(rows, h("div", { class: "gs-pager" }));
  const available = Math.max(heightOf(items[0]), rows.clientHeight);
  const pages = splitPages(items, available, heightOf, continuedHeader);
  story.pages[key] = Math.min(story.pages[key] ?? 0, pages.length - 1);
  if (jumpTo) {
    const found = pages.findIndex((page) => page.some(jumpTo));
    if (found >= 0) story.pages[key] = found;
  }
  const index = story.pages[key];
  rows.append(...pages[index].map(renderItem));
  box.lastChild.remove();
  if (pages.length < 2) return;
  const counted = (list) => list.filter((item) => item.type !== "group").length;
  const before = sum(pages.slice(0, index).map(counted));
  box.append(pager(key, index, pages.length, `${before + 1}-${before + counted(pages[index])} of ${counted(items)}${noun ? ` ${noun}` : ""}`, () => pagedList(box, key, items, heightOf, renderItem, noun, continuedHeader)));
}

/* ---- Links out of the story ---- */

function fileFact(path) {
  return story.latest?.saved.facts.files.find((file) => file.path === path);
}

function showDiff(path) {
  const { saved } = story.latest;
  const file = fileFact(path);
  const commits = new Map(saved.facts.commits.map((commit) => [commit.shortHash, commit]));
  openDiffDialog({
    title: path,
    meta: file ? `${file.kind} · +${file.add} −${file.del} · ${file.where.map((where) => where === "pending" ? "pending" : where).join(", ")}` : "",
    sections: saved.patches.filter((patch) => patch.path === path).map((patch) => ({
      label: patch.source === "pending" ? "Pending, not committed" : `Commit ${patch.source}${commits.get(patch.source) ? ` · ${commits.get(patch.source).subject}` : ""}`,
      patch: patch.patch,
    })),
  });
}

function fileLine(path, kind = fileFact(path)?.kind ?? "modified") {
  return h("div", { class: "gs-file-line" },
    h("span", { class: `git-review-kind is-${kind}` }, kind),
    h("code", { title: path }, path),
    h("button", { class: "gs-link", type: "button", "data-testid": "git-story-show-diff", onclick: () => showDiff(path) }, "Show diff"));
}

const normalize = (text) => text.replace(/\s+/g, " ").trim();

// Chat bubbles carry no message id, so the turn's user bubble is found by its text.
function revealTurn(n) {
  const turn = story.latest.saved.facts.turns.find((item) => item.n === n);
  const needle = normalize(turn?.user ?? "").slice(0, 80);
  const bubble = needle && [...document.querySelectorAll("#messages .message.user .message-content")].find((content) => normalize(content.textContent).includes(needle))?.closest(".message");
  if (!bubble) { toast(`Turn ${n} is not loaded in the chat. Scroll up in the conversation to load earlier messages.`, 6000); return; }
  story.ctx.closeDialog();
  bubble.scrollIntoView({ block: "center", behavior: "smooth" });
  bubble.classList.add("gs-flash");
  setTimeout(() => bubble.classList.remove("gs-flash"), 2400);
}

/* ---- Rendering ---- */

export function renderStory() {
  const container = story.ctx?.container;
  if (!container || container.hidden) return;
  container.replaceChildren();
  if (story.state === "idle" || story.state === "loading") { container.append(loadingPanel("Loading the saved story…")); return; }
  if (story.state === "writing") { container.append(writingPanel()); return; }
  if (story.state === "rejected") { container.append(errorPanel("Story rejected", story.error, true)); return; }
  if (story.picking) { renderPicker(container); return; }
  if (story.state === "empty") { container.append(emptyPanel()); return; }
  if (story.state === "error") { container.append(errorPanel("Could not load the story", story.error, false)); return; }
  const { freshness } = story.latest;
  container.append(freshness.fresh ? h("div") : outdatedBanner(freshness), storyHead(), storyBody());
  renderSection();
}

function loadingPanel(message) {
  return h("div", { class: "gs-state" }, h("div", { class: "git-review-loading", role: "status" },
    h("div", { class: "git-review-loading-head" }, h("span", { class: "git-review-spinner", "aria-hidden": "true" }), h("span", {}, message)),
    [1, 2, 3, 4].map(() => h("span", { class: "git-review-skeleton", "aria-hidden": "true" }))));
}

function writingPanel() {
  return h("div", { class: "gs-state" }, h("div", { class: "gs-state-card", "data-testid": "git-story-writing" },
    h("div", { class: "git-review-loading-head" }, h("span", { class: "git-review-spinner", "aria-hidden": "true" }), h("h3", {}, "Writing the story")),
    h("p", {}, story.picking ? "The reviewer reads the picked commits in a separate session with every tool turned off. Then the server checks every file and diagram step the story mentions." : "The reviewer reads this conversation and its changes in a separate session with every tool turned off. Then the server checks every file, turn and diagram step the story mentions."),
    h("p", { class: "gs-state-note" }, "Nothing is posted to the chat while this runs. You can close the Git view; the story is saved when it finishes.")));
}

function emptyPanel() {
  const part = (n, title, text) => h("li", {}, h("span", { class: "gs-rail-num" }, String(n)), h("span", {}, h("b", {}, `${title}. `), text));
  return h("div", { class: "gs-state" }, h("div", { class: "gs-state-card", "data-testid": "git-story-empty" },
    h("h3", {}, "No story yet"),
    h("p", {}, "A story explains these changes without the diff. It has four parts."),
    h("ul", { class: "gs-parts" },
      part(1, "Overview", "What changed, why, and a flow diagram."),
      part(2, "Conversation", "The turns that shaped the change, with commits and changes of direction."),
      part(3, "Examples", "Step-by-step walkthroughs of how the app behaves."),
      part(4, "Implementation", "Files by area, key decisions, what to check, and tests.")),
    h("div", { class: "gs-state-actions" },
      h("button", { class: story.ctx.hasCoverage() ? "primary" : "ghost gs-boxed", type: "button", "data-testid": "git-story-generate", disabled: !story.ctx.hasCoverage(), onclick: () => story.ctx.generate() }, "Generate story"),
      h("span", { class: "gs-muted" }, story.ctx.coverage())),
    h("div", { class: "gs-state-actions" },
      h("button", { class: story.ctx.hasCoverage() ? "ghost gs-boxed" : "primary", type: "button", "data-testid": "git-story-pick", onclick: openPicker }, "Pick past commits or pushes"),
      h("span", { class: "gs-muted" }, "Explain work that is already committed or pushed.")),
    h("p", { class: "gs-state-note" }, "Written in a separate read-only reviewer session with the reviewer picked below. Nothing is posted to this conversation.")));
}

function errorPanel(title, message, offerRetry) {
  return h("div", { class: "gs-state" }, h("div", { class: "gs-state-card is-error", role: "alert", "data-testid": "git-story-rejected" },
    h("h3", {}, title),
    h("p", {}, message || "The story could not be written."),
    h("div", { class: "gs-state-actions" },
      h("button", { class: "primary", type: "button", onclick: () => offerRetry ? story.ctx.generate() : loadStory() }, "Try again"),
      offerRetry ? h("button", { class: "ghost gs-boxed", type: "button", onclick: () => story.ctx.focusReviewer() }, "Use another reviewer") : null,
      offerRetry && story.picking ? h("button", { class: "ghost gs-boxed", type: "button", onclick: () => { story.state = story.latest ? "ready" : "empty"; changed(); } }, "Change commits") : null),
    story.latest ? h("p", { class: "gs-state-note" }, `Your previous story from ${relativeTime(story.latest.thread.createdAt)} is still available. `,
      h("button", { class: "gs-link", type: "button", onclick: () => { story.state = "ready"; story.picking = false; changed(); } }, "Show it")) : null));
}

function outdatedBanner(freshness) {
  const parts = [];
  if (freshness.newTurns) parts.push(`${freshness.newTurns} new turn${freshness.newTurns === 1 ? "" : "s"}`);
  if (freshness.changedPaths.length) parts.push(`${freshness.changedPaths.length} changed file${freshness.changedPaths.length === 1 ? "" : "s"}`);
  return h("div", { class: "gs-banner", role: "status", "data-testid": "git-story-outdated" },
    h("b", {}, "Outdated"),
    h("span", {}, freshness.reason ?? `${parts.join(" and ") || "The sources changed"} since this story was written ${relativeTime(story.latest.thread.createdAt)}.`),
    freshness.changedPaths.length ? h("span", { class: "gs-muted", title: freshness.changedPaths.join("\n") }, `Changed: ${freshness.changedPaths.slice(0, 3).join(", ")}${freshness.changedPaths.length > 3 ? ` and ${freshness.changedPaths.length - 3} more` : ""}.`) : null,
    h("span", { class: "gs-spacer" }),
    h("button", { class: "primary compact", type: "button", onclick: () => story.ctx.generate() }, "Regenerate"));
}

function storyHead() {
  const { saved, thread, freshness } = story.latest;
  const { facts } = saved;
  const pending = facts.files.filter((file) => file.where.includes("pending")).length;
  return h("header", { class: "gs-head" },
    h("div", { class: "gs-title" }, h("span", { class: "gs-pill is-accent" }, saved.story.kind), h("h3", { "data-testid": "git-story-title" }, saved.story.title)),
    h("div", { class: "gs-actions" },
      h("span", { class: freshness.fresh ? "gs-pill is-accent" : "gs-pill is-amber" }, freshness.fresh ? "Fresh" : "Outdated"),
      storyFromCommits() && story.ctx.conversationId ? h("button", { class: "ghost compact gs-boxed", type: "button", "data-testid": "git-story-explain-conversation", onclick: () => story.ctx.generate({ conversation: true }) }, "Explain this conversation") : null,
      h("button", { class: "ghost compact gs-boxed", type: "button", "data-testid": "git-story-pick", onclick: openPicker }, "Explain other commits"),
      h("button", { class: "ghost compact gs-boxed", type: "button", onclick: copyMarkdown }, "Copy as Markdown")),
    h("p", { class: "gs-facts" },
      h("b", {}, `${facts.files.length} file${facts.files.length === 1 ? "" : "s"}`), " · ",
      h("span", { class: "gs-add" }, `+${sum(facts.files.map((file) => file.add)).toLocaleString()}`), " ",
      h("span", { class: "gs-del" }, `−${sum(facts.files.map((file) => file.del)).toLocaleString()}`), " · ",
      storyFromCommits() ? `${plural(facts.commits.length, "picked commit")}` : `${plural(facts.commits.length, "commit")} + ${plural(pending, "pending file")}`,
      facts.conversation ? ` · ${facts.turns.length} turns` : "",
      facts.omitted?.length ? h("span", { class: "gs-del", "data-testid": "git-story-omitted", title: `The reviewer saw only line counts for: ${facts.omitted.join(", ")}` }, ` · ${plural(facts.omitted.length, "diff")} too large to read`) : "",
      ` · ${thread.harnessId} · ${thread.modelId} · ${thread.thinkingLevel} · written ${relativeTime(thread.createdAt)}`));
}

function storySections() {
  return storyFromCommits() ? SECTIONS.map((section) => section.id === "conversation" ? { ...section, title: "Commits", sub: "What each commit did" } : section) : SECTIONS;
}

function storyBody() {
  const rail = h("nav", { class: "gs-rail", role: "tablist", "aria-label": "Story sections", "aria-orientation": "vertical" },
    storySections().map((section, index, sections) => h("button", {
      class: "gs-rail-item", type: "button", role: "tab", id: `gitStoryRail-${section.id}`, "data-testid": `git-story-section-${section.id}`,
      "aria-selected": String(story.section === section.id), tabindex: story.section === section.id ? "0" : "-1",
      onclick: () => { story.section = section.id; renderStory(); document.getElementById(`gitStoryRail-${section.id}`)?.focus(); },
      onkeydown: (event) => {
        const move = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
        if (!move) return;
        event.preventDefault();
        story.section = sections[(index + move + sections.length) % sections.length].id;
        renderStory();
        document.getElementById(`gitStoryRail-${story.section}`)?.focus();
      },
    }, h("span", { class: "gs-rail-num" }, String(index + 1)), h("span", {}, h("b", {}, section.title), h("small", {}, section.sub)))),
    h("p", { class: "gs-rail-foot" }, `Read only. Nothing here was posted to the chat. Saved until ${new Date(story.latest.thread.expiresAt).toLocaleDateString()}.`));
  return h("div", { class: "gs-body" }, rail, h("section", { class: "gs-section", id: "gitStorySection", role: "tabpanel", "aria-labelledby": `gitStoryRail-${story.section}`, "data-testid": "git-story-panel" }));
}

function renderSection() {
  const section = story.ctx.container.querySelector("#gitStorySection");
  if (!section) return;
  section.replaceChildren();
  ({ overview: renderOverview, conversation: renderConversation, examples: renderExamples, implementation: renderImplementation })[story.section](section);
}

export function refitStory() {
  if (!story.ctx?.container || story.ctx.container.hidden) return;
  if (story.picking && story.state !== "writing" && story.state !== "rejected") renderStory();
  else if (story.state === "ready") renderSection();
}

function sectionHead(title, hint) {
  return h("div", { class: "gs-section-head" }, h("h4", {}, title), hint ? h("span", { class: "gs-hint" }, hint) : null);
}

function renderOverview(section) {
  const { overview, diagram } = story.latest.saved.story;
  const card = (label, body) => h("div", { class: "gs-card" }, h("p", { class: "gs-label" }, label), body);
  const canvas = h("div", { class: "gs-canvas" });
  const wrap = h("div", { class: "gs-diagram" }, canvas, diagramLegend(diagram));
  section.append(
    h("div", { class: "gs-explain" },
      card("What changed", h("p", {}, overview.what)),
      card("Why", h("p", {}, overview.why)),
      card("What you will notice", h("ul", {}, overview.notice.map((text) => h("li", {}, text))))),
    overview.unchanged ? h("p", { class: "gs-unchanged" }, overview.unchanged) : null,
    sectionHead("How it flows", "Click a step to see what it does and which files implement it."),
    wrap);
  mountStoryDiagram(wrap, canvas, diagram, { fileLine });
}

function phaseFiles(phase) {
  const { turns } = story.latest.saved.facts;
  return [...new Set(phase.turns.flatMap((n) => turns.find((turn) => turn.n === n)?.paths ?? []))];
}

function phaseCommits(phase) {
  return story.latest.saved.facts.commits.filter((commit) => phase.turns.includes(commit.turn));
}

function selectPhase(index) {
  story.phase = index;
  story.jumpPhase = true;
  renderSection();
}

function renderCommitsSection(section) {
  const { facts } = story.latest.saved;
  const box = h("div", { class: "gs-paged gs-impl" });
  section.append(sectionHead("Commits in this story", `${plural(facts.commits.length, "commit")}, oldest first. There is no conversation behind this story.`), box);
  pagedList(box, "story-commits", facts.commits, () => 44, (commit) => h("div", { class: "gs-check-row gs-commit-row", "data-testid": "git-story-commit" },
    h("span", { class: "gs-where" }, commit.shortHash),
    h("span", { class: "gs-text", title: commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject }, commit.subject),
    h("span", { class: "gs-muted gs-small" }, commit.date ? relativeTime(commit.date) : "")), "commits");
}

function renderConversation(section) {
  const { saved } = story.latest;
  const { facts, story: written } = saved;
  if (saved.sources.kind === "commits") { renderCommitsSection(section); return; }
  if (!facts.conversation || !written.timeline.length) {
    section.append(sectionHead("How the change evolved"), h("p", { class: "gs-muted" }, facts.conversation ? "The reviewer did not describe the conversation's turns." : "No conversation is selected, so this story covers pending changes only. The why comes from the diff alone."));
    return;
  }
  story.phase = Math.min(story.phase, written.timeline.length - 1);
  const first = facts.turns[0];
  const last = facts.turns.at(-1);
  const strip = h("div", { class: "gs-strip" });
  const listBox = h("div", { class: "gs-paged" });
  const detail = h("div", { class: "gs-phase-detail" });
  section.append(
    sectionHead("How the change evolved", h("span", {},
      `${facts.turns.length} turns${first?.at && last?.at ? `, ${clock(first.at)} to ${clock(last.at)}` : ""} · ${plural(facts.commits.length, "commit")} · ${plural(written.timeline.filter((phase) => phase.pivot).length, "change", "changes")} of direction · `,
      h("span", { style: "color:var(--gs-info)" }, "◆"), " commit ", h("span", { style: "color:var(--amber)" }, "▲"), " change of direction ", h("span", { style: "color:var(--accent)" }, "▮"), " files touched")),
    strip,
    h("div", { class: "gs-convo" }, listBox, detail));
  drawStrip(strip);
  const jump = story.jumpPhase ? (item) => item.index === story.phase : null;
  story.jumpPhase = false;
  pagedList(listBox, "phases", written.timeline.map((phase, index) => ({ phase, index })), () => 62, phaseRow, "steps", null, jump);
  fillPhaseDetail(detail);
}

function drawStrip(box) {
  const { facts, story: written } = story.latest.saved;
  const width = box.clientWidth;
  const height = box.clientHeight;
  const turns = facts.turns;
  if (!width || !height || !turns.length) return;
  const padX = 44;
  const x = (n) => turns.length === 1 ? width / 2 : padX + (width - padX * 2) * ((n - 1) / (turns.length - 1));
  const gap = turns.length > 1 ? (width - padX * 2) / (turns.length - 1) : width;
  const axisY = 33;
  const radius = gap >= 22 ? 9 : 4;
  const maxFiles = Math.max(1, ...turns.map((turn) => turn.paths.length));
  const phaseOf = (n) => written.timeline.findIndex((phase) => phase.turns.includes(n));
  const pivots = new Set(written.timeline.filter((phase) => phase.pivot).map((phase) => phase.turns[0]));
  const svg = s("svg", { viewBox: `0 0 ${width} ${height}`, role: "group", "aria-label": "Turns of this conversation" },
    s("line", { class: "axis", x1: padX - 20, x2: width - padX + 20, y1: axisY, y2: axisY }));
  written.timeline.forEach((phase, index) => {
    const x1 = x(Math.min(...phase.turns)) - radius - 5;
    const x2 = x(Math.max(...phase.turns)) + radius + 5;
    svg.append(s("rect", { class: `span${index === story.phase ? " is-active" : ""}`, x: x1, y: axisY - 13, width: x2 - x1, height: 26, rx: 13, onclick: () => selectPhase(index) }));
  });
  let lastLabel = -Infinity;
  for (const turn of turns) {
    const phaseIndex = phaseOf(turn.n);
    const active = phaseIndex === story.phase;
    const cx = x(turn.n);
    if (turn.commits.length) svg.append(s("path", { class: "commit", d: `M${cx},2 l6,6 l-6,6 l-6,-6 z` }, s("title", { text: turn.commits.join(", ") })), gap >= 70 ? s("text", { class: "cap", x: cx + 9, y: 12, text: turn.commits[0] }) : null);
    if (pivots.has(turn.n)) svg.append(s("path", { class: "pivot", d: `M${cx},3 l6,10 h-12 z` }));
    if (turn.paths.length) svg.append(s("rect", { class: "bar", x: cx - 4, y: axisY + 14, width: 8, height: 3 + 10 * (turn.paths.length / maxFiles), rx: 2 }));
    svg.append(s("g", {
      tabindex: "0", role: "button", class: "turn-hit",
      "aria-label": `Turn ${turn.n}${turn.at ? ` at ${clock(turn.at)}` : ""}. ${turn.paths.length} changed files mentioned${turn.commits.length ? `. Commit ${turn.commits.join(", ")}` : ""}`,
      onclick: () => { if (phaseIndex >= 0) selectPhase(phaseIndex); },
      onkeydown: (event) => { if ((event.key === "Enter" || event.key === " ") && phaseIndex >= 0) { event.preventDefault(); selectPhase(phaseIndex); } },
    },
      s("circle", { class: `turn${active ? " is-active" : ""}`, cx, cy: axisY, r: radius }),
      radius > 4 ? s("text", { class: "turn-n", x: cx, y: axisY + 3.5, "text-anchor": "middle", text: String(turn.n), style: active ? "fill:var(--on-ink)" : null }) : null));
    if (turn.at && cx - lastLabel >= 46) {
      svg.append(s("text", { class: "cap", x: cx, y: height - 3, "text-anchor": "middle", text: clock(turn.at) }));
      lastLabel = cx;
    }
  }
  box.replaceChildren(svg);
}

function phaseRow({ phase, index }) {
  const files = phaseFiles(phase);
  const commits = phaseCommits(phase);
  const chips = [];
  if (phase.quiet) chips.push(h("span", { class: "gs-pill" }, "No changes"));
  if (files.length) chips.push(h("span", { class: "gs-pill" }, `${files.length} file${files.length === 1 ? "" : "s"}`));
  for (const commit of commits.slice(0, 2)) chips.push(h("span", { class: "gs-where" }, commit.shortHash));
  if (phase.pivot) chips.push(h("span", { class: "gs-pill is-amber" }, "Changed direction"));
  const firstTurn = story.latest.saved.facts.turns.find((turn) => turn.n === phase.turns[0]);
  return h("button", {
    class: `gs-phase-row${index === story.phase ? " is-active" : ""}${phase.quiet ? " is-quiet" : ""}`, type: "button", "data-testid": "git-story-phase",
    "aria-current": index === story.phase ? "step" : null, onclick: () => { story.phase = index; renderSection(); },
  },
    h("span", { class: "gs-phase-when" }, phase.turns.length > 1 ? `T${phase.turns[0]}-${phase.turns.at(-1)}` : `T${phase.turns[0]}`, h("br"), clock(firstTurn?.at)),
    h("span", { class: "gs-min" }, h("span", { class: "gs-phase-title" }, phase.title), h("span", { class: "gs-phase-meta" }, chips)));
}

function fillPhaseDetail(detail) {
  const phase = story.latest.saved.story.timeline[story.phase];
  const facts = story.latest.saved.facts;
  const firstTurn = facts.turns.find((turn) => turn.n === phase.turns[0]);
  const files = phaseFiles(phase);
  const commits = phaseCommits(phase);
  const list = (items, empty) => items.length ? h("ul", {}, items.map((text) => h("li", {}, text))) : h("p", { class: "gs-muted" }, empty);
  detail.replaceChildren(...[
    h("h5", {}, phase.title,
      h("span", { class: "gs-pill" }, `${turnsLabel(phase.turns)}${firstTurn?.at ? ` · ${clock(firstTurn.at)}` : ""}`),
      commits.map((commit) => h("span", { class: "gs-where gs-ellipsis", title: commit.subject }, `${commit.shortHash} ${commit.subject}`))),
    phase.pivot ? h("p", { class: "gs-pivot" }, h("b", {}, "Changed direction. "), phase.pivot) : null,
    h("div", {},
      h("p", { class: "gs-label" }, "You asked"), h("p", { class: "gs-asked" }, firstTurn?.user || "No message recorded."),
      h("p", { class: "gs-label gs-gap" }, "What the agent did"), list(phase.did, "")),
    h("div", {},
      h("p", { class: "gs-label" }, "Decided"), list(phase.decided, "No new decisions in this step."),
      h("p", { class: "gs-label gs-gap" }, `Files · ${files.length}`),
      files.length ? files.map((path) => fileLine(path)) : h("p", { class: "gs-muted" }, "No changed files mentioned in this step.")),
    h("div", { class: "gs-detail-actions" },
      h("button", { class: "ghost compact gs-boxed", type: "button", "data-testid": "git-story-open-turn", onclick: () => revealTurn(phase.turns[0]) }, `Open turn ${phase.turns[0]} in chat`)),
  ].filter(Boolean));
}

function traceFor(example, stepIndex) {
  const visited = { nodes: new Set(), edges: new Set() };
  for (const step of example.steps.slice(0, stepIndex)) {
    step.nodes.forEach((id) => visited.nodes.add(id));
    step.edges.forEach((id) => visited.edges.add(id));
  }
  const step = example.steps[stepIndex];
  if (!step.nodes.length && !visited.nodes.size) return null;
  return { visited, current: { nodes: new Set(step.nodes), edges: new Set(step.edges) } };
}

function renderExamples(section) {
  const { examples, diagram } = story.latest.saved.story;
  story.example = Math.min(story.example, examples.length - 1);
  story.step = Math.min(story.step, examples[story.example].steps.length - 1);
  const canvas = h("div", { class: "gs-canvas", style: "bottom:0" });
  const wrap = h("div", { class: "gs-diagram is-compact" }, canvas);
  const listBox = h("div", { class: "gs-paged" });
  const scenarioBox = h("div", { class: "gs-scenario" });
  const bottom = h("div", { class: "gs-examples" }, listBox, scenarioBox);
  section.append(sectionHead("How the app behaves", "Pick an example and step through it. The diagram lights up the current step."), wrap, bottom);
  fillScenario(scenarioBox);
  bottom.style.height = `${scenarioBox.offsetHeight}px`;
  pagedList(listBox, "examples", examples.map((example, index) => ({ example, index })), () => 54, scenarioRow, "");
  mountStoryDiagram(wrap, canvas, diagram, { trace: traceFor(examples[story.example], story.step), fileLine });
}

function scenarioRow({ example, index }) {
  return h("button", { class: `gs-scenario-row${index === story.example ? " is-active" : ""}`, type: "button", "data-testid": "git-story-example", onclick: () => { story.example = index; story.step = 0; renderSection(); } },
    h("b", {}, example.title),
    h("span", {}, h("span", { class: `gs-pill ${EXAMPLE_TONE[example.kind]}` }, example.kind), " ", h("span", { class: "gs-muted gs-small" }, plural(example.steps.length, "step"))));
}

function fillScenario(box) {
  const example = story.latest.saved.story.examples[story.example];
  const step = example.steps[story.step];
  const go = (index) => { story.step = index; renderSection(); };
  box.replaceChildren(
    h("div", { class: "gs-scenario-head" }, h("h5", {}, example.title), h("span", { class: `gs-pill ${EXAMPLE_TONE[example.kind]}` }, example.kind)),
    h("p", { class: "gs-scenario-start" }, h("b", {}, "Starting point. "), example.start),
    h("div", { class: "gs-steps" }, example.steps.map((item, index) => h("button", {
      class: `gs-step${index === story.step ? " is-current" : index < story.step ? " is-done" : ""}`, type: "button", "data-testid": "git-story-step",
      "aria-current": index === story.step ? "step" : null, onclick: () => go(index),
    },
      h("span", { class: "gs-step-n" }, `Step ${index + 1}`),
      item.you ? h("p", {}, h("span", { class: "gs-who" }, "You"), item.you) : null,
      h("p", {}, h("span", { class: "gs-who is-app" }, "App"), item.app)))),
    h("p", { class: "gs-says" }, h("span", {}, "On screen"), step.says ? h("q", {}, step.says) : h("span", { class: "gs-muted" }, "No new text on screen in this step.")),
    h("div", { class: "gs-scenario-foot" },
      h("p", { class: "gs-result" }, h("b", {}, "Result. "), example.result),
      h("span", { class: "gs-row" },
        h("button", { class: "ghost compact gs-boxed", type: "button", disabled: story.step === 0, onclick: () => go(story.step - 1) }, "‹ Previous step"),
        h("button", { class: "ghost compact gs-boxed", type: "button", disabled: story.step === example.steps.length - 1, onclick: () => go(story.step + 1) }, "Next step ›"))));
}

function renderImplementation(section) {
  const { facts, story: written } = story.latest.saved;
  const impl = written.implementation;
  const tabs = [
    { id: "components", label: "Components", count: facts.files.length },
    { id: "decisions", label: "Key decisions", count: impl.decisions.length },
    { id: "checks", label: "What to check", count: impl.checks.length },
    { id: "tests", label: "Tests", count: impl.tests.length },
  ];
  const box = h("div", { class: "gs-paged gs-impl" });
  section.append(
    sectionHead("What changed in the code", "Grouped by area. Show diff opens the change side by side."),
    h("div", { class: "gs-subtabs", role: "tablist", "aria-label": "Implementation views" }, tabs.map((tab) => h("button", {
      class: "gs-subtab", type: "button", role: "tab", "aria-selected": String(story.implTab === tab.id), "data-testid": `git-story-impl-${tab.id}`,
      onclick: () => { story.implTab = tab.id; renderSection(); },
    }, tab.label, h("span", { class: "gs-count" }, String(tab.count))))),
    box);
  if (story.implTab === "components") fillComponents(box);
  else if (story.implTab === "decisions") fillDecisions(box);
  else if (story.implTab === "checks") { if (impl.checks.length) pagedList(box, "checks", impl.checks, () => 44, checkRow, "checks"); else box.append(h("p", { class: "gs-muted" }, "The reviewer listed nothing to check.")); }
  else if (impl.tests.length) pagedList(box, "tests", impl.tests, () => 44, testRow, "tests");
  else box.append(h("p", { class: "gs-muted" }, "These changes add or change no tests."));
}

function fillComponents(box) {
  const { files } = story.latest.saved.facts;
  const items = [];
  for (const area of [...new Set(files.map((file) => file.area))]) {
    const inArea = files.filter((file) => file.area === area);
    items.push({ type: "group", area, count: inArea.length, add: sum(inArea.map((file) => file.add)), del: sum(inArea.map((file) => file.del)) });
    for (const file of inArea) items.push({ type: "file", file });
  }
  pagedList(box, "components", items, (item) => item.type === "group" ? 28 : 40, componentRow, "files",
    (item) => item.type === "file" ? { type: "group", area: item.file.area, continued: true } : null);
}

function componentRow(item) {
  if (item.type === "group") return h("div", { class: "gs-group-row" }, item.area, h("small", {}, item.continued ? "continued" : `${item.count} file${item.count === 1 ? "" : "s"} · +${item.add} −${item.del}`));
  const { file } = item;
  const what = story.latest.saved.story.implementation.what[file.path] ?? "";
  return h("div", { class: "gs-file-row", "data-testid": "git-story-file" },
    h("span", { class: `git-review-kind is-${file.kind}` }, file.kind),
    h("code", { title: file.path }, file.path),
    h("span", { class: "gs-what", title: what }, what),
    h("span", { class: "gs-stat" }, h("span", { class: "gs-add" }, `+${file.add}`), " ", h("span", { class: "gs-del" }, `−${file.del}`)),
    h("span", { class: "gs-wheres" }, file.where.map((where) => h("span", { class: `gs-where${where === "pending" ? " is-pending" : ""}` }, where))),
    h("button", { class: "gs-link", type: "button", "data-testid": "git-story-show-diff", onclick: () => showDiff(file.path) }, "Show diff"));
}

function fillDecisions(box) {
  const { decisions } = story.latest.saved.story.implementation;
  box.replaceChildren();
  if (!decisions.length) { box.append(h("p", { class: "gs-muted" }, "The reviewer recorded no decisions.")); return; }
  const rows = h("div", { class: "gs-paged-rows" });
  box.append(rows);
  const columns = rows.clientWidth < 700 ? 1 : 2;
  const perPage = columns * Math.max(1, Math.floor(((rows.clientHeight || 300) - 34 + 10) / 138));
  const pageCount = Math.ceil(decisions.length / perPage);
  story.pages.decisions = Math.min(story.pages.decisions ?? 0, pageCount - 1);
  const index = story.pages.decisions;
  const shown = decisions.slice(index * perPage, (index + 1) * perPage);
  rows.append(h("div", { class: "gs-decisions", style: `grid-template-columns:repeat(${columns}, minmax(0, 1fr))` }, shown.map((decision) => h("article", { class: "gs-decision" },
    h("h5", {}, decision.title),
    h("p", {}, decision.why),
    h("p", { class: "gs-instead" }, h("b", {}, "Instead of: "), decision.instead),
    decision.turn ? h("footer", {}, h("button", { class: "gs-link", type: "button", onclick: () => revealTurn(decision.turn) }, `Decided in turn ${decision.turn}`)) : null))));
  if (pageCount > 1) box.append(pager("decisions", index, pageCount, `${index * perPage + 1}-${index * perPage + shown.length} of ${decisions.length} decisions`, () => fillDecisions(box)));
}

function checkRow(check) {
  return h("div", { class: "gs-check-row" },
    h("span", { class: `gs-pill ${{ high: "is-danger", medium: "is-amber", low: "" }[check.priority]}` }, check.priority),
    h("span", { class: "gs-text", title: check.text }, check.text),
    check.file ? h("button", { class: "gs-link gs-ellipsis", type: "button", title: check.file, onclick: () => showDiff(check.file) }, check.file) : h("span"));
}

function testRow(item) {
  return h("div", { class: "gs-check-row" },
    h("span", { class: "gs-pill is-info" }, "test"),
    h("span", { class: "gs-text", title: item.name }, item.name),
    h("button", { class: "gs-link gs-ellipsis", type: "button", title: item.file, onclick: () => showDiff(item.file) }, item.file));
}

/* ---- Picking commits or pushes from history ---- */

function openPicker() {
  story.picking = true;
  story.pages.pick = 0;
  changed();
  if (!story.pick.pushes || !story.pick.history) void loadPickSources();
}

function closePicker() {
  story.picking = false;
  changed();
}

async function loadPickSources() {
  const request = story.request;
  story.pick.error = "";
  try {
    const [pushes, history] = await Promise.all([api(story.ctx.apiUrl("pushes")), api(story.ctx.apiUrl("history", { limit: 200 }))]);
    if (request !== story.request) return;
    story.pick.pushes = pushes.pushes;
    story.pick.history = history.commits;
    if (!pushes.pushes.length) story.pick.tab = "commits";
  } catch (error) {
    if (request !== story.request) return;
    story.pick.error = error.message;
  }
  changed();
}

function pickTab(tab) {
  story.pick.tab = tab;
  story.pages.pick = 0;
  changed();
}

/** Adds commits typed by hash; each is checked in Git, and the ones that fail stay in the box. */
async function addTyped(event) {
  event.preventDefault();
  const { pick } = story;
  const tokens = [...new Set(pick.typed.split(/[\s,]+/).filter(Boolean))];
  if (!tokens.length || pick.adding) return;
  const request = story.request;
  pick.adding = true;
  pick.typedError = "";
  changed();
  const failed = [];
  const reasons = [];
  for (const token of tokens) {
    if (!/^[0-9a-f]{4,40}$/i.test(token)) { failed.push(token); reasons.push(`${token} is not a commit hash`); continue; }
    if (pick.selected.size >= PICK_LIMIT) { failed.push(token); reasons.push(`a story covers at most ${PICK_LIMIT} commits`); continue; }
    try {
      const commit = await api(story.ctx.apiUrl("commit", { revision: token }));
      if (request !== story.request) return;
      pick.selected.set(commit.hash, { hash: commit.hash, shortHash: commit.shortHash, subject: commit.subject, author: commit.author, date: commit.date });
    } catch (error) {
      if (request !== story.request) return;
      failed.push(token);
      reasons.push(`${token}: ${error.message}`);
    }
  }
  pick.adding = false;
  pick.typed = failed.join(" ");
  pick.typedError = [...new Set(reasons)].join(". ");
  changed();
  story.ctx.container.querySelector("[data-testid='git-story-pick-hash']")?.focus();
}

function typedRow() {
  const { pick } = story;
  return h("form", { class: "gs-pick-type", "data-testid": "git-story-pick-type", onsubmit: addTyped },
    h("input", {
      type: "text", value: pick.typed, "data-testid": "git-story-pick-hash", "aria-label": "Commit hashes", spellcheck: "false", autocomplete: "off",
      placeholder: "Or type commit hashes, separated by spaces or commas", oninput: (event) => { pick.typed = event.target.value; },
    }),
    h("button", { class: "ghost compact gs-boxed", type: "submit", "data-testid": "git-story-pick-add", disabled: pick.adding }, pick.adding ? "Checking…" : "Add"),
    pick.typedError ? h("p", { class: "gs-del gs-small", role: "alert", "data-testid": "git-story-pick-type-error" }, pick.typedError) : null);
}

function setPicked(commits, on) {
  for (const commit of commits) {
    if (!on) story.pick.selected.delete(commit.hash);
    else if (story.pick.selected.size < PICK_LIMIT) story.pick.selected.set(commit.hash, commit);
  }
  changed();
  story.ctx.container.querySelector(`[data-pick="${CSS.escape(commits[0].hash)}"]`)?.focus();
}

function pickBox(commits, label) {
  const picked = commits.filter((commit) => story.pick.selected.has(commit.hash)).length;
  const box = h("input", {
    type: "checkbox", "aria-label": label, "data-testid": "git-story-pick-box", "data-pick": commits[0].hash,
    disabled: !picked && story.pick.selected.size + commits.length > PICK_LIMIT,
  });
  box.checked = picked === commits.length;
  box.indeterminate = picked > 0 && picked < commits.length;
  box.addEventListener("change", () => setPicked(commits, box.checked));
  return box;
}

function pushRow(push) {
  const count = `${push.commits.length}${push.more ? "+" : ""} commit${push.commits.length === 1 && !push.more ? "" : "s"}`;
  return h("label", { class: "gs-pick-row is-push", "data-testid": "git-story-push", title: push.more ? `This push carried more than ${PICK_LIMIT} commits; only the newest ${PICK_LIMIT} can be picked.` : null },
    pickBox(push.commits, `Push to ${push.ref}, ${relativeTime(push.at)}`),
    h("span", { class: "gs-min" },
      h("span", { class: "gs-pick-title" }, h("b", {}, `Pushed to ${push.ref}`), h("span", { class: "gs-muted" }, ` · ${relativeTime(push.at)} · ${count} · ${push.from ? `${push.from.slice(0, 7)}..` : ""}${push.to.slice(0, 7)}`)),
      h("span", { class: "gs-pick-sub" }, push.commits.map((commit) => commit.subject).join(" · "))));
}

function commitRow(commit) {
  return h("label", { class: "gs-pick-row", "data-testid": "git-story-pick-commit" },
    pickBox([commit], `${commit.shortHash} ${commit.subject}`),
    h("span", { class: "gs-where" }, commit.shortHash),
    h("span", { class: "gs-text", title: commit.subject }, commit.subject),
    h("span", { class: "gs-muted gs-small gs-ellipsis" }, `${commit.author} · ${relativeTime(commit.date)}`));
}

function renderPicker(container) {
  const { pick } = story;
  const list = h("div", { class: "gs-paged gs-pick-list" });
  const picked = [...pick.selected.values()];
  container.append(h("div", { class: "gs-picker", "data-testid": "git-story-picker" },
    h("div", { class: "gs-section-head" },
      h("div", {}, h("h4", {}, "Explain past commits"), h("p", { class: "gs-muted" }, "Pick a push, or any commits. The story explains them from their messages and diffs, without this conversation.")),
      h("button", { class: "ghost compact gs-boxed", type: "button", "data-testid": "git-story-pick-cancel", onclick: closePicker }, story.latest ? "Back to the story" : "Cancel")),
    h("div", { class: "gs-subtabs", role: "tablist", "aria-label": "Pick from" },
      [["pushes", "Pushes", pick.pushes?.length], ["commits", "Commits", pick.history?.length]].map(([id, label, count]) => h("button", {
        class: "gs-subtab", type: "button", role: "tab", "aria-selected": String(pick.tab === id), "data-testid": `git-story-pick-${id}`, onclick: () => pickTab(id),
      }, label, count === undefined ? null : h("span", { class: "gs-count" }, String(count))))),
    typedRow(),
    list,
    h("div", { class: "gs-pick-foot" },
      h("span", { class: "gs-min gs-ellipsis", "data-testid": "git-story-pick-summary", title: picked.map((commit) => `${commit.shortHash} ${commit.subject}`).join("\n") },
        picked.length ? h("b", {}, `${picked.length} of ${PICK_LIMIT} commits picked: `) : h("span", { class: "gs-muted" }, `Pick up to ${PICK_LIMIT} commits.`),
        picked.length ? picked.map((commit) => commit.shortHash).join(", ") : null),
      picked.length ? h("button", { class: "ghost compact gs-boxed", type: "button", onclick: () => { pick.selected.clear(); changed(); } }, "Clear") : null,
      h("button", { class: "primary compact", type: "button", "data-testid": "git-story-pick-generate", disabled: !picked.length, onclick: () => story.ctx.generate() }, picked.length ? `Generate story for ${plural(picked.length, "commit")}` : "Generate story"))));
  if (pick.error) { list.append(h("p", { class: "gs-muted", role: "alert" }, pick.error)); return; }
  const items = pick.tab === "pushes" ? pick.pushes : pick.history;
  if (!items) { list.append(h("div", { class: "git-review-loading" }, [1, 2, 3, 4].map(() => h("span", { class: "git-review-skeleton", "aria-hidden": "true" })))); return; }
  if (!items.length) {
    list.append(h("p", { class: "gs-muted" }, pick.tab === "pushes" ? "No pushes recorded here. Git only remembers pushes made from this clone, so pick commits instead." : "This repository has no commits."));
    return;
  }
  if (pick.tab === "pushes") pagedList(list, "pick", items, () => 58, pushRow, "pushes");
  else pagedList(list, "pick", items, () => 42, commitRow, "commits");
}

/* ---- Copy as Markdown: the Mermaid block comes from the checked graph, not the model ---- */

export function storyMarkdown(saved) {
  const { story: written, facts } = saved;
  const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const code = (text) => text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
  const quoted = (text) => `"${text.replace(/"/g, "'")}"`;
  const nodeId = (id) => `n_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;
  const shape = (node) => node.kind === "decision" ? `{${quoted(node.label)}}` : `[${quoted(node.label)}]`;
  return [
    `## ${written.title}`, "",
    written.overview.what, "",
    `**Why.** ${written.overview.why}`, "",
    ...written.overview.notice.map((text) => `- ${text}`), "",
    "### How it flows", "", "```mermaid", "flowchart LR",
    ...written.diagram.nodes.map((node) => `  ${nodeId(node.id)}${shape(node)}`),
    ...written.diagram.edges.map((edge) => `  ${nodeId(edge.from)} ${edge.style === "dashed" ? "-.->" : "-->"}${edge.label ? `|${quoted(edge.label)}|` : ""} ${nodeId(edge.to)}`),
    "```", "",
    "### Examples", "",
    ...written.examples.flatMap((example) => [
      `**${example.title}** · ${example.kind}`, "",
      ...example.steps.map((step, index) => `${index + 1}. ${step.you ? `You: ${step.you} ` : ""}App: ${step.app}`), "",
      `Result: ${example.result}`, ""]),
    ...(written.timeline.length ? ["### How it evolved", "",
      ...written.timeline.map((phase) => `- ${turnsLabel(phase.turns)} · ${phase.title}${phase.pivot ? `. Changed direction: ${phase.pivot}` : ""}`), ""] : []),
    "### Files", "", "| File | Lines | What changed |", "| --- | --- | --- |",
    ...facts.files.map((file) => `| ${code(cell(file.path))} | +${file.add} −${file.del} | ${cell(written.implementation.what[file.path] ?? "")} |`), "",
    ...(written.implementation.decisions.length ? ["### Key decisions", "", ...written.implementation.decisions.map((decision) => `- **${decision.title}.** ${decision.why} Instead of: ${decision.instead}`), ""] : []),
    ...(written.implementation.checks.length ? ["### What to check", "", ...written.implementation.checks.map((check) => `- [ ] ${check.priority}: ${check.text}`)] : []),
  ].join("\n");
}

async function copyMarkdown() {
  try {
    await navigator.clipboard.writeText(storyMarkdown(story.latest.saved));
    toast("Copied the story as Markdown. The flow diagram is a Mermaid block, so GitHub draws it.");
  } catch {
    toast("The browser blocked the clipboard.", 6000);
  }
}
