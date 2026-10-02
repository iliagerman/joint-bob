import { api } from "./api.js";
import { confirmAction, toast } from "./shell.js";

/**
 * Twins on the cluster page: who this node's twins are, requests between cluster members,
 * each twin's synchronization, and pairing by link with a node outside every cluster.
 * Pairing always needs both owners: one asks, the other accepts.
 */

const disclosure = "Twins copy everything they own to each other: projects, workspaces, conversations, tasks, files and credentials. Browser profiles and machine-local identities stay on each machine.";

export const twins = { localNodeId: null, relationships: [], requests: [], status: new Map(), inventory: null };

function text(tag, value, className) {
  const node = document.createElement(tag); node.textContent = value;
  if (className) node.className = className;
  return node;
}
function button(label, testid, className, action) {
  const control = text("button", label, className); control.type = "button"; control.dataset.testid = testid;
  control.addEventListener("click", async () => {
    control.disabled = true;
    try { await action(); } catch (error) { toast(error.message); } finally { control.disabled = false; }
  });
  return control;
}
export function badge(label, kind, testid) {
  const element = text("span", label, `cluster-badge ${kind}`);
  if (testid) element.dataset.testid = testid;
  return element;
}

export function activeTwin(nodeId) {
  return twins.relationships.find((item) => item.status === "active" && item.peer.nodeId === nodeId);
}
function request(direction, nodeId) {
  return twins.requests.find((item) => item.direction === direction && item.peerNodeId === nodeId);
}
export function twinNodeIds() {
  return twins.relationships.filter((item) => item.status === "active").map((item) => item.peer.nodeId);
}

export function syncLabel(data) {
  if (!data) return "Checking…";
  if (data.readError || data.state === "error") return "Error";
  if (!data.initialized) return "Not enabled";
  return data.state === "ready" && data.pendingDeliveries === 0 ? "Up to date" : "Syncing";
}

/** Loads relationships, requests and each twin's sync state. Returns a signature that changes when any of them does. */
export async function refreshTwins() {
  const [{ relationships }, { requests }] = await Promise.all([api("/api/twins"), api("/api/twins/requests")]);
  twins.relationships = relationships; twins.requests = requests;
  await Promise.all(relationships.filter((item) => item.status === "active").map(async (item) => {
    try { twins.status.set(item.relationshipId, await api(`/api/twins/${item.relationshipId}/sharing`)); }
    catch (error) { twins.status.set(item.relationshipId, { readError: error.message }); }
  }));
  return JSON.stringify([relationships.map(({ relationshipId, status }) => [relationshipId, status]),
    requests.map(({ relationshipId, direction }) => [relationshipId, direction]),
    [...twins.status].map(([id, data]) => [id, syncLabel(data), data.error || data.readError || "", data.projectCount ?? 0])]);
}

/** Reachability and names of the twins; slow when a twin is down, so it never blocks the page. */
export async function refreshTwinInventory() {
  twins.inventory = await api("/api/cluster/inventory");
}

async function consent(title, message, confirmLabel, destructive = false) {
  return confirmAction({ eyebrow: "Twins", title, message: `${message} ${disclosure}`, confirmLabel, destructive });
}

async function askToPair(cluster, member, onChange) {
  const name = member.name || member.nodeId;
  if (!await consent(`Ask ${name} to be twins?`, `${name}'s owner will see the request in their Cluster settings and has 15 minutes to accept it.`, "Send twin request")) return;
  await api(`/api/clusters/${cluster.id}/members/${member.nodeId}/twin-request`, { method: "POST", body: JSON.stringify({ confirmOwnedData: true }) });
  toast(`Twin request sent to ${name}`);
  await onChange();
}

async function acceptRequest(item, onChange) {
  if (!await consent(`Become twins with ${item.peerName}?`, "Synchronization starts as soon as you accept.", "Accept and pair")) return;
  await api(`/api/twins/requests/${item.relationshipId}/accept`, { method: "POST", body: JSON.stringify({ confirmOwnedData: true }) });
  toast(`${item.peerName} is now your twin`);
  await onChange({ projects: true });
}

async function declineRequest(item, onChange) {
  await api(`/api/twins/requests/${item.relationshipId}`, { method: "DELETE" });
  toast("Twin request declined");
  await onChange();
}

export async function unpair(relationship, name, onChange) {
  if (!await confirmAction({ eyebrow: "Twins", title: `Stop being twins with ${name}?`, message: `Nothing new is copied between this node and ${name}. Files already copied stay where they are. Sharing through clusters is unchanged.`, confirmLabel: "Unpair", destructive: true })) return;
  const result = await api(`/api/twins/${relationship.relationshipId}`, { method: "DELETE" });
  toast(result.pending ? `Unpaired here; ${name} will be told when it is reachable` : `Unpaired from ${name}`);
  await onChange({ projects: true });
}

