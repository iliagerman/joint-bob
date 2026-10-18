import { api } from "./api.js";
import { openGitReview } from "./git-review.js";
import { toast } from "./shell.js";
import { projectGitUrl } from "./project-git-url.js";

let generation = 0;
const picker = document.querySelector("#gitReviewRepository");
const machine = document.querySelector("#gitReviewNode");
const controls = document.querySelector("#gitReviewRepositories");
const note = document.querySelector("#gitReviewRepositoryNote");

export async function openProjectGit(project, { nodeId = "", repository, tab = "changes" } = {}) {
  const version = ++generation;
  const context = { projectId: project.id, nodeId, repository, taskId: null };
  await openGitReview(null, { tab, context, prepare: async () => {
    controls.hidden = false;
    picker.disabled = true;
    picker.replaceChildren(new Option("Loading repositories…", ""));
    machine.disabled = true;
    machine.replaceChildren(new Option("This node", ""));
    note.textContent = "";
    const nodes = await api(`/api/projects/${encodeURIComponent(project.id)}/session-nodes`).catch(() => ({ nodes: [] }));
    if (version !== generation) return false;
    for (const item of nodes.nodes.filter((item) => !item.local && item.mapped)) {
      const option = new Option(`${item.name}${item.online ? "" : " (offline)"}`, item.id);
      machine.add(option);
    }
    if (nodeId && ![...machine.options].some((option) => option.value === nodeId)) machine.add(new Option("Selected machine (unavailable)", nodeId));
    machine.value = nodeId;
    machine.disabled = false;
    machine.onchange = () => { void openProjectGit(project, { nodeId: machine.value, tab: activeTab() }); };
    document.querySelector("#gitReviewRepositoryRefresh").onclick = () => { void openProjectGit(project, { nodeId, repository: context.repository, tab: activeTab() }); };
    const inventory = await api(projectGitUrl({ ...context, repository: undefined }, "repositories"));
    if (version !== generation) return false;
    picker.replaceChildren(...inventory.repositories.map((repo) => new Option(repo.path === "." ? `${repo.name} (project root)` : repo.path, repo.path)));
    const missing = repository && !inventory.repositories.some((repo) => repo.path === repository);
    if (missing) picker.prepend(new Option(`${repository} (unavailable)`, repository));
    if (repository) picker.value = repository;
    context.repository = picker.value;
    picker.disabled = !inventory.repositories.length;
    note.textContent = inventory.truncated ? "Repository scan reached its limit. Some folders may be missing." : "";
    picker.onchange = () => { void openProjectGit(project, { nodeId, repository: picker.value, tab: activeTab() }); };
    if (missing) {
      note.textContent = "Selected repository is no longer available. Choose another repository explicitly.";
      return false;
    }
    if (!inventory.repositories.length) {
      picker.add(new Option("No Git repositories found", ""));
      note.textContent ||= "No Git repositories found in this project on this machine.";
      return false;
    }
    return true;
  } }).catch((error) => toast(error.message, 8000));
}

function activeTab() {
  return document.querySelector(".git-review-tab.is-active")?.dataset.gitTab ?? "changes";
}

document.querySelector("#gitReviewDialog").addEventListener("close", () => { generation++; });
