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
  const shared = projects.filter(project => project.clusterIds?.includes(cluster.id));
  const technical = document.createElement("details"); technical.dataset.testid = "cluster-technical";
  technical.append(text("summary", "Membership details"), text("p", `Manager epoch ${cluster.managerEpoch}`));
  for (const member of cluster.members) technical.append(text("p", `${member.name}: admission ${member.joinSequence}`));
  const projectList = document.createElement("ul"); projectList.className = "cluster-detail-list";
  for (const project of shared) projectList.append(text("li", project.name));
  container.append(members, technical, text("h4", `Cluster-shared projects on this node · ${shared.length}`), text("p", "Counts cluster-wide shares. Additional Twin-only sharing appears under the selected peer below."), projectList);
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