export async function declareLost(relationship, name, onChange) {
  if (!await confirmAction({ eyebrow: "Twins", title: `Declare ${name} lost?`, message: `Only when ${name} is gone for good. This node becomes the owner of everything ${name} owned, removes it from its clusters, and unpairs it. A rebuilt machine gets everything back by pairing as a twin with this node.`, confirmLabel: "Declare lost", destructive: true })) return;
  const result = await api(`/api/twins/${relationship.relationshipId}/lost`, { method: "POST", body: JSON.stringify({ confirmLost: true }) });
  toast(`${name} was declared lost. This node now owns its ${result.projects} project${result.projects === 1 ? "" : "s"}.`);
  await onChange({ projects: true });
}

/** Badges and the twin action for one cluster member. */
export function memberTwinControls(cluster, member, onChange) {
  const badges = document.createElement("span"); badges.className = "cluster-badges";
  const actions = document.createElement("div"); actions.className = "cluster-node-actions";
  if (member.nodeId === twins.localNodeId) return { badges, actions };
  const relationship = activeTwin(member.nodeId);
  if (relationship) {
    const status = twins.status.get(relationship.relationshipId);
    badges.append(badge("Twin", "twin", `cluster-member-twin-${member.nodeId}`));
    const sync = badge(syncLabel(status), syncLabel(status) === "Error" ? "error" : syncLabel(status) === "Up to date" ? "ok" : "", `cluster-member-sync-${member.nodeId}`);
    sync.title = status?.error || status?.readError || "Synchronization between the twins";
    badges.append(sync);
    actions.append(button("Unpair", `cluster-member-unpair-${member.nodeId}`, "ghost compact", () => unpair(relationship, member.name || member.nodeId, onChange)));
    return { badges, actions };
  }
  const incoming = request("incoming", member.nodeId);
  if (incoming) {
    actions.append(button("Accept twin", `cluster-member-accept-${member.nodeId}`, "primary compact", () => acceptRequest(incoming, onChange)),
      button("Decline", `cluster-member-decline-${member.nodeId}`, "ghost compact", () => declineRequest(incoming, onChange)));
    return { badges, actions };
  }
  const outgoing = request("outgoing", member.nodeId);
  if (outgoing) {
    const minutes = Math.max(1, Math.round((outgoing.expiresAt - Date.now()) / 60_000));
    actions.append(badge(`Request sent · ${minutes} min left`, "", `cluster-member-requested-${member.nodeId}`));
    return { badges, actions };
  }
  actions.append(button("Make twin", `cluster-member-make-twin-${member.nodeId}`, "ghost compact accent", () => askToPair(cluster, member, onChange)));
  return { badges, actions };
}

/** A banner per incoming twin request, above the cluster list, so it is seen whichever cluster is open. */
export function renderTwinRequests(container, clusters, onChange) {
  const incoming = twins.requests.filter((item) => item.direction === "incoming");
  container.replaceChildren(...incoming.map((item) => {
    const row = document.createElement("div"); row.className = "cluster-request"; row.dataset.testid = "cluster-twin-request";
    const cluster = clusters.find((candidate) => candidate.id === item.clusterId);
    const message = document.createElement("p");
    message.append(text("strong", item.peerName), document.createTextNode(` asks to be twins with this node${cluster ? ` (via ${cluster.name})` : ""}. Twins copy everything they own to each other, including credentials.`));
    row.append(message,
      button("Accept", "cluster-twin-request-accept", "primary compact", () => acceptRequest(item, onChange)),
      button("Decline", "cluster-twin-request-decline", "ghost compact", () => declineRequest(item, onChange)));
    return row;
  }));
}

export function twinName(nodeId, clusters) {
  for (const cluster of clusters) {
    const member = cluster.members.find((candidate) => candidate.nodeId === nodeId);
    if (member?.name) return member.name;
  }
  return twins.inventory?.remote.find((item) => item.peerId === nodeId)?.name || nodeId;
}

/** Sharing controls a twin needs when its durable sharing never started or last failed. */
function twinSharingControls(relationship, status, clusters, onChange) {
  const box = document.createElement("div"); box.className = "cluster-twin-sharing";
  if (!status || status.readError || (status.initialized && status.state !== "error")) return box;
  let ownerNodeId = status.ownerNodeId;
  if (!status.initialized) {
    const label = text("label", "Original owner for data neither node has claimed");
    const select = document.createElement("select"); select.name = "ownerNodeId"; select.dataset.testid = "twin-sharing-owner";
    for (const nodeId of [twins.localNodeId, relationship.peer.nodeId]) select.append(new Option(nodeId === twins.localNodeId ? "This node" : twinName(nodeId, clusters), nodeId));
    select.value = ownerNodeId || twins.localNodeId;
    ownerNodeId = select.value;
    select.addEventListener("change", () => { ownerNodeId = select.value; });
    label.append(select); box.append(label);
  }
  const mode = status.initialized ? "retry" : "enable";
  box.append(button(mode === "enable" ? "Enable sharing" : "Retry sharing", `twin-${mode}-sharing`, "ghost compact", async () => {
    if (!await consent(mode === "enable" ? "Start twin sharing?" : "Retry twin sharing?", "Both nodes already agreed to be twins. Existing owners stay unchanged.", mode === "enable" ? "Enable sharing" : "Retry")) return;
    await api(`/api/twins/${relationship.relationshipId}/sharing`, { method: "POST", body: JSON.stringify({ ownerNodeId, confirmOwnedData: true }) });
    await onChange();
  }));
  return box;
}

