import { api } from "./api.js";
import { elements } from "./elements.js";
import { openNtfyManager, syncNtfyManager } from "./ntfy-manage.js";
import { toast } from "./shell.js";
import { refreshSessionsQuietly } from "./socket.js";
import { state } from "./state.js";

/** The dialog is shared, so it remembers which conversation it was opened for. */
let pendingNtfySession = null;
const ntfyClusterNames = new Map();

function serviceButton(text, testid, className, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = text;
  button.dataset.testid = testid;
  button.addEventListener("click", action);
  return button;
}

async function shareNtfyService(service) {
  const { clusters } = await api("/api/clusters");
  const dialog = document.createElement("dialog");
  dialog.className = "ntfy-share-dialog";
  dialog.setAttribute("aria-labelledby", "ntfyShareHeading");
  const card = document.createElement("form");
  card.className = "dialog-card";
  card.method = "dialog";
  const heading = document.createElement("h2"); heading.id = "ntfyShareHeading"; heading.textContent = `Share ${service.name}`;
  const note = document.createElement("p"); note.textContent = "The server token grants publishing access. Choose exactly who receives it.";
  const twinsLabel = document.createElement("label");
  const twins = document.createElement("input"); twins.type = "checkbox"; twins.name = "twins"; twins.checked = service.sharing ? service.sharing.includeTwins : true; twins.dataset.testid = "ntfy-share-twins";
  twinsLabel.append(twins, document.createTextNode(" Active trusted twins"));
  const clusterTitle = document.createElement("h3"); clusterTitle.textContent = "Clusters";
  const clusterInputs = [];
  const clusterList = document.createElement("div"); clusterList.className = "ntfy-share-clusters";
  for (const cluster of clusters) {
    const label = document.createElement("label");
    const input = document.createElement("input"); input.type = "checkbox"; input.value = cluster.id; input.name = "cluster"; input.checked = Boolean(service.sharing?.clusterIds.includes(cluster.id)); input.dataset.testid = `ntfy-share-cluster-${cluster.id}`;
    clusterInputs.push(input);
    const members = cluster.members.map((member) => member.name).join(", ");
    label.append(input, document.createTextNode(` ${cluster.name}${members ? ` · ${members}` : ""}`));
    clusterList.append(label);
  }
  if (!clusters.length) { const empty = document.createElement("p"); empty.textContent = "No clusters configured."; clusterList.append(empty); }
  const actions = document.createElement("div"); actions.className = "dialog-actions";
  const cancel = serviceButton("Cancel", "ntfy-share-cancel", "ghost", () => dialog.close());
  const submit = serviceButton("Share", "ntfy-share-confirm", "primary", () => {}); submit.type = "submit";
  actions.append(cancel, submit);
  card.append(heading, note, twinsLabel, clusterTitle, clusterList, actions);
  card.addEventListener("submit", async (event) => {
    event.preventDefault();
    const clusterIds = clusterInputs.filter((input) => input.checked).map((input) => input.value);
    if (!twins.checked && !clusterIds.length) { toast("Choose twins or at least one cluster"); return; }
    submit.disabled = true;
    try {
      const { results } = await api(`/api/ntfy/services/${encodeURIComponent(service.id)}/share`, {
        method: "POST", body: JSON.stringify({ includeTwins: twins.checked, clusterIds }),
      });
      dialog.close();
      const pending = results.filter((result) => !result.ok).length;
      const delivered = results.length - pending;
      toast(pending
        ? `Sharing is on. Delivered to ${delivered} node${delivered === 1 ? "" : "s"}; ${pending} offline node${pending === 1 ? "" : "s"} will receive it when reachable`
        : `Sharing is on${results.length ? `; delivered to ${results.length} node${results.length === 1 ? "" : "s"}` : ""}`, pending ? 8000 : 3000);
      await loadNtfyServicesPanel();
    } catch (error) { toast(error.message, 8000); }
    finally { submit.disabled = false; }
  });
  dialog.append(card); document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  dialog.showModal();
}

function renderNtfyService(service) {
  const item = document.createElement("li");
  const label = document.createElement("span");
  const sharing = service.sharing && (service.sharing.includeTwins || service.sharing.clusterIds.length)
    ? ` · Shared with ${[service.sharing.includeTwins ? "twins" : null, ...service.sharing.clusterIds.map((id) => ntfyClusterNames.get(id) ?? "a cluster")].filter(Boolean).join(", ")}`
    : "";
  label.textContent = `${service.name} — ${service.url}${service.hasToken ? " · token" : ""}${service.isDefault ? " · Default" : ""}${sharing}`;
  const actions = document.createElement("span");
  actions.className = "ntfy-service-actions";
  if (!service.isDefault) actions.append(serviceButton("Make default", "ntfy-service-default-button", "ghost compact", async () => {
    try {
      await api(`/api/ntfy/services/${encodeURIComponent(service.id)}/default`, { method: "PUT" });
      await loadNtfyServicesPanel();
      toast(`${service.name} is the default ntfy service`);
    } catch (error) { toast(error.message, 8000); }
  }));
  actions.append(serviceButton("Manage", "ntfy-service-manage-button", "ghost compact", () => openNtfyManager(service, loadNtfyServicesPanel)));
  actions.lastChild.setAttribute("aria-label", `Manage ntfy service ${service.name}`);
  actions.append(serviceButton("Share", "ntfy-service-share-button", "ghost compact", async () => {
    try { await shareNtfyService(service); } catch (error) { toast(error.message, 8000); }
  }));
  const remove = serviceButton("Remove", "ntfy-service-remove-button", "ghost compact danger", async () => {
    try {
      await api(`/api/ntfy/services/${encodeURIComponent(service.id)}`, { method: "DELETE" });
      await loadNtfyServicesPanel();
      toast("ntfy service removed");
    } catch (error) { toast(error.message, 8000); }
  });
  remove.setAttribute("aria-label", `Remove ntfy service ${service.name}`);
  actions.append(remove);
  item.append(label, actions);
  return item;
}

/** Renders the central ntfy service list in Settings → Notifications. */
export async function loadNtfyServicesPanel() {
  try {
    const { services } = await api("/api/ntfy/services");
    if (services.some((service) => service.sharing?.clusterIds.length)) {
      try { for (const cluster of (await api("/api/clusters")).clusters) ntfyClusterNames.set(cluster.id, cluster.name); } catch { /* names are cosmetic */ }
    }
    elements.ntfyServiceList.replaceChildren(...services.map(renderNtfyService));
    syncNtfyManager(services);
  } catch (error) { toast(error.message, 8000); }
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
  elements.ntfyServiceSelect.replaceChildren(...services.map((service) => new Option(`${service.name} — ${service.url}`, service.id, service.isDefault, service.isDefault)));
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
