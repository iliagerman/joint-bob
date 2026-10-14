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
let terminalPolicyDirty = false;

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

function terminalPolicyValue() {
  return {
    mode: terminalMode.value,
    accounts: [...terminalPeople.querySelectorAll("input:checked")].map((input) => input.value).sort(),
    maxPerUser: Number(terminalMax.value),
    idleMinutes: Number(terminalIdle.value),
  };
}

async function saveTerminalPolicy() {
  await api("/api/terminal-policy", { method: "PUT", body: JSON.stringify(terminalPolicyValue()) });
  terminalPolicyDirty = false;
  terminalStatus.textContent = "Saved. Open terminals keep running; new ones follow these settings.";
  document.dispatchEvent(new CustomEvent("terminalPolicyChanged"));
}

export async function saveChangedTerminalPolicy() {
  if (!terminalPolicyDirty) return;
  try {
    await saveTerminalPolicy();
  } catch (error) {
    terminalStatus.textContent = error.message;
    throw error;
  }
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
  terminalPolicyDirty = false;
}

terminalMode?.addEventListener("change", () => {
  terminalPolicyDirty = true;
  renderTerminalPeople([...terminalPeople.querySelectorAll("input:checked")].map((input) => input.value));
});
terminalPeople?.addEventListener("change", () => { terminalPolicyDirty = true; });
terminalMax?.addEventListener("input", () => { terminalPolicyDirty = true; });
terminalIdle?.addEventListener("input", () => { terminalPolicyDirty = true; });
terminalSave?.addEventListener("click", async () => {
  terminalSave.disabled = true;
  try {
    await saveTerminalPolicy();
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

const usersBody = document.querySelector("#usersTableBody");
const usersStatus = document.querySelector("#usersStatus");
const usersMode = document.querySelector("#usersMultiUserStatus");
const usersAdd = document.querySelector("#usersAddButton");
const usersOneTime = document.querySelector("#usersOneTime");

function cell(text) { const td = document.createElement("td"); td.textContent = text; return td; }
function actionButton(label, testid, onClick) {
  const button = document.createElement("button");
  button.type = "button"; button.className = "ghost compact"; button.textContent = label; button.dataset.testid = testid;
  button.addEventListener("click", () => void onClick().catch((error) => { usersStatus.textContent = error.message; }));
  return button;
}

const usersFindings = document.querySelector("#usersSelfTestFindings");
const usersModeActions = document.querySelector("#usersModeActions");
const usersSelfTest = document.querySelector("#usersSelfTestButton");
const usersEnable = document.querySelector("#usersEnableButton");
const usersEnableConfirm = document.querySelector("#usersEnableConfirm");

function showFindings(failures = [], warnings = []) {
  usersFindings.replaceChildren(...[...failures.map((text) => ["Failed", text]), ...warnings.map((text) => ["Warning", text])].map(([kind, text]) => {
    const item = document.createElement("li");
    item.textContent = `${kind}: ${text}`;
    return item;
  }));
  usersFindings.hidden = !usersFindings.children.length;
}

/** Where the node is on the way to holding more than one person, and the next step. */
function showMultiUserMode(multiUser) {
  usersModeActions.hidden = multiUser.enabled || !multiUser.helperPresent;
  usersSelfTest.hidden = multiUser.enabled;
  usersEnable.hidden = !multiUser.ready;
  if (multiUser.enabled) usersEnableConfirm.hidden = true;
  usersMode.textContent = multiUser.enabled
    ? "Multi-user mode is on: every person runs under their own OS account."
    : !multiUser.helperPresent
    ? "Adding people needs multi-user mode. Run `just install-multi-user` on this machine as an administrator, then run the self-test here."
    : multiUser.ready
    ? "The self-test passed. Turn on multi-user mode to move your agents into your own OS account and start adding people."
    : multiUser.selfTest.at
    ? "The self-test didn't pass. Fix what it found, then run it again."
    : "The multi-user helper is installed. Run the self-test to prove people on this machine can't reach each other.";
  if (!multiUser.enabled) showFindings(multiUser.selfTest.failures);
  else showFindings();
}

usersSelfTest?.addEventListener("click", async () => {
  usersSelfTest.disabled = true;
  usersMode.textContent = "Running the self-test with two throwaway accounts…";
  try {
    const result = await api("/api/multi-user/self-test", { method: "POST" });
    await loadUsers();
    showFindings(result.failures, result.warnings);
  } catch (error) {
    usersStatus.textContent = error.message;
  } finally {
    usersSelfTest.disabled = false;
  }
});
usersEnable?.addEventListener("click", () => { usersEnableConfirm.hidden = false; document.querySelector("#usersEnableConfirmButton").focus(); });
document.querySelector("#usersEnableCancelButton")?.addEventListener("click", () => { usersEnableConfirm.hidden = true; });
document.querySelector("#usersEnableConfirmButton")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  usersStatus.textContent = "Moving your agents into your own OS account…";
  try {
    await api("/api/multi-user/enable", { method: "POST" });
    usersStatus.textContent = "Multi-user mode is on. You can add people now.";
    await loadUsers();
  } catch (error) {
    usersStatus.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

const claudeToken = document.querySelector("#usersClaudeToken");
const claudeTokenStatus = document.querySelector("#usersClaudeTokenStatus");
function showClaudeToken(saved) {
  claudeTokenStatus.textContent = saved ? "A Claude token is saved. People's agents use the node's Claude subscription." : "No Claude token is saved. Claude won't be signed in for anyone but the node itself.";
  document.querySelector("#usersClaudeTokenClear").hidden = !saved;
}
async function saveClaudeToken(token) {
  const { claudeToken: saved } = await api("/api/multi-user/claude-token", { method: "PUT", body: JSON.stringify({ token }) });
  claudeToken.value = "";
  showClaudeToken(saved);
}
document.querySelector("#usersClaudeTokenSave")?.addEventListener("click", () => void saveClaudeToken(claudeToken.value.trim() || null).catch((error) => { claudeTokenStatus.textContent = error.message; }));
document.querySelector("#usersClaudeTokenClear")?.addEventListener("click", () => void saveClaudeToken(null).catch((error) => { claudeTokenStatus.textContent = error.message; }));

export async function loadUsers() {
  if (!isNodeAdmin()) return;
  const { users, multiUser, adminTransfer } = await api("/api/users");
  showMultiUserMode(multiUser);
  showClaudeToken(multiUser.claudeToken);
  usersAdd.dataset.blocked = String(!multiUser.canAddPeople);
  usersAdd.disabled = !multiUser.canAddPeople;
  usersBody.replaceChildren(...users.map((user) => {
    const row = document.createElement("tr");
    row.dataset.testid = "users-row";
    const actions = document.createElement("td");
    if (user.role !== "admin") {
      actions.append(
        actionButton(user.disabled ? "Enable" : "Disable", "users-toggle", async () => { await api(`/api/users/${encodeURIComponent(user.userId)}`, { method: "PUT", body: JSON.stringify({ disabled: !user.disabled }) }); await loadUsers(); }),
        actionButton(adminTransfer?.toUserId === user.userId ? "Admin role offered" : "Make admin", "users-transfer", async () => {
          if (adminTransfer?.toUserId === user.userId) await api("/api/users/admin-transfer", { method: "DELETE" });
          else await api(`/api/users/${encodeURIComponent(user.userId)}/admin-transfer`, { method: "POST" });
          await loadUsers();
        }),
        actionButton("Delete", "users-delete", async () => {
          // Deleting is typed out in place: the account and everything it has go, and nothing moves to the admin.
          const input = Object.assign(document.createElement("input"), { placeholder: `Type ${user.username}`, autocomplete: "off" });
          input.dataset.testid = "users-delete-confirm";
          input.setAttribute("aria-label", `Type ${user.username} to delete their account and everything they have on this node`);
          const confirm = actionButton("Delete for good", "users-delete-final", async () => {
            if (input.value !== user.username) { usersStatus.textContent = `Type ${user.username} to delete.`; return; }
            const response = await fetch(`/api/users/${encodeURIComponent(user.userId)}`, { method: "DELETE", headers: { "Content-Type": "application/json", "x-csrf-token": state.csrfToken }, body: JSON.stringify({ confirm: input.value }) });
            if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Could not delete this person");
            usersStatus.textContent = `${user.email || user.username} and everything they had here are deleted.`;
            await loadUsers();
          });
          const cancel = actionButton("Cancel", "users-delete-cancel", async () => { await loadUsers(); });
          actions.replaceChildren(input, confirm, cancel);
          input.focus();
        }),
      );
    }
    row.append(cell(user.email || "—"), cell(user.username), cell(user.role === "admin" ? "Admin" : "Member"), cell(user.disabled ? "Disabled" : "Active"), cell(new Date(user.createdAt).toLocaleDateString()), actions);
    return row;
  }));
}

usersAdd?.addEventListener("click", async () => {
  usersAdd.disabled = true;
  usersOneTime.hidden = true;
  try {
    const username = document.querySelector("#usersAddUsername").value.trim();
    const email = document.querySelector("#usersAddEmail").value.trim();
    const created = await api("/api/users", { method: "POST", body: JSON.stringify({ username, email }) });
    usersOneTime.textContent = `One-time password for ${created.user.email}: ${created.oneTimePassword} — it is shown only now.`;
    usersOneTime.hidden = false;
    document.querySelector("#usersAddUsername").value = "";
    document.querySelector("#usersAddEmail").value = "";
    await loadUsers();
  } catch (error) {
    usersStatus.textContent = error.message;
  } finally {
    usersAdd.disabled = usersAdd.dataset.blocked === "true";
  }
});

/** A member offered the admin role is asked once per sign-in; nothing changes until they accept. */
export async function showAdminTransferOffer() {
  if (isNodeAdmin() || state.isRemoteLogin) return;
  const { offered } = await api("/api/account/admin-transfer").catch(() => ({ offered: false }));
  if (!offered || document.querySelector("[data-testid='admin-transfer-offer']")) return;
  const node = document.createElement("div");
  node.className = "toast";
  node.dataset.testid = "admin-transfer-offer";
  const text = document.createElement("span");
  text.className = "toast-message";
  text.textContent = "You're offered the admin role of this node.";
  const accept = document.createElement("button");
  accept.type = "button"; accept.className = "ghost compact"; accept.textContent = "Accept"; accept.dataset.testid = "admin-transfer-accept";
  accept.addEventListener("click", async () => { node.remove(); await api("/api/account/admin-transfer/accept", { method: "POST" }); location.reload(); });
  const dismiss = document.createElement("button");
  dismiss.type = "button"; dismiss.className = "toast-close"; dismiss.textContent = "×"; dismiss.setAttribute("aria-label", "Not now");
  dismiss.addEventListener("click", () => node.remove());
  node.append(text, accept, dismiss);
  document.body.append(node);
}
