const svgNamespace = "http://www.w3.org/2000/svg";

function memberDiagram(cluster, localNodeId) {
  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("viewBox", "0 0 240 72");
  svg.setAttribute("aria-hidden", "true");
  const members = [...cluster.members].sort((left, right) => left.joinSequence - right.joinSequence);
  members.forEach((member, index) => {
    const x = members.length === 1 ? 120 : 24 + index * (192 / (members.length - 1));
    if (index) {
      const line = document.createElementNS(svgNamespace, "line");
      line.setAttribute("x1", String(members.length === 2 ? 24 : 24 + (index - 1) * (192 / (members.length - 1))));
      line.setAttribute("x2", String(x));
      line.setAttribute("y1", "36"); line.setAttribute("y2", "36");
      svg.append(line);
    }
    const node = document.createElementNS(svgNamespace, "circle");
    node.setAttribute("cx", String(x)); node.setAttribute("cy", "36"); node.setAttribute("r", member.nodeId === localNodeId ? "11" : "8");
    node.dataset.manager = String(member.nodeId === cluster.managerNodeId);
    svg.append(node);
  });
  return svg;
}

function countProjects(projects, clusterId) {
  return projects.filter((project) => project.clusterIds?.includes(clusterId)).length;
}

function renderDetails(container, cluster, projects, localNodeId) {
  container.replaceChildren();
  if (!cluster) {
    const empty = document.createElement("p"); empty.textContent = "Create or join a cluster to inspect its membership."; container.append(empty); return;
  }
  const heading = document.createElement("h3"); heading.textContent = cluster.name;
  const memberHeading = document.createElement("h4"); memberHeading.textContent = `Members · ${cluster.members.length}`;
  const memberList = document.createElement("ol"); memberList.className = "cluster-detail-list";
  for (const member of [...cluster.members].sort((a, b) => a.joinSequence - b.joinSequence)) {
    const item = document.createElement("li"); item.dataset.sharingNodeId = member.nodeId;
    const name = document.createElement("span"); name.textContent = member.name;
    const labels = document.createElement("small");
    const badges = [`admission ${member.joinSequence}`];
    if (member.nodeId === localNodeId) badges.push("this node");
    if (member.nodeId === cluster.managerNodeId) badges.push("manager");
    labels.textContent = badges.join(" · "); item.append(name, labels); memberList.append(item);
  }
  const shared = projects.filter((project) => project.clusterIds?.includes(cluster.id));
  const projectHeading = document.createElement("h4"); projectHeading.textContent = `Projects available on this node · ${shared.length}`;
  const projectList = document.createElement("ul"); projectList.className = "cluster-detail-list";
  for (const project of shared) { const item = document.createElement("li"); item.textContent = project.name; projectList.append(item); }
  if (!shared.length) { const item = document.createElement("li"); item.textContent = "No shared projects are available on this node."; projectList.append(item); }
  container.append(heading, memberHeading, memberList, projectHeading, projectList);
}

export function renderClusterCanvas({ canvas, details, clusters, projects, localNodeId, selectedClusterId, onSelect }) {
  canvas.replaceChildren();
  if (!clusters.length) {
    const empty = document.createElement("p"); empty.className = "cluster-canvas-empty"; empty.textContent = "No cluster memberships yet."; canvas.append(empty);
  }
  for (const cluster of clusters) {
    const button = document.createElement("button"); button.type = "button"; button.className = "cluster-island";
    button.dataset.testid = "cluster-canvas-cluster"; button.dataset.clusterId = cluster.id;
    button.setAttribute("aria-pressed", String(cluster.id === selectedClusterId));
    button.setAttribute("aria-label", `${cluster.name}, ${cluster.members.length} members, ${countProjects(projects, cluster.id)} projects available on this node`);
    const label = document.createElement("span"); label.className = "cluster-island-title"; label.textContent = cluster.name;
    const meta = document.createElement("span"); meta.className = "cluster-island-meta";
    meta.textContent = `${cluster.members.length} admitted · ${countProjects(projects, cluster.id)} projects available · epoch ${cluster.managerEpoch}`;
    button.append(label, memberDiagram(cluster, localNodeId), meta);
    button.addEventListener("click", () => {
      for (const card of canvas.querySelectorAll("[data-cluster-id]")) card.setAttribute("aria-pressed", String(card === button));
      renderDetails(details, cluster, projects, localNodeId); onSelect(cluster.id);
    });
    canvas.append(button);
  }
  renderDetails(details, clusters.find((cluster) => cluster.id === selectedClusterId), projects, localNodeId);
}
