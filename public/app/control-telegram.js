// Control center: Telegram. A row in Bob's settings to connect Bob's own Telegram bot: paste the BotFather token, open the
// one-time link to link your own account, disconnect. The bot's token goes to the server and never comes back; the server
// answers only the linked account, so this panel has nothing else to configure.
import { api } from "./api.js";
import { elements } from "./elements.js";
import { makeButton, makeNode, makeTwoStepButton } from "./relay-ui.js";
import { toast } from "./shell.js";

const BASE = "/api/control-center/telegram";

const stylesheet = document.createElement("link");
stylesheet.rel = "stylesheet";
stylesheet.href = "/control-telegram.css";
document.head.append(stylesheet);

const testid = (node, id) => { node.dataset.testid = id; return node; };

const section = testid(makeNode("div", "control-telegram"), "control-telegram");
elements.controlBobGuardText.closest(".control-guard").before(section);

let status = null;
/** The one-time link, shown only until the account it was made for is linked or it is replaced. It is never stored. */
let pairingLink = null;
let formOpen = false;

/** The link is good only while it waits to be used; once it is used or has expired, it is gone from the page. */
function applyStatus(next, link) {
  status = next;
  pairingLink = status.connected && status.linkWaiting ? link ?? pairingLink : null;
  render();
}

/** Runs a change that answers with the new status, and the new one-time link when it made one. */
async function act(work) {
  try {
    const { pairingLink: link, ...next } = await work();
    applyStatus(next, link);
  } catch (error) { toast(error.message); }
}

function connectForm() {
  const token = testid(makeNode("input"), "control-telegram-token");
  Object.assign(token, { type: "password", required: true, autocomplete: "off", placeholder: "123456789:AA…" });
  token.setAttribute("aria-label", "Bot token");
  const base = testid(makeNode("select"), "control-telegram-base");
  for (const item of status.bases) base.append(new Option(item.label, item.id));
  base.setAttribute("aria-label", "Address Telegram uses");
  const steps = makeNode("ol", "control-telegram-steps");
  for (const text of ["In Telegram, open @BotFather, send /newbot and copy the token.", "Paste it here. Only Joint Bob uses it; no agent or page can read it again.", "Open the one-time link you get next, to link your own Telegram account."]) steps.append(makeNode("li", "", text));
  const connect = testid(makeNode("button", "primary compact", "Connect"), "control-telegram-connect");
  connect.type = "submit";
  connect.disabled = !status.bases.length;
  const form = testid(makeNode("form", "control-telegram-form"), "control-telegram-form");
  form.append(steps, token);
  if (status.bases.length > 1) form.append(base);
  if (!status.bases.length) form.append(testid(makeNode("p", "control-telegram-notice", "This machine has no address Telegram can reach. Join a relay in Settings → Relays first."), "control-telegram-no-address"));
  form.append(connect);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    connect.disabled = true;
    const body = JSON.stringify({ token: token.value.trim(), ...(status.bases.length > 1 ? { baseId: base.value } : {}) });
    act(() => api(BASE, { method: "POST", body })).finally(() => { connect.disabled = false; });
  });
  return form;
}

function linkBlock() {
  const block = makeNode("div", "control-telegram-link-block");
  if (pairingLink) {
    const link = testid(makeNode("a", "", "Open this link in Telegram"), "control-telegram-link");
    link.href = pairingLink;
    link.target = "_blank";
    link.rel = "noopener";
    block.append(link, makeNode("span", "", " to link your account. It works once and expires in 10 minutes."));
  } else if (!status.linked) {
    block.append(makeNode("span", "", "No account is linked yet, so the bot answers nobody."));
  }
  const fresh = makeButton(status.linked ? "Link another account" : "New link", "control-telegram-new-link", () => act(() => api(`${BASE}/pairing`, { method: "POST", body: "{}" })));
  block.append(fresh);
  return block;
}

function render() {
  const connected = status?.connected === true;
  const label = !status ? "Telegram" : connected ? `Telegram: @${status.botUsername} · connected · ${status.linked ? "answers only you" : "no account linked yet"}` : "Telegram: not connected";
  const head = makeNode("div", "control-guard control-telegram-head");
  head.append(testid(makeNode("span", "", label), "control-telegram-status"));
  if (status && !connected) {
    head.append(makeButton(formOpen ? "Hide" : "Connect", "control-telegram-toggle", () => { formOpen = !formOpen; render(); }));
  }
  section.replaceChildren(head);
  if (!status) return;
  if (!connected) { if (formOpen) section.append(connectForm()); return; }
  const owner = status.linked ? testid(makeNode("p", "control-telegram-owner", `Linked to ${status.linked.name} (${status.linked.id}). Nobody else gets an answer, and groups are left at once.`), "control-telegram-owner") : null;
  const warning = testid(makeNode("p", "control-hint", "Telegram can do everything this chat can, including allowing or blocking Guardian reviews, so whoever controls the linked Telegram account controls Bob. Turn on two-step verification in Telegram."), "control-telegram-warning");
  const disconnect = makeTwoStepButton({
    label: "Disconnect", armedLabel: "Disconnect? Click again", testid: "control-telegram-disconnect",
    onConfirm: () => act(async () => { await api(BASE, { method: "DELETE" }); return api(BASE); }),
  });
  section.append(...[owner, linkBlock(), warning, disconnect].filter(Boolean));
}

async function refresh() {
  try { applyStatus(await api(BASE)); }
  catch (error) { toast(error.message); }
}

render();
window.addEventListener("control-settings-opened", () => { void refresh(); });
// The server tells open pages when something changed, such as the link being used in Telegram.
window.addEventListener("control-center-changed", () => { if (!elements.controlChatSettings.hidden) void refresh(); });