/** "This node and its twins": reachability, sync state and the twin-level actions. */
export function renderTwinSection(container, clusters, onChange) {
  const localName = twins.inventory?.local.name || twinName(twins.localNodeId, clusters);
  const rows = [nodeRow({ name: localName, url: twins.inventory?.local.url || "", status: "This node", state: "local" })];
  for (const relationship of twins.relationships.filter((item) => item.status === "active")) {
    const nodeId = relationship.peer.nodeId, name = twinName(nodeId, clusters);
    const reach = twins.inventory?.remote.find((item) => item.peerId === nodeId);
    const status = twins.status.get(relationship.relationshipId);
    const row = nodeRow({ name, url: reach?.url || "", status: !reach ? "Checking…" : reach.reachable ? "Connected" : `Not connected — ${reach.error}`, state: !reach ? "checking" : reach.reachable ? "online" : "offline" });
    const sync = text("p", `${syncLabel(status)} · ${status?.projectCount ?? 0} twin-shared projects${status?.error || status?.readError ? ` · ${status.error || status.readError}` : ""}`, "cluster-twin-sync");
    sync.dataset.testid = "twin-sharing-status"; sync.setAttribute("role", "status");
    const actions = document.createElement("div"); actions.className = "cluster-node-actions";
    actions.append(button("Unpair", "twin-unpair", "ghost compact", () => unpair(relationship, name, onChange)),
      button("Machine lost…", "sharing-twin-lost", "ghost compact danger", () => declareLost(relationship, name, onChange)));
    row.append(sync, twinSharingControls(relationship, status, clusters, onChange), actions);
    rows.push(row);
  }
  container.replaceChildren(...rows);
}

function nodeRow({ name, url, status, state }) {
  const row = document.createElement("div"); row.className = "cluster-node"; row.dataset.testid = "cluster-node-row"; row.dataset.state = state;
  const dot = document.createElement("span"); dot.className = "cluster-node-dot";
  const identity = document.createElement("div"); identity.className = "cluster-node-identity";
  identity.append(text("strong", name), text("span", url, "cluster-node-url"));
  const label = text("span", status, "cluster-node-status"); label.dataset.testid = "cluster-node-status";
  row.append(dot, identity, label);
  return row;
}

/** Pairing by link, for a twin that shares no cluster with this node. Built once so a pasted link survives refreshes. */
export function renderTwinLink(container, onChange) {
  if (container.childElementCount) return;
  const details = document.createElement("details"); details.className = "cluster-twin-link";
  details.append(text("summary", "Pair by link instead"));
  const outgoing = document.createElement("input");
  Object.assign(outgoing, { readOnly: true, name: "twinLink", autocomplete: "off", spellcheck: false }); outgoing.dataset.testid = "twin-link";
  const incoming = document.createElement("input");
  Object.assign(incoming, { name: "twinAcceptLink", autocomplete: "off", spellcheck: false, placeholder: "Paste a twin link" }); incoming.dataset.testid = "twin-accept-link";
  const outgoingLabel = text("label", "One-time twin link for the other node"), incomingLabel = text("label", "Accept a twin link from another node");
  outgoingLabel.append(outgoing); incomingLabel.append(incoming);
  details.append(text("p", "Any node holding the link can accept it within 15 minutes, so send it only to the machine you mean."),
    button("Generate twin link", "twin-invite", "ghost compact", async () => {
      if (!await consent("Create a twin link?", "The node that accepts this link becomes this node's twin.", "Create link")) return;
      outgoing.value = (await api("/api/twins/invitations", { method: "POST", body: JSON.stringify({ confirmOwnedData: true }) })).link;
    }), outgoingLabel, incomingLabel,
    button("Accept twin link", "twin-accept", "ghost compact", async () => {
      const link = incoming.value.trim();
      if (!link) throw new Error("Paste the twin link first");
      if (!await consent("Accept this twin link?", "Synchronization starts as soon as you accept.", "Accept and pair")) return;
      await api("/api/twins/accept", { method: "POST", body: JSON.stringify({ link, confirmOwnedData: true }) });
      incoming.value = ""; toast("Twin paired");
      await onChange({ projects: true });
    }));
  container.append(details);
}
