import { api } from "./api.js";
import { state } from "./state.js";

const list = document.querySelector("#nodeBlockList");
const select = document.querySelector("#nodeBlockSelect");
const button = document.querySelector("#nodeBlockButton");
const status = document.querySelector("#nodeBlockStatus");

export function isNodeAdmin() {
  return state.role === "admin";
}

/** Admin features don't exist for anyone else: their entries are removed from view, not greyed out. */
export function applyAdminVisibility() {
  const admin = isNodeAdmin();
  document.body.classList.toggle("node-admin", admin);
  for (const option of document.querySelectorAll("option[data-admin-only]")) option.disabled = !admin;
  // Hidden controls still take part in form validation unless they are disabled. A disabled
  // fieldset keeps its controls' own disabled state, so it is used wherever it can be.
  for (const element of document.querySelectorAll("[data-admin-only]")) {
    if (element instanceof HTMLFieldSetElement) { element.disabled = !admin; continue; }
    for (const control of element.querySelectorAll("input, select, textarea, button")) {
      if (!admin && !control.disabled) { control.dataset.adminDisabled = "1"; control.disabled = true; }
      if (admin && control.dataset.adminDisabled) { delete control.dataset.adminDisabled; control.disabled = false; }
    }
  }
}

function blockRow(block) {
  const item = document.createElement("li");
  item.className = "node-block-row";
  item.dataset.testid = "node-block-row";
  const name = document.createElement("span");
  name.textContent = block.nodeName;
  const unblock = document.createElement("button");
  unblock.type = "button";
  unblock.className = "ghost compact";
  unblock.textContent = "Unblock";
  unblock.dataset.testid = "node-unblock-button";
  unblock.addEventListener("click", () => void changeBlock(block.nodeId, false));
  item.append(name, unblock);
  return item;
}

export async function loadNodeBlocks() {
  if (!isNodeAdmin()) return;
  status.textContent = "";
  const { blocks, candidates } = await api("/api/node-blocks");
  list.replaceChildren(...blocks.map(blockRow));
  if (!blocks.length) {
    const empty = document.createElement("li");
    empty.className = "settings-hint";
    empty.textContent = "No node is blocked.";
    list.append(empty);
  }
  select.replaceChildren(...candidates.map((node) => {
    const option = document.createElement("option");
    option.value = node.nodeId;
    option.textContent = node.name;
    return option;
  }));
  select.disabled = button.disabled = candidates.length === 0;
  if (!candidates.length) status.textContent = "No other node to block. Nodes appear here once they share a cluster with this one.";
}

async function changeBlock(nodeId, blocked) {
  button.disabled = true;
  try {
    await api(`/api/node-blocks/${encodeURIComponent(nodeId)}`, { method: "PUT", body: JSON.stringify({ blocked }) });
    await loadNodeBlocks();
    status.textContent = blocked ? "Blocked. Its users are signed out here." : "Unblocked. Sign-ins return within a minute.";
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
}

button?.addEventListener("click", () => { if (select.value) void changeBlock(select.value, true); });

const terminalMode = document.querySelector("#terminalPolicyMode");
const terminalPeople = document.querySelector("#terminalPolicyPeople");
const terminalMax = document.querySelector("#terminalPolicyMax");
const terminalIdle = document.querySelector("#terminalPolicyIdle");
const terminalSave = document.querySelector("#terminalPolicySave");
const terminalStatus = document.querySelector("#terminalPolicyStatus");
let selectableUsers = [];

function renderTerminalPeople(selected) {
  terminalPeople.hidden = terminalMode.value !== "selected";
  terminalPeople.replaceChildren(...(selectableUsers.length ? selectableUsers.map((user) => {
    const label = document.createElement("label");
    label.className = "checkbox-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = user.accountId;
    input.checked = selected.includes(user.accountId);
    input.dataset.testid = "terminal-policy-person";
    label.append(input, document.createTextNode(` ${user.email || user.username}`));
    return label;
  }) : [Object.assign(document.createElement("p"), { className: "settings-hint", textContent: "Add people in Users to choose them here." })]));
}

export async function loadTerminalPolicy() {
  if (!isNodeAdmin()) return;
  const [policy, users] = await Promise.all([api("/api/terminal-policy"), api("/api/users").catch(() => ({ users: [] }))]);
  selectableUsers = users.users ?? [];
  terminalMode.value = policy.mode;
  terminalMax.value = policy.maxPerUser;
  terminalIdle.value = policy.idleMinutes;
  terminalStatus.textContent = "";
  renderTerminalPeople(policy.accounts);
}

terminalMode?.addEventListener("change", () => renderTerminalPeople([...terminalPeople.querySelectorAll("input:checked")].map((input) => input.value)));
terminalSave?.addEventListener("click", async () => {
  terminalSave.disabled = true;
  try {
    await api("/api/terminal-policy", { method: "PUT", body: JSON.stringify({
      mode: terminalMode.value,
      accounts: [...terminalPeople.querySelectorAll("input:checked")].map((input) => input.value),
      maxPerUser: Number(terminalMax.value),
      idleMinutes: Number(terminalIdle.value),
    }) });
    terminalStatus.textContent = "Saved. Open terminals keep running; new ones follow these settings.";
    document.dispatchEvent(new CustomEvent("terminalPolicyChanged"));
  } catch (error) {
    terminalStatus.textContent = error.message;
  } finally {
    terminalSave.disabled = false;
  }
});

/** Tells the admin once, after the upgrade that turned terminals off, with a one-click way back. */
export async function showTerminalNoticeOnce() {
  if (!isNodeAdmin()) return;
  const policy = await api("/api/terminal-policy").catch(() => null);
  if (!policy?.noticePending || document.querySelector("[data-testid='terminal-notice']")) return;
  const node = document.createElement("div");
  node.className = "toast";
  node.dataset.testid = "terminal-notice";
  node.setAttribute("role", "status");
  const text = document.createElement("span");
  text.className = "toast-message";
  text.textContent = "The terminal is now off by default on this node.";
  const enable = document.createElement("button");
  enable.type = "button";
  enable.className = "ghost compact";
  enable.textContent = "Turn it on for me";
  enable.dataset.testid = "terminal-notice-enable";
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "toast-close";
  dismiss.textContent = "×";
  dismiss.setAttribute("aria-label", "Keep it off");
  dismiss.dataset.testid = "terminal-notice-dismiss";
  const answer = async (body) => {
    node.remove();
    await api("/api/terminal-policy", { method: "PUT", body: JSON.stringify(body) }).catch(() => undefined);
    document.dispatchEvent(new CustomEvent("terminalPolicyChanged"));
  };
  enable.addEventListener("click", () => void answer({ mode: "admin" }));
  dismiss.addEventListener("click", () => void answer({ dismissNotice: true }));
  node.append(text, enable, dismiss);
  document.body.append(node);
}
