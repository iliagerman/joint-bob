import { renderMarkdown } from "../markdown.js";

// DOM helpers. Every value is inserted as text; nothing from a server is parsed as HTML.

export function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") element.className = value;
    else if (key === "dataset") Object.assign(element.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") element.addEventListener(key.slice(2), value);
    else if (key === "text") element.textContent = value;
    else if (value === true) element.setAttribute(key, "");
    else element.setAttribute(key, String(value));
  }
  append(element, children);
  return element;
}

/** An assistant's answer, formatted. The renderer builds nodes, so this parses no HTML either. */
export function markdownBubble(className, text) {
  const element = h("div", { class: `${className} md` });
  renderMarkdown(element, text);
  return element;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

export const chip = (label, kind = "") => h("span", { class: `chip ${kind}`.trim() }, label);
export const bot = (kind = "") => h("span", { class: `bot ${kind}`.trim(), "aria-hidden": "true" }, icon("agent"));
export const initials = name => String(name || "?").split(/\s+/).filter(Boolean).map(part => part[0]).join("").slice(0, 2).toUpperCase() || "?";
export const avatar = (name, kind = "") => h("span", { class: `av ${kind}`.trim(), "aria-hidden": "true" }, initials(name));
export const siteBox = (content) => h("span", { class: "site", "aria-hidden": "true" }, typeof content === "string" ? content : content);

export function switchButton({ checked, label, disabled = false, onToggle, testid }) {
  return h("button", { type: "button", class: "switch", role: "switch", "aria-checked": String(Boolean(checked)), "aria-label": label, disabled, "data-testid": testid, onclick: event => onToggle(event.currentTarget) });
}

export function rowText(title, detail, extra = []) {
  return h("span", { class: "row-text" }, h("strong", {}, h("span", {}, title), extra), detail ? h("small", { title: detail }, detail) : null);
}

/** Request progress as a trail of steps. */
export function trail(steps) {
  return h("ol", { class: "trail", "aria-label": "Request progress" }, steps.map(([label, state]) => h("li", { class: state }, h("i"), label)));
}

const STATE_LABEL = {
  recorded: "Recorded", notified: "Shared with the owner", "awaiting-decision": "Awaiting decision", "awaiting-approval": "Awaiting your approval",
  executing: "Executing", completed: "Completed", declined: "Declined", blocked: "Blocked", failed: "Failed", uncertain: "Uncertain",
};
const STATE_KIND = { completed: "ok", "awaiting-decision": "amber", "awaiting-approval": "amber", executing: "amber", uncertain: "amber", blocked: "bad", failed: "bad" };
export const stateLabel = state => STATE_LABEL[state] || state;
export const stateChip = state => chip(stateLabel(state), STATE_KIND[state] || "");

/** Steps for a request in a given state; `approver` is "your" or "Maya's". */
export function requestSteps(state, approver = "the owner's") {
  const approval = `${approver} approval`;
  const owner = approver === "your" ? "you" : approver.replace(/'s$/, "");
  switch (state) {
    case "awaiting-decision": return [["Recorded", "done"], ["Awaiting decision", "now"], [approval, "todo"], ["Executing", "todo"], ["Completed", "todo"]];
    case "awaiting-approval": return [["Recorded", "done"], ["Decision", "done"], [`Awaiting ${approval}`, "now"], ["Executing", "todo"], ["Completed", "todo"]];
    case "executing": return [["Recorded", "done"], ["Decision", "done"], ["Executing", "now"], ["Completed", "todo"]];
    case "completed": return [["Recorded", "done"], ["Decision", "done"], ["Executing", "done"], ["Completed", "done"]];
    case "notified": return [["Recorded", "done"], [`Shared with ${owner}`, "done"]];
    case "recorded": return [["Recorded", "done"]];
    default: return [["Recorded", "done"], [stateLabel(state), "stop"]];
  }
}

/** Renders as many fixed-height rows as fit in `list`, with Previous/Next below it. */
export function fitPage({ list, pager, items, rowHeight, page, renderRow, empty, onPage }) {
  const size = Math.max(3, Math.floor((list.clientHeight || rowHeight * 6) / rowHeight));
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(page, pages - 1);
  list.replaceChildren(...(items.length ? items.slice(current * size, current * size + size).map(renderRow) : [empty ?? h("div", { class: "empty" }, "Nothing here yet.")]));
  pager.replaceChildren();
  if (pages > 1) {
    pager.className = "pager";
    pager.append(h("span", {}, `${current * size + 1}–${Math.min(items.length, (current + 1) * size)} of ${items.length}`),
      h("span", {}, h("button", { type: "button", disabled: current === 0, onclick: () => onPage(current - 1) }, "Previous"),
        h("button", { type: "button", disabled: current >= pages - 1, onclick: () => onPage(current + 1) }, "Next")));
  }
  return current;
}

export function formatTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  return date.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
