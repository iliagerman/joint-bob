function text(tag, value) { const node = document.createElement(tag); node.textContent = value; return node; }

function renderDetails(container, cluster, projects, localNodeId) {
  container.replaceChildren();
  if (!cluster) { container.append(text("p", "Create or join a cluster to get started. Membership alone does not share data.")); return; }
  const manager = cluster.members.find(member => member.nodeId === cluster.managerNodeId);
  container.append(text("h3", cluster.name), text("p", `Manager: ${manager.name} · ${cluster.members.length} members`));
  const members = document.createElement("ul"); members.className = "cluster-detail-list";
  for (const member of [...cluster.members].sort((a, b) => a.joinSequence - b.joinSequence)) {
    const row = document.createElement("li"); row.dataset.sharingNodeId = member.nodeId;
    row.append(text("span", member.name), text("small", [member.nodeId === localNodeId ? "this node" : "", member.nodeId === cluster.managerNodeId ? "manager" : ""].filter(Boolean).join(" · ")));
    members.append(row);
  }
  const shared = projects.filter(project => project.clusterIds?.includes(cluster.id)
    || project.accessByCluster?.[cluster.id]?.authorizedNodeIds.length > 1);
  const technical = document.createElement("details"); technical.dataset.testid = "cluster-technical";
  technical.append(text("summary", "Membership details"), text("p", `Manager epoch ${cluster.managerEpoch}`));
  for (const member of cluster.members) technical.append(text("p", `${member.name}: admission ${member.joinSequence}`));
  container.append(members, technical, projectInventory(shared, cluster));
}

function projectInventory(projects, cluster) {
  const section = document.createElement("details"); section.dataset.testid = "cluster-projects";
  const summary = text("summary", `Shared projects · ${projects.length}`); summary.dataset.testid = "cluster-project-summary";
  section.append(summary);
  section.append(text("p", "Authorized access between these nodes, including Twins. This does not confirm completed file sync. Unknown owner names appear as node IDs."));
  const label = text("label", "Search shared projects"), search = document.createElement("input");
  search.type = "search"; search.dataset.testid = "cluster-project-search";
  label.append(search);
  const list = document.createElement("ul"); list.className = "cluster-detail-list cluster-scroll-list"; list.dataset.testid = "cluster-project-list";
  const name = id => cluster.members.find(member => member.nodeId === id)?.name || id;
  for (const project of projects) {
    const row = document.createElement("li");
    const access = project.accessByCluster?.[cluster.id];
    const owner = access?.ownerNodeId || project.ownerNodeId;
    const recipients = access ? access.authorizedNodeIds.filter(id => id !== owner).map(name) : [];
    row.append(text("span", project.name), text("small", `Owner: ${project.ownerName || (owner ? name(owner) : "Unknown")} · Authorized recipients: ${access ? recipients.join(", ") || "None in this cluster" : "Unavailable"}`));
    list.append(row);
  }
  const empty = text("p", "No matching projects."); empty.hidden = projects.length > 0; empty.setAttribute("role", "status");
  search.addEventListener("input", () => {
    for (const row of list.children) row.hidden = !row.textContent.toLowerCase().includes(search.value.trim().toLowerCase());
    empty.hidden = [...list.children].some(row => !row.hidden);
  });
  section.append(label, list, empty); return section;
}

export function renderClusterCanvas({ canvas, details, clusters, projects, localNodeId, selectedClusterId, onSelect }) {
  canvas.replaceChildren();
  const label = text("label", "Cluster"), select = document.createElement("select");
  select.id = "clusterSelector"; select.dataset.testid = "cluster-selector"; label.htmlFor = select.id;
  for (const cluster of clusters) { const option = text("option", cluster.name); option.value = cluster.id; select.append(option); }
  if (!clusters.length) { const option = text("option", "No clusters yet"); option.value = ""; select.append(option); select.disabled = true; }
  select.value = selectedClusterId || "";
  select.addEventListener("change", () => {
    renderDetails(details, clusters.find(cluster => cluster.id === select.value), projects, localNodeId);
    onSelect(select.value);
  });
  label.append(select); canvas.append(label);
  renderDetails(details, clusters.find(cluster => cluster.id === selectedClusterId), projects, localNodeId);
}
