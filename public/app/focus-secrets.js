import { api } from "./api.js";
import { createSearchableSelect } from "./searchable-select.js";
import { loadSecretAccounts, secretAccounts } from "./secrets.js";
import { toast } from "./shell.js";
import { state } from "./state.js";

export async function openConversationSecretPicker() {
  const projectId = state.activeProjectId;
  const scope = `${state.engine}:${state.activeSessionId}`;
  const url = `/api/secrets/scopes/conversation/${encodeURIComponent(scope)}`;
  const [{ accountIds }] = await Promise.all([api(url), loadSecretAccounts()]);
  const picker = createSearchableSelect({ id: "conversationSecret", testid: "conversation-secret", label: "Secret", prompt: "Choose a secret", placeholder: "Search secrets", emptyText: "No available secrets" });
  picker.setOptions(secretAccounts
    .filter(account => (!account.projectId || account.projectId === projectId) && !accountIds.includes(account.id))
    .map(account => ({ value: account.id, label: account.label, keywords: `${account.provider} ${account.websiteOrigin || ""} ${account.variables.map(variable => variable.name).join(" ")}` })));
  const dialog = document.createElement("dialog");
  dialog.dataset.testid = "conversation-secret-dialog";
  const form = document.createElement("form");
  form.className = "dialog-card";
  const title = document.createElement("h3");
  title.id = "conversationSecretTitle";
  title.textContent = "Add secret to conversation";
  dialog.setAttribute("aria-labelledby", title.id);
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button"; cancel.textContent = "Cancel"; cancel.dataset.testid = "conversation-secret-cancel";
  cancel.addEventListener("click", () => dialog.close());
  const save = document.createElement("button");
  save.type = "submit"; save.className = "primary"; save.textContent = "Add secret"; save.disabled = true; save.dataset.testid = "conversation-secret-save";
  picker.onChange(() => { save.disabled = false; });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    save.disabled = true;
    try {
      // Re-read so another attachment made while the picker was open is kept.
      const current = await api(url);
      await api(url, { method: "PUT", body: JSON.stringify({ accountIds: [...new Set([...current.accountIds, picker.value])] }) });
      dialog.close();
      toast("Secret added to conversation");
    } catch (error) {
      toast.error(error.message);
      save.disabled = false;
    }
  });
  actions.append(cancel, save);
  form.append(title, picker.root, actions);
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.showModal();
  picker.trigger.focus();
}
