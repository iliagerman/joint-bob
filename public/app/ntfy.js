import { api } from "./api.js";
import { elements } from "./elements.js";
import { toast } from "./shell.js";
import { refreshSessionsQuietly } from "./socket.js";
import { state } from "./state.js";

/** The dialog is shared, so it remembers which conversation it was opened for. */
let pendingNtfySession = null;

/**
 * Renders the central ntfy service list in Settings → Notifications.
 */
export async function loadNtfyServicesPanel() {
  try {
    const { services } = await api("/api/ntfy/services");
    elements.ntfyServiceList.replaceChildren(...services.map((service) => {
      const item = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `${service.name} — ${service.url}${service.hasToken ? " · token" : ""}`;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "ghost compact danger";
      remove.textContent = "Remove";
      remove.dataset.testid = "ntfy-service-remove-button";
      remove.setAttribute("aria-label", `Remove ntfy service ${service.name}`);
      remove.addEventListener("click", async () => {
        try {
          await api(`/api/ntfy/services/${encodeURIComponent(service.id)}`, { method: "DELETE" });
          await loadNtfyServicesPanel();
          toast("ntfy service removed");
        } catch (error) {
          toast(error.message, 8000);
        }
      });
      item.append(label, remove);
      return item;
    }));
  } catch (error) {
    toast(error.message, 8000);
  }
}

elements.ntfyServiceAddButton.addEventListener("click", async () => {
  const name = elements.ntfyServiceNameInput.value.trim();
  const url = elements.ntfyServiceUrlInput.value.trim();
  const token = elements.ntfyServiceTokenInput.value.trim();
  if (!name || !url) {
    toast("A service needs a name and a server URL");
    return;
  }
  try {
    await api("/api/ntfy/services", { method: "POST", body: JSON.stringify({ name, url, ...(token ? { token } : {}) }) });
    elements.ntfyServiceNameInput.value = "";
    elements.ntfyServiceUrlInput.value = "";
    elements.ntfyServiceTokenInput.value = "";
    await loadNtfyServicesPanel();
    toast("ntfy service added");
  } catch (error) {
    toast(error.message, 8000);
  }
});

/**
 * Row-menu entry point: enabled conversations opt out directly; the rest
 * pick a service and topic in the dialog.
 */
export async function toggleSessionNtfy(session) {
  if (session.ntfyEnabled) {
    await api(`/api/projects/${encodeURIComponent(state.activeProjectId)}/sessions/ntfy`, {
      method: "PUT",
      body: JSON.stringify({ sessionPath: session.path, enabled: false }),
    });
    session.ntfyEnabled = false;
    await refreshSessionsQuietly();
    toast("ntfy publishing stopped");
    return;
  }
  const { services } = await api("/api/ntfy/services");
  if (!services.length) {
    toast("Add an ntfy service in Settings → Notifications first", 8000);
    return;
  }
  pendingNtfySession = { projectId: state.activeProjectId, session };
  elements.ntfyServiceSelect.replaceChildren(...services.map((service) => new Option(`${service.name} — ${service.url}`, service.id)));
  elements.ntfyTopicInput.value = "";
  elements.ntfyDialog.showModal();
}

elements.cancelNtfyButton.addEventListener("click", () => elements.ntfyDialog.close());
elements.ntfyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const pending = pendingNtfySession;
  if (!pending) return;
  const submit = elements.saveNtfyButton;
  if (submit.disabled) return;
  submit.disabled = true;
  try {
    await api(`/api/projects/${encodeURIComponent(pending.projectId)}/sessions/ntfy`, {
      method: "PUT",
      body: JSON.stringify({
        sessionPath: pending.session.path,
        enabled: true,
        serviceId: elements.ntfyServiceSelect.value,
        topic: elements.ntfyTopicInput.value.trim(),
      }),
    });
    pending.session.ntfyEnabled = true;
    if (pendingNtfySession === pending) elements.ntfyDialog.close();
    if (state.activeProjectId === pending.projectId) await refreshSessionsQuietly();
    toast("Review notifications will publish to ntfy");
  } catch (error) {
    toast(error.message, 8000);
  } finally {
    submit.disabled = false;
  }
});
