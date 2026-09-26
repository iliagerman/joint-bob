import { api } from "./api.js";
import { confirmAction } from "./shell.js";

const container = document.getElementById("clusterSharing");
let revision = 0;
let refreshTimer;
const selectedPeers = new Map();
const disclosure = "Browser profiles, website credentials and machine-local identities stay local. Eligible environment secrets replicate only when permitted.";
function text(tag, content) { const element = document.createElement(tag); element.textContent = content; return element; }
function button(label, id, action) {
  const control = text("button", label); control.type = "button"; control.className = "ghost"; control.dataset.testid = id;
  control.addEventListener("click", async () => {
    control.disabled = true;
    const current = revision;
    try { await action(); } catch (error) { if (current === revision) { const status = container.querySelector('[data-testid="sharing-status"]'); status.textContent = error.message; } }
    finally { control.disabled = false; }
  });
  return control;
}
function input(label, id, readonly = false) {
  const wrapper = text("label", label), field = document.createElement("input"); field.dataset.testid = id; field.name = id; field.autocomplete = "off"; field.spellcheck = false; field.readOnly = readonly;
  wrapper.append(field); return { wrapper, field };
}
async function consent(title, message, destructive = false) {
  const current = revision;
  const approved = await confirmAction({ title, message: `${message} ${disclosure}`, confirmLabel: destructive ? "Revoke twin access" : "Confirm sharing", destructive });
  return approved && current === revision;
}
function scopes(data, kind, labelKey, selected) {
  const group = document.createElement("details"); group.dataset.testid = `sharing-${kind}-list`;
  const summary = text("summary", ""); summary.dataset.testid = `sharing-${kind}-summary`;
  const title = kind === "project" ? "Projects" : "Whole workspaces (including future projects)";
  const updateCount = () => { summary.textContent = `${title} · ${data.length} · ${group.querySelectorAll("input[type=checkbox]:checked").length} selected`; };
  const label = text("label", `Search ${kind === "project" ? "projects" : "workspaces"}`), search = document.createElement("input");
  search.type = "search"; search.dataset.testid = `sharing-${kind}-search`; label.append(search);
  const list = document.createElement("div"); list.className = "cluster-scroll-list";
  const empty = text("p", "No matches."); empty.hidden = true; empty.setAttribute("role", "status");
  search.addEventListener("input", () => {
    for (const row of list.children) row.hidden = !row.textContent.toLowerCase().includes(search.value.trim().toLowerCase());
    empty.hidden = [...list.children].some(row => !row.hidden);
  });
  group.addEventListener("change", updateCount);
  group.append(summary, label, list, empty);
  for (const item of data) {
    const row = text("label", ""); row.className = "checkbox-row";
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.name = `${kind}Ids`; checkbox.value = item.id; checkbox.checked = selected.includes(item.id);
    checkbox.dataset.testid = `sharing-${kind}-${item.id}`; row.append(checkbox, document.createTextNode(item[labelKey])); list.append(row);
  }
  if (!data.length) group.append(text("p", "None available on this node."));
  updateCount();
  return group;
}
async function selectedSharing(body, cluster, status) {
  const data = await api(`/api/clusters/${cluster.id}/sharing`);
  if (!body.isConnected) return;
  const projects = scopes(data.projects, "project", "name", data.projectIds);
  const workspaces = scopes(data.workspaces, "workspace", "label", data.workspaceIds);
  status.textContent = `Cluster-wide selected sharing · ${data.pendingDeliveries} pending deliveries. Membership alone does not enable Twin sharing.`;
  body.append(text("h4", "Connection approval"), text("p", "No active twin connection with this peer. To connect as Twins, choose Twins, generate an invitation and accept it on the other node."), text("h4", "Data sharing"), text("p", `Share outbound from this node with all members of ${cluster.name}, not just one peer. Cluster members: ${cluster.members.map(member => member.name || member.nodeId).join(", ")}. You can add or remove selections later. Removing sharing does not delete existing files.`), projects, workspaces);
  body.append(button("Save selected sharing", "sharing-save", async () => {
    if (!await consent("Save selected sharing?", `Update sharing with all members of ${cluster.name}? Existing files remain on other nodes.`)) return;
    const checked = group => [...group.querySelectorAll("input:checked")].map(control => control.value);
    const result = await api(`/api/clusters/${cluster.id}/sharing`, { method: "PUT", body: JSON.stringify({ projectIds: checked(projects), workspaceIds: checked(workspaces), confirmOwnedData: true }) });
    status.textContent = `Selection saved · ${result.pendingDeliveries} pending deliveries`;
  }));
}
function handshake(body, reload) {
  body.append(text("p", "Twins share all current and future eligible projects, workspaces, conversations, tasks, files and credentials. Both nodes must consent: generate a one-time invitation here, then accept it on the other node. Acceptance starts synchronization immediately; transfers continue in the background. Cluster membership alone does not enable Twins. Invitations are not bound to the selected peer: any node holding the link can accept it. Verify the other node before exchanging links."));
  const outgoing = input("One-time twin invitation", "twin-link", true);
  const incoming = input("Accept a twin invitation from another node", "twin-accept-link");
  body.append(button("Generate twin invitation", "twin-invite", async () => {
    if (!await consent("Invite a twin?", "Allow sharing of all current and future eligible projects, workspaces, conversations, tasks, files and credentials with the node that accepts this invitation? Synchronization starts when it accepts.")) return;
    const result = await api("/api/twins/invitations", { method: "POST", body: JSON.stringify({ confirmOwnedData: true }) }); outgoing.field.value = result.link;
  }), outgoing.wrapper, incoming.wrapper, button("Accept twin invitation", "twin-accept", async () => {
    const link = incoming.field.value.trim(); if (!link) throw new Error("Twin invitation link is required");
    if (!await consent("Accept twin sharing?", "Start sharing all current and future eligible projects, workspaces, conversations, tasks, files and credentials between both nodes immediately?")) return;
    await api("/api/twins/accept", { method: "POST", body: JSON.stringify({ link, confirmOwnedData: true }) }); await reload();
  }));
}
function syncLabel(data) {
  if (data.state === "error") return "Error";
  if (!data.initialized) return "Not enabled";
  return data.state === "ready" && data.pendingDeliveries === 0 ? "Up to date" : "Syncing";
}
function twinSharing(body, relationship, cluster, localNodeId, reload) {
  const section = document.createElement("fieldset");
  const peer = cluster.members.find(member => member.nodeId === relationship.peer.nodeId);
  section.append(text("legend", `Twin · ${peer.name || peer.nodeId}`), text("h4", "Connection approval"), text("p", "Approval complete. This existing twin needs no second invitation or approval.")); body.append(section);
  const sharingState = text("p", "Checking sharing…"); sharingState.dataset.testid = "twin-data-sharing";
  section.append(text("h4", "Data sharing"), sharingState, text("h4", "Synchronization status"));
  const status = text("p", "Checking synchronization…"); status.dataset.testid = "twin-sharing-status"; status.setAttribute("role", "status");
  const technical = document.createElement("details");
  technical.append(text("summary", "Transfer details"));
  const deliveryStatus = text("p", ""); technical.append(deliveryStatus);
  const actions = document.createElement("div"); section.append(status, technical, actions);
  let previousMode;
  return data => {
    if (!body.isConnected) return;
    if (data.readError) { sharingState.textContent = "Sharing status unavailable. Refresh to check again."; status.textContent = `Error · ${data.readError}. Check peer connectivity. Status retries automatically, or use Refresh sharing status.`; return; }
    sharingState.textContent = data.initialized ? "Enabled for current and future eligible data." : "Sharing not started. Enable sharing below; no action is needed on the other node.";
    status.textContent = `${syncLabel(data)} · ${data.projectCount} Twin-shared projects${data.error ? ` · ${data.error}. Check peer connectivity and retry.` : ""}`;
    deliveryStatus.textContent = `${data.pendingDeliveries} pending deliveries`;
    const mode = !data.initialized ? "enable" : data.state === "error" ? "retry" : "sync";
    if (mode === previousMode) return;
    previousMode = mode; actions.replaceChildren();
    if (mode === "sync") { actions.append(text("p", "Sharing is enabled for current and future eligible data. Status updates automatically; file transfers may take time.")); return; }
    let ownerNodeId = data.ownerNodeId;
    if (mode === "enable") {
      const owner = text("label", "Original owner for unassigned mirrored data"), select = document.createElement("select");
      select.dataset.testid = "twin-sharing-owner"; select.name = "ownerNodeId";
      for (const nodeId of [localNodeId, relationship.peer.nodeId]) { const option = text("option", cluster.members.find(member => member.nodeId === nodeId)?.name || nodeId); option.value = nodeId; select.append(option); }
      select.value = [localNodeId, relationship.peer.nodeId].includes(cluster.managerNodeId) ? cluster.managerNodeId : data.ownerNodeId;
      ownerNodeId = select.value; select.addEventListener("change", () => { ownerNodeId = select.value; });
      owner.append(select); actions.append(owner, text("p", "This existing twin has not enabled durable sharing. Existing original owners, project IDs and paths are preserved."));
    }
    actions.append(button(mode === "enable" ? "Enable sharing" : "Retry sharing", `twin-${mode}-sharing`, async () => {
      if (!await consent(mode === "enable" ? "Enable twin sharing?" : "Retry twin sharing?", "Both nodes have consented to Twins. Start sharing all current and future eligible projects, workspaces, conversations, tasks, files and credentials now? Existing original owners remain unchanged.")) return;
      await api(`/api/twins/${relationship.relationshipId}/sharing`, { method: "POST", body: JSON.stringify({ ownerNodeId, confirmOwnedData: true }) }); await reload();
    }));
  };
}
function memberTwinStatus(relationship, data) {
  const member = document.querySelector(`[data-sharing-node-id="${CSS.escape(relationship.peer.nodeId)}"]`);
  if (!member) return;
  let badge = member.querySelector(".twin-badge");
  if (!badge) {
    badge = text("span", "Twin"); badge.className = "twin-badge"; badge.dataset.testid = `cluster-member-twin-${relationship.peer.nodeId}`;
    const status = text("small", "Checking synchronization…"); status.className = "twin-sync-state"; status.dataset.testid = `cluster-member-sync-${relationship.peer.nodeId}`;
    status.setAttribute("role", "status"); member.append(badge, status);
  }
  const status = member.querySelector(".twin-sync-state");
  status.textContent = data ? syncLabel(data) : "Checking synchronization…";
  status.dataset.state = data ? syncLabel(data) : "checking";
  status.title = data?.error || "Synchronization status, separate from Twin consent";
}
function peerSelector(cluster, localNodeId, reload) {
  const peers = cluster.members.filter(member => member.nodeId !== localNodeId);
  if (!peers.length) { selectedPeers.delete(cluster.id); return null; }
  const label = text("label", "Sharing peer"), select = document.createElement("select");
  select.name = "sharingPeerNodeId"; select.dataset.testid = "sharing-peer";
  for (const peer of peers) { const option = text("option", peer.name || peer.nodeId); option.value = peer.nodeId; select.append(option); }
  const previous = selectedPeers.get(cluster.id);
  select.value = peers.some(peer => peer.nodeId === previous) ? previous : peers[0].nodeId;
  selectedPeers.set(cluster.id, select.value);
  select.addEventListener("change", () => { selectedPeers.set(cluster.id, select.value); void reload(); });
  select.id = "sharingPeer"; label.htmlFor = select.id;
  const row = document.createElement("div"); row.append(label, select); return row;
}
function watchSharing(cluster, relationships, current, reload, updateTwin, status) {
  const activeInCluster = items => items.filter(item => item.status === "active" && cluster.members.some(member => member.nodeId === item.peer.nodeId));
  const signature = items => activeInCluster(items).map(item => item.relationshipId).sort().join(",");
  const initialSignature = signature(relationships);
  const active = activeInCluster(relationships);
  for (const element of document.querySelectorAll(".twin-badge, .twin-sync-state")) element.remove();
  for (const item of active) memberTwinStatus(item);
  async function refresh(checkRelationships) {
    try {
      if (current !== revision || !container.checkVisibility()) return;
      if (checkRelationships) {
        const result = await api("/api/twins");
        if (current !== revision) return;
        if (signature(result.relationships) !== initialSignature) {
          if (!status.parentElement.querySelector('[data-testid="sharing-save"]')) { await reload(); return; }
          status.textContent = "Twin connections changed. Use Refresh sharing status to load them. Your current selections are unchanged.";
          return;
        }
      }
      await Promise.all(active.map(async item => {
        try {
          const data = await api(`/api/twins/${item.relationshipId}/sharing`);
          if (current !== revision) return;
          memberTwinStatus(item, data); updateTwin(item, data);
        } catch (error) {
          if (current !== revision) return;
          memberTwinStatus(item, { state: "error", error: error.message });
          updateTwin(item, { readError: error.message });
        }
      }));
    } catch (error) {
      if (current !== revision) return;
      for (const item of active) {
        memberTwinStatus(item, { state: "error", error: error.message });
        updateTwin(item, { readError: error.message });
      }
      if (!active.length) status.textContent = `Cannot check Twins: ${error.message}. Refresh sharing status to retry.`;
    } finally {
      if (current === revision) refreshTimer = setTimeout(() => void refresh(true), 2000);
    }
  }
  void refresh(false);
}
export async function renderClusterSharing(cluster, localNodeId) {
  const current = ++revision; clearTimeout(refreshTimer); container.replaceChildren(); container.hidden = !cluster;
  if (!cluster) return;
  const status = text("p", "Loading sharing…"); status.dataset.testid = "sharing-status"; status.setAttribute("role", "status");
  const controls = document.createElement("div"); controls.className = "github-group-actions";
  let body = document.createElement("div"), updateTwin = () => {};
  function resetBody() { const next = document.createElement("div"); body.replaceWith(next); body = next; }
  const reload = () => current === revision ? renderClusterSharing(cluster, localNodeId) : Promise.resolve();
  const peer = peerSelector(cluster, localNodeId, reload);
  const exclusions = document.createElement("details"); exclusions.append(text("summary", "What stays local"), text("p", disclosure));
  container.append(text("h3", "Peer connection and sharing"), text("p", "Membership alone does not share data. Twin sharing includes all eligible current and future projects, workspaces, conversations, tasks, files and credentials."), exclusions);
  if (!peer) { container.append(text("p", "No other nodes in this cluster. Add a member to choose sharing between two nodes.")); return; }
  container.append(peer, controls, status, body);
  controls.append(button("Refresh sharing status", "sharing-refresh", reload));
  try {
    const { relationships } = await api("/api/twins"); if (current !== revision) return;
    const active = relationships.filter(item => item.status === "active" && item.peer.nodeId === selectedPeers.get(cluster.id));
    const selected = button(active.length ? "Revoke selected twin access" : "Cluster-wide selected sharing",  "sharing-mode-selected", async () => {
      if (active.length) {
        if (!await consent("Switch to Selected sharing?", `Revoke twin access with ${cluster.members.find(member => member.nodeId === selectedPeers.get(cluster.id)).name || selectedPeers.get(cluster.id)} only? Existing files remain. Other twins and explicit cluster shares are unchanged.`, true)) return;
        let pending = false;
        for (const item of active) { const result = await api(`/api/twins/${item.relationshipId}`, { method: "DELETE" }); pending ||= result.pending; }
        await reload();
        if (pending && current + 1 === revision) container.querySelector('[data-testid="sharing-status"]').append(document.createTextNode(" · Twin access revoked locally; peer revocation delivery pending. Refresh to check sharing."));
        return;
      }
      selected.setAttribute("aria-pressed", "true"); twins.setAttribute("aria-pressed", "false"); resetBody(); await selectedSharing(body, cluster, status);
    });
    const twins = button("Twins", "sharing-mode-twins", async () => {
      selected.setAttribute("aria-pressed", "false"); twins.setAttribute("aria-pressed", "true"); resetBody();
      status.textContent = active.length ? "Twin relationship established. Synchronization status is separate below." : "Twins not enabled. Exchange an invitation to give both-node consent and start sharing.";
      for (const item of active) updateTwin = twinSharing(body, item, cluster, localNodeId, reload);
      if (!active.length) handshake(body, reload);
    });
    controls.prepend(selected, twins);
    selected.setAttribute("aria-pressed", String(!active.length)); twins.setAttribute("aria-pressed", String(active.length > 0));
    if (active.length) {
      status.textContent = "Twin relationship established. Synchronization status is separate below.";
      for (const item of active) updateTwin = twinSharing(body, item, cluster, localNodeId, reload);
    } else {
      status.textContent = "Connection approval: not established as Twins. For twin sharing, choose Twins and accept the invitation on the other node. Cluster-wide selected sharing is independent.";
      await selectedSharing(body, cluster, status);
    }
    if (current !== revision) return;
    watchSharing(cluster, relationships, current, reload, (item, data) => {
      if (item.peer.nodeId === selectedPeers.get(cluster.id)) updateTwin(data);
    }, status);
  } catch (error) { status.textContent = `Sharing unavailable: ${error.message}. Refresh to retry.`; }
}
