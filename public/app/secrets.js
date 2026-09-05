import { api } from "./api.js";
import { elements } from "./elements.js";
import { brandIcon, brandIconPaths } from "./icons.js";
import { confirmAction, toast } from "./shell.js";

// Generic secret accounts are deliberately node-local; only metadata is ever rendered.
export const secretAccounts = [];
let editingSecretAccountId = null;
let secretScopeTarget = null;

// Brand marks, drawn inline so the offline shell never reaches for a network icon.
const providerLabels = { aws: "AWS", google: "Google", github: "GitHub", custom: "Custom" };
/** Shown under the provider picker so the choice explains itself before anything is typed. */
const providerHints = {
  aws: "An access key pair. The AWS CLI and the AWS SDKs pick these up with no extra setup.",
  google: "Paste the Google service account JSON. It is stored privately and GOOGLE_APPLICATION_CREDENTIALS points gcloud and the Google SDKs at it.",
  github: "A personal access token. The gh CLI and the GitHub API read it, and GITHUB_TOKEN is filled in from GH_TOKEN. Git pushes keep using the GitHub group set under Projects.",
  custom: "Any environment variables you need. Every agent session in the scopes you assign this account to receives them.",
};

function providerIcon(provider) {
  return brandIcon(brandIconPaths[provider] ? provider : "custom", `secret-provider-icon ${provider}`);
}

export function providerBadge(provider, testid) {
  const badge = document.createElement("span");
  badge.className = "secret-provider-badge";
  badge.dataset.testid = testid;
  badge.title = providerLabels[provider] ?? provider;
  badge.append(providerIcon(provider));
  return badge;
}

function secretProviderPresets(provider) {
  if (provider === "aws") return [{ name: "AWS_ACCESS_KEY_ID", kind: "value" }, { name: "AWS_SECRET_ACCESS_KEY", kind: "value" }];
  if (provider === "google") return [{ name: "GOOGLE_APPLICATION_CREDENTIALS", kind: "file" }];
  if (provider === "github") return [{ name: "GH_TOKEN", kind: "value" }];
  return [{ name: "", kind: "value" }];
}

function secretValuePlaceholder(kind, configured) {
  if (configured) return "Leave blank to keep the saved value";
  if (kind !== "file") return "Secret value";
  return elements.secretAccountProviderInput.value === "google" ? "Paste the Google service account JSON" : "Paste the file contents";
}

function secretRow(variable = { name: "", kind: "value", configured: false }) {
  const row = document.createElement("div");
  row.className = "secret-variable-row";
  const name = document.createElement("input");
  name.placeholder = "ENV_NAME";
  name.value = variable.name;
  name.autocomplete = "off";
  name.spellcheck = false;
  name.setAttribute("aria-label", "Environment variable name");
  name.dataset.secretName = "";
  name.dataset.testid = "secret-variable-name-input";
  const kind = document.createElement("select");
  kind.setAttribute("aria-label", "Secret kind");
  kind.dataset.secretKind = "";
  kind.dataset.testid = "secret-variable-kind-select";
  for (const value of ["value", "file"]) { const option = document.createElement("option"); option.value = value; option.textContent = value === "file" ? "File content" : "Value"; kind.append(option); }
  kind.value = variable.kind;
  const value = document.createElement("textarea");
  value.setAttribute("aria-label", "Secret value");
  value.placeholder = secretValuePlaceholder(variable.kind, variable.configured);
  value.dataset.secretValue = "";
  value.dataset.testid = "secret-variable-value-input";
  kind.addEventListener("change", () => { value.placeholder = secretValuePlaceholder(kind.value, variable.configured); });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ghost compact";
  remove.textContent = "Remove";
  remove.dataset.testid = "secret-variable-remove-button";
  remove.addEventListener("click", () => row.remove());
  row.append(name, kind, remove, value);
  elements.secretVariableRows.append(row);
}

function renderSecretAccounts() {
  elements.secretAccountList.replaceChildren();
  if (!secretAccounts.length) { elements.secretAccountList.textContent = "No node-local secret accounts."; return; }
  for (const account of secretAccounts) {
    const row = document.createElement("div"); row.className = "secret-account-row";
    const meta = document.createElement("span"); meta.className = "secret-account-meta";
    const name = document.createElement("strong"); name.textContent = `${account.label} · ${providerLabels[account.provider] ?? account.provider}`;
    const variables = document.createElement("span"); variables.className = "secret-account-vars";
    variables.textContent = account.variables.map((item) => `${item.name}${item.kind === "file" ? " (file)" : ""}`).join(", ");
    meta.append(name, variables);
    const edit = document.createElement("button"); edit.type = "button"; edit.className = "ghost compact"; edit.textContent = "Edit"; edit.dataset.testid = "secret-account-edit-button";
    edit.addEventListener("click", () => openSecretAccount(account));
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "ghost compact danger"; remove.textContent = "Delete"; remove.dataset.testid = "secret-account-delete-button";
    remove.addEventListener("click", () => deleteSecretAccount(account));
    row.append(providerBadge(account.provider, "secret-account-provider-badge"), meta, edit, remove); elements.secretAccountList.append(row);
  }
}

export async function loadSecretAccounts() {
  const payload = await api("/api/secrets");
  secretAccounts.splice(0, secretAccounts.length, ...payload.accounts);
  renderSecretAccounts();
}

async function deleteSecretAccount(account) {
  const confirmed = await confirmAction({
    eyebrow: "Delete secret account",
    title: `Delete ${account.label}?`,
    message: "Every workspace, project and conversation using it loses those variables.",
    confirmLabel: "Delete account",
    destructive: true,
  });
  if (!confirmed) return;
  await api(`/api/secrets/accounts/${encodeURIComponent(account.id)}`, { method: "DELETE" });
  await loadSecretAccounts();
  toast("Secret account deleted");
}

