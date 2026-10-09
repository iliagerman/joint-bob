// Settings → Cluster → Relays: the relays this machine belongs to, and the relay it serves
// itself. Adding a relay, leaving one and switching phone sign-in all apply at once. Nothing
// polls: the list reloads when the tab opens, after each action, and when Refresh is pressed.
import { api } from "./api.js";
import { qrSvg } from "./qr.js";
import { copyText, isRelayOnlyUrl, makeBadge, makeButton, makeNode, makeTwoStepButton, shortFingerprint, showStatus } from "./relay-ui.js";

const PAGE_SIZE = 3;
const PHONE_PAGE_SIZE = 3;
const MFA_HINT = "Phone sign-in through a relay needs two-factor authentication. Set it up under Account.";
const STATUS_LABEL = {
  connecting: "Connecting", pending: "Waiting for approval", admitted: "Admitted", suspended: "Suspended", revoked: "Removed", denied: "Declined",
};
const STATUS_KIND = { admitted: "ok", pending: "twin", suspended: "error", revoked: "error", denied: "error" };

const byId = (id) => document.getElementById(id);
const section = byId("clusterRelays");
const status = byId("relaysStatus");
const list = byId("relaysList");
const pager = byId("relaysPager");
const addForm = byId("relaysAddForm");
const addReveal = byId("relaysAddReveal");

let view = { relays: [], local: null, directUrl: "", advertisedUrl: "", mfaEnabled: false, otherUsersPhoneSignIn: false };
let page = 1;
let loaded = false;

// ---- loading ----

function apply(body) {
  view = body;
  loaded = true;
  render();
}

/** Called when the Cluster tab opens and by Refresh. Errors stay on the screen. */
export async function loadRelayMemberships() {
  try { apply(await api("/api/relays")); }
  catch (error) { showStatus(status, `Could not load relays: ${error.message}`, "error"); }
}

async function change(request, done) {
  showStatus(status, "");
  try {
    const answer = await request();
    if (answer) apply(answer); else await loadRelayMemberships();
    if (done) showStatus(status, done, "ok");
  } catch (error) {
    showStatus(status, error.message, "error");
    await loadRelayMemberships();
  }
}

