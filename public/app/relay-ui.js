// Pieces shared by the two relay screens: Settings → Relay (this machine as a relay) and
// Settings → Cluster → Relays (this machine's memberships). Plain DOM helpers, a two-click
// button for destructive actions, and a list that pages to the height it is given.
import { toast } from "./shell.js";

const VIRTUAL_SUFFIX = ".relay.invalid";
const DISARM_MS = 6000;

export function makeNode(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

export function makeBadge(label, kind = "") {
  return makeNode("span", `cluster-badge ${kind}`.trim(), label);
}

export function makeButton(label, testid, onClick, className = "ghost compact") {
  const button = makeNode("button", className, label);
  button.type = "button";
  button.dataset.testid = testid;
  button.addEventListener("click", onClick);
  return button;
}

/**
 * A destructive action that asks inline: the first click turns the button into its own
 * confirmation, the second one acts. Leaving the button or waiting a few seconds cancels.
 */
export function makeTwoStepButton({ label, armedLabel, testid, onConfirm, className = "ghost compact danger" }) {
  let timer;
  const disarm = () => {
    clearTimeout(timer);
    button.dataset.armed = "false";
    button.textContent = label;
  };
  const button = makeButton(label, testid, () => {
    if (button.dataset.armed !== "true") {
      button.dataset.armed = "true";
      button.textContent = armedLabel;
      timer = setTimeout(disarm, DISARM_MS);
      return;
    }
    disarm();
    button.disabled = true;
    Promise.resolve(onConfirm()).finally(() => { button.disabled = false; });
  }, className);
  button.dataset.armed = "false";
  button.addEventListener("blur", disarm);
  button.addEventListener("keydown", (event) => { if (event.key === "Escape" && button.dataset.armed === "true") { event.preventDefault(); event.stopPropagation(); disarm(); } });
  return button;
}

/** Puts text on the clipboard. Secrets are copied from the screen and never kept anywhere else. */
export async function copyText(value, message) {
  if (!navigator.clipboard) { toast("Copying is not available here. Select the text and copy it."); return; }
  try { await navigator.clipboard.writeText(value); toast(message); }
  catch (error) { toast(error?.message || "Could not copy"); }
}

/** Inline result line: errors and confirmations stay next to the control that caused them. */
export function showStatus(node, message, kind = "info") {
  node.textContent = message;
  node.dataset.state = message ? kind : "";
}

export function formatBytes(bytes) {
  let value = Number(bytes) || 0;
  if (value < 1000) return `${value} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let unit = -1;
  do { value /= 1000; unit += 1; } while (value >= 1000 && unit < units.length - 1);
  return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${units[unit]}`;
}

export function formatWhen(iso, never = "never") {
  if (!iso) return never;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? never : date.toLocaleString();
}

export function shortFingerprint(fingerprint) {
  const value = String(fingerprint || "");
  return value.length > 20 ? `${value.slice(0, 9)}…${value.slice(-6)}` : value;
}

/** True for the placeholder address of a machine that peers can reach only through a relay. */
export function isRelayOnlyUrl(url) {
  if (!url) return false;
  try { return new URL(url).hostname.endsWith(VIRTUAL_SUFFIX); }
  catch { return String(url).replace(/\/+$/, "").endsWith(VIRTUAL_SUFFIX); }
}

/** What to print for a node's address: relay-only placeholders read as "through relay". */
export function displayNodeUrl(url) {
  return isRelayOnlyUrl(url) ? "through relay" : url || "";
}

/**
 * A list that shows exactly the rows its box has room for and pages through the rest, so it
 * never scrolls. `fetchPage(page, size)` resolves `{ total, items }`; `renderItem(item)` returns
 * a row. After painting, the page size is refitted to the measured row height (growing at most
 * once per load, then only shrinking, which always settles) and again whenever the box resizes.
 */
export function createFittedList({ list, pager, testPrefix, fetchPage, renderItem, emptyText, initialSize = 5, maxSize = 50 }) {
  const view = { page: 1, size: initialSize, total: 0, items: [], ticket: 0, refitting: false };

  function paintPager() {
    pager.replaceChildren();
    pager.hidden = view.total <= view.size;
    if (pager.hidden) return;
    const pages = Math.ceil(view.total / view.size);
    const previous = makeButton("Previous", `${testPrefix}-page-previous`, () => { view.page -= 1; void load().catch(report); });
    previous.disabled = view.page <= 1;
    const label = makeNode("span", "", `${(view.page - 1) * view.size + 1}–${Math.min(view.total, view.page * view.size)} of ${view.total}`);
    label.dataset.testid = `${testPrefix}-page-label`;
    const next = makeButton("Next", `${testPrefix}-page-next`, () => { view.page += 1; void load().catch(report); });
    next.disabled = view.page >= pages;
    pager.append(previous, label, next);
  }

  function paint() {
    list.replaceChildren();
    if (!view.items.length) list.append(makeNode("p", "relay-empty", emptyText));
    for (const item of view.items) {
      const row = renderItem(item);
      row.dataset.fitRow = "true";
      list.append(row);
    }
    paintPager();
    fit();
  }

  function fit() {
    const rows = [...list.children].filter((child) => child.dataset.fitRow);
    if (!rows.length || !list.clientHeight) return;
    const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
    const rowHeight = Math.max(...rows.map((row) => row.offsetHeight)) + gap;
    const size = Math.min(maxSize, Math.max(1, Math.floor((list.clientHeight + gap) / rowHeight)));
    if (size === view.size) return;
    if (size > view.size && (view.refitting || view.total <= rows.length)) return;
    const first = (view.page - 1) * view.size;
    view.size = size;
    view.page = Math.floor(first / size) + 1;
    view.refitting = true;
    load().catch(report).finally(() => { view.refitting = false; });
  }

  async function load() {
    const ticket = ++view.ticket;
    const body = await fetchPage(view.page, view.size);
    if (ticket !== view.ticket) return;
    const last = Math.max(1, Math.ceil(body.total / view.size));
    if (view.page > last) { view.page = last; await load(); return; }
    view.total = body.total;
    view.items = body.items;
    paint();
  }

  function report(error) { console.warn("Could not refresh a relay list", error); }

  let lastHeight = 0;
  new ResizeObserver(() => {
    const height = list.clientHeight;
    if (height === lastHeight) return;
    lastHeight = height;
    if (height) requestAnimationFrame(fit);
  }).observe(list);

  return {
    reload: load,
    first() { view.page = 1; return load(); },
    get total() { return view.total; },
  };
}