/**
 * Switching provider swaps in that provider's variables. It never discards a secret the
 * user already typed, and never touches the rows of an account that is being edited.
 */
function applySecretProviderPreset() {
  const provider = elements.secretAccountProviderInput.value;
  elements.secretAccountProviderIcon.replaceChildren(providerIcon(provider));
  elements.secretAccountProviderHint.textContent = providerHints[provider];
  const typed = [...elements.secretVariableRows.children].some((row) => row.querySelector("[data-secret-value]").value.trim());
  if (editingSecretAccountId || typed) return;
  elements.secretVariableRows.replaceChildren();
  secretProviderPresets(provider).forEach((item) => secretRow(item));
}

function openSecretAccount(account = null) {
  editingSecretAccountId = account?.id ?? null;
  elements.secretAccountTitle.textContent = account ? "Edit secret account" : "Add secret account";
  elements.secretAccountLabelInput.value = account?.label ?? "";
  elements.secretAccountProviderInput.value = account?.provider ?? "aws";
  // Node-local is the default, so a new account never leaves this node by accident.
  elements.secretAccountReplicateInput.checked = Boolean(account?.replicate);
  elements.secretVariableRows.replaceChildren();
  // A new account has no rows yet, so the preset below fills them; an edited one keeps its own.
  account?.variables.forEach((item) => secretRow(item));
  applySecretProviderPreset();
  elements.secretAccountDialog.showModal();
}

export async function openSecretScope(scopeType, scopeId, label) {
  await loadSecretAccounts();
  const { accountIds } = await api(`/api/secrets/scopes/${encodeURIComponent(scopeType)}/${encodeURIComponent(scopeId)}`);
  secretScopeTarget = { scopeType, scopeId };
  elements.secretScopeTitle.textContent = `Secret accounts: ${label}`;
  elements.secretScopeList.replaceChildren();
  if (!secretAccounts.length) elements.secretScopeList.textContent = "No node-local secret accounts. Add one in Settings.";
  for (const account of secretAccounts) {
    const item = document.createElement("label"); item.className = "checkbox-row secret-scope-row";
    const input = document.createElement("input"); input.type = "checkbox"; input.value = account.id; input.checked = accountIds.includes(account.id); input.dataset.testid = "secret-scope-account-checkbox";
    item.append(input, providerBadge(account.provider, "secret-scope-provider-badge"), document.createTextNode(` ${account.label}`)); elements.secretScopeList.append(item);
  }
  elements.secretScopeDialog.showModal();
}

elements.secretScopeCancelButton.addEventListener("click", () => elements.secretScopeDialog.close());
elements.secretScopeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!secretScopeTarget) throw new Error("Secret scope target is missing");
  const accountIds = [...elements.secretScopeList.querySelectorAll("input:checked")].map((input) => input.value);
  await api(`/api/secrets/scopes/${encodeURIComponent(secretScopeTarget.scopeType)}/${encodeURIComponent(secretScopeTarget.scopeId)}`, { method: "PUT", body: JSON.stringify({ accountIds }) });
  elements.secretScopeDialog.close(); toast("Secret accounts saved");
});
elements.secretAccountAddButton.addEventListener("click", () => openSecretAccount());
elements.secretVariableAddButton.addEventListener("click", () => secretRow());
elements.secretAccountCancelButton.addEventListener("click", () => elements.secretAccountDialog.close());
elements.secretAccountProviderInput.addEventListener("change", () => {
  applySecretProviderPreset();
});
elements.secretAccountForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const provider = elements.secretAccountProviderInput.value;
  const variables = [...elements.secretVariableRows.children].map((row) => {
    const name = row.querySelector("[data-secret-name]").value.trim();
    const kind = row.querySelector("[data-secret-kind]").value;
    const value = row.querySelector("[data-secret-value]").value;
    return { name, kind, ...(value === "" ? {} : { value }) };
  });
  if (!variables.every((item) => item.name) || new Set(variables.map((item) => item.name)).size !== variables.length || (!editingSecretAccountId && variables.some((item) => item.value === undefined))) throw new Error("Enter unique variable names and values");
  if (provider === "google") for (const item of variables) {
    if (item.kind !== "file" || item.value === undefined) continue;
    try { JSON.parse(item.value); } catch { throw new Error("Google credentials must be valid JSON. Paste the whole service account file."); }
  }
  const payload = { label: elements.secretAccountLabelInput.value.trim(), provider, replicate: elements.secretAccountReplicateInput.checked, variables };
  const saved = await api(editingSecretAccountId ? `/api/secrets/accounts/${encodeURIComponent(editingSecretAccountId)}` : "/api/secrets/accounts", { method: editingSecretAccountId ? "PUT" : "POST", body: JSON.stringify(payload) });
  elements.secretAccountDialog.close(); await loadSecretAccounts();
  // The server pushes a replicating save to every paired node; the Sync to nodes
  // button in Settings stays for retries and newly paired nodes.
  if (!payload.replicate) {
    toast("Secret account saved");
    return;
  }
  const results = saved.syncResults ?? [];
  const failed = results.filter((result) => result.error);
  if (!results.length) toast("Saved. No paired nodes yet — pair one in the Cluster tab, then use Sync to nodes");
  else if (failed.length) toast(`Synced ${results.length - failed.length} of ${results.length} nodes; ${failed[0].name}: ${failed[0].error}`, 8000);
  else toast(`Saved and synced to ${results.length} ${results.length === 1 ? "node" : "nodes"}`);
});