function patchRelay(id, body, done) {
  return change(() => api(`/api/relays/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }), done);
}

// ---- rendering ----

function renderAddress() {
  byId("relaysOtherUsers").checked = view.otherUsersPhoneSignIn === true;
  const address = byId("relaysAddress");
  if (!loaded) { address.textContent = ""; return; }
  const shown = isRelayOnlyUrl(view.advertisedUrl) ? "Reachable through relays only" : view.advertisedUrl || "not set";
  address.textContent = `This machine's address for clusters: ${shown}`;
}

/** Which page of a card's phone addresses is showing, by relay id. */
const phonePages = new Map();
/** The phone address whose QR code is showing, as relay id and address. One at a time keeps the card short. */
let shownQr = "";

function qrFigure(entry) {
  const figure = makeNode("figure", "relay-phone-qr");
  figure.dataset.testid = "relay-phone-qr";
  figure.append(qrSvg(entry.address, `QR code for ${entry.address}`), makeNode("figcaption", "relay-row-meta", "Scan it with the phone's camera."));
  return figure;
}

/** The addresses that work on a phone right now through one relay: a link to open, a button to copy and a QR code to scan. */
function phoneAccess(id, directory, emptyText) {
  const box = makeNode("div", "relay-phone-access");
  box.dataset.testid = "relay-phone-access";
  if (!directory.length) { box.append(makeNode("p", "relay-row-meta", emptyText)); return box; }
  const hint = makeNode("p", "relay-row-meta", "Open these on your phone to sign in through this relay.");
  hint.dataset.testid = "relay-phone-access-hint";
  box.append(hint);
  const pages = Math.ceil(directory.length / PHONE_PAGE_SIZE);
  const current = Math.min(phonePages.get(id) ?? 0, pages - 1);
  for (const entry of directory.slice(current * PHONE_PAGE_SIZE, (current + 1) * PHONE_PAGE_SIZE)) {
    const row = makeNode("div", "relay-phone-entry");
    row.dataset.testid = "relay-phone-entry";
    row.dataset.kind = entry.kind;
    const label = makeNode("span", "relay-phone-entry-label", entry.label);
    label.dataset.testid = "relay-phone-entry-label";
    const link = makeNode("a", "relay-phone-entry-link", entry.address);
    link.href = entry.address;
    link.target = "_blank";
    link.rel = "noopener";
    link.dataset.testid = "relay-phone-entry-link";
    const copy = makeButton("Copy", "relay-phone-entry-copy", () => void copyText(entry.address, "Phone address copied"));
    copy.setAttribute("aria-label", `Copy the phone address for ${entry.label}`);
    const key = `${id}\n${entry.address}`;
    const qr = makeButton(shownQr === key ? "Hide QR code" : "QR code", "relay-phone-entry-qr", () => { shownQr = shownQr === key ? "" : key; render(); });
    qr.setAttribute("aria-expanded", String(shownQr === key));
    qr.setAttribute("aria-label", `${shownQr === key ? "Hide" : "Show"} a QR code of the phone address for ${entry.label}`);
    row.append(label, link, copy, qr);
    box.append(row);
    if (shownQr === key) box.append(qrFigure(entry));
  }
  if (pages > 1) {
    const pager = makeNode("div", "relay-phone-pager");
    const previous = makeButton("Previous", "relay-phone-access-previous", () => { phonePages.set(id, current - 1); render(); });
    previous.disabled = current === 0;
    const position = makeNode("span", "", `${current * PHONE_PAGE_SIZE + 1}–${Math.min(directory.length, (current + 1) * PHONE_PAGE_SIZE)} of ${directory.length}`);
    position.dataset.testid = "relay-phone-access-label";
    const next = makeButton("Next", "relay-phone-access-next", () => { phonePages.set(id, current + 1); render(); });
    next.disabled = current >= pages - 1;
    pager.append(previous, position, next);
    box.append(pager);
  }
  return box;
}

function phoneSwitch(id, enabled) {
  const wrap = makeNode("div", "relay-switch");
  const label = makeNode("label", "checkbox-row");
  const input = makeNode("input");
  input.type = "checkbox"; input.checked = enabled;
  input.dataset.testid = "relay-phone-signin-toggle";
  input.addEventListener("change", () => void patchRelay(id, { phoneSignIn: input.checked }, input.checked ? "Phone sign-in is on." : "Phone sign-in is off."));
  label.append(input, "Phone sign-in through this relay");
  wrap.append(label);
  if (!view.mfaEnabled) {
    const hint = makeNode("p", "settings-hint", MFA_HINT);
    hint.dataset.testid = "relay-mfa-hint";
    wrap.append(hint);
  }
  return wrap;
}

function localCard(local) {
  const card = makeNode("article", "relay-card");
  card.dataset.testid = "relay-local-card";
  const head = makeNode("div", "relay-row-title");
  const title = makeNode("h4", "relay-card-title", "This machine's relay");
  title.dataset.testid = "relay-local-title";
  head.append(title, makeBadge("Serving", "ok"));
  if (local.environment) head.append(makeBadge(local.environment));
  card.append(head, makeNode("p", "relay-row-meta", `${local.origin} · named ${local.name} · ${local.onlinePeers} other machine${local.onlinePeers === 1 ? "" : "s"} online`));
  card.append(phoneAccess(local.id, local.phoneDirectory ?? [], "No phone addresses are open. Turn on phone sign-in below."));
  card.append(phoneSwitch(local.id, local.phoneSignIn));
  return card;
}

function relayActions(relay) {
  const actions = makeNode("div", "relay-row-actions");
  if (["denied", "suspended", "revoked"].includes(relay.status) || !relay.connected) {
    actions.append(makeButton("Reconnect", "relay-reconnect", () => void change(async () => { await api(`/api/relays/${encodeURIComponent(relay.id)}/reconnect`, { method: "POST" }); return null; }, "Reconnecting…")));
  }
  actions.append(makeTwoStepButton({
    label: "Leave", armedLabel: "Confirm leave", testid: "relay-leave",
    onConfirm: () => change(async () => { await api(`/api/relays/${encodeURIComponent(relay.id)}`, { method: "DELETE" }); return null; }, "Left the relay."),
  }));
  return actions;
}

function relayCard(relay) {
  const card = makeNode("article", "relay-card");
  card.dataset.testid = "relay-card";
  card.dataset.relayId = relay.id;
  card.dataset.status = relay.status;
  const head = makeNode("div", "relay-row-title");
  const name = makeNode("h4", "relay-card-title", relay.environment || new URL(relay.origin).host);
  name.dataset.testid = "relay-card-title";
  const state = makeBadge(STATUS_LABEL[relay.status] ?? relay.status, STATUS_KIND[relay.status] ?? "");
  state.dataset.testid = "relay-status";
  const link = makeBadge(relay.connected ? "Connected" : "Offline", relay.connected ? "ok" : "");
  link.dataset.testid = "relay-connection";
  head.append(name, state, link);
  const facts = [relay.origin];
  if (relay.fingerprint && relay.status !== "pending") facts.push(`key ${shortFingerprint(relay.fingerprint)}`);
  if (relay.status === "admitted") facts.push(`${relay.onlinePeers} other machine${relay.onlinePeers === 1 ? "" : "s"} online`);
  card.append(head, makeNode("p", "relay-row-meta", facts.join(" · ")));
  if (relay.lastError) {
    const problem = makeNode("p", "relay-error", relay.lastError);
    problem.dataset.testid = "relay-last-error";
    card.append(problem);
  }
  if (relay.status === "pending") {
    const code = makeNode("div", "relay-code", `${String(relay.pairingCode || "").slice(0, 3)} ${String(relay.pairingCode || "").slice(3)}`.trim());
    code.dataset.testid = "relay-pairing-code";
    code.setAttribute("aria-label", `Pairing code ${String(relay.pairingCode || "").split("").join(" ")}`);
    card.append(code, makeNode("p", "relay-row-meta", "Give this code to the relay's operator to approve this machine."));
    if (relay.fingerprint) {
      const fingerprint = makeNode("p", "relay-row-meta");
      const value = makeNode("code", "relay-address", relay.fingerprint);
      value.dataset.testid = "relay-fingerprint";
      fingerprint.append("Relay key ", value);
      card.append(fingerprint);
    }
  }
  if (relay.status === "admitted") card.append(phoneAccess(relay.id, relay.phoneDirectory ?? [], "Phone addresses appear here once this relay is connected and phone sign-in is on."));
  if (!["denied", "revoked"].includes(relay.status)) card.append(phoneSwitch(relay.id, relay.phoneSignIn));
  card.append(relayActions(relay));
  return card;
}

function render() {
  renderAddress();
  const items = [...(view.local ? [{ local: view.local }] : []), ...view.relays.map((relay) => ({ relay }))];
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  page = Math.min(page, pages);
  list.replaceChildren();
  if (!items.length) list.append(makeNode("p", "relay-empty", "No relays yet. Add one to reach machines that have no public address."));
  for (const item of items.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)) list.append(item.local ? localCard(item.local) : relayCard(item.relay));
  pager.replaceChildren();
  pager.hidden = items.length <= PAGE_SIZE;
  if (pager.hidden) return;
  const previous = makeButton("Previous", "relays-page-previous", () => { page -= 1; render(); });
  previous.disabled = page <= 1;
  const label = makeNode("span", "", `${(page - 1) * PAGE_SIZE + 1}–${Math.min(items.length, page * PAGE_SIZE)} of ${items.length}`);
  label.dataset.testid = "relays-page-label";
  const next = makeButton("Next", "relays-page-next", () => { page += 1; render(); });
  next.disabled = page >= pages;
  pager.append(previous, label, next);
}

// ---- adding a relay ----

function showAddForm(show) {
  addForm.hidden = !show;
  addReveal.setAttribute("aria-expanded", String(show));
  if (show) byId("relaysLinkInput").focus();
}

async function addRelay(body, done) {
  showStatus(status, "");
  try {
    await api("/api/relays", { method: "POST", body: JSON.stringify(body) });
    byId("relaysLinkInput").value = "";
    byId("relaysOriginInput").value = "";
    showAddForm(false);
    page = 1;
    await loadRelayMemberships();
    showStatus(status, done, "ok");
  } catch (error) { showStatus(status, error.message, "error"); }
}

function submitLink() {
  const link = byId("relaysLinkInput").value.trim();
  if (!link) { showStatus(status, "Paste the relay link first.", "error"); return; }
  void addRelay({ link }, "Relay added. It connects in a moment.");
}

function submitRequest() {
  const origin = byId("relaysOriginInput").value.trim();
  if (!origin) { showStatus(status, "Enter the relay's address first, like https://relay.example.com.", "error"); return; }
  void addRelay({ origin }, "Request sent. Give the pairing code below to the relay's operator.");
}

byId("relaysOtherUsers").addEventListener("change", (event) => {
  const enabled = event.target.checked;
  void change(() => api("/api/relays/settings", { method: "PUT", body: JSON.stringify({ otherUsersPhoneSignIn: enabled }) }),
    enabled ? "Other users can sign in from a phone." : "Other users can no longer sign in from a phone.");
});
addReveal.addEventListener("click", () => showAddForm(addForm.hidden));
byId("relaysAddCancel").addEventListener("click", () => { showAddForm(false); addReveal.focus(); });
byId("relaysLinkButton").addEventListener("click", submitLink);
byId("relaysRequestButton").addEventListener("click", submitRequest);
byId("relaysRefresh").addEventListener("click", () => { showStatus(status, ""); void loadRelayMemberships(); });
addForm.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); showAddForm(false); addReveal.focus(); return; }
  if (event.key !== "Enter" || !event.target.matches("input")) return;
  event.preventDefault();
  if (event.target.id === "relaysLinkInput") submitLink(); else submitRequest();
});
section.addEventListener("keydown", (event) => {
  // Enter in a Settings field would submit the whole Settings form.
  if (event.key === "Enter" && event.target.matches("input, select")) event.preventDefault();
});
