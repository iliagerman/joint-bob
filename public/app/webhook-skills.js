// Settings → Webhooks → Skills. Skills belong to one webhook. "+ Add skill" opens one panel with
// a choice of source: a skill already on this machine, an uploaded folder, or a Git repository.
import { api } from "./api.js";
import { createFittedList, makeBadge, makeButton, makeNode, makeTwoStepButton } from "./relay-ui.js";
import { byId, encodeFile, makeSegmented } from "./webhook-ui.js";

const INVENTORY_ROWS = 5;
const MAX_FOLDER_BYTES = 4 * 1024 * 1024;

/** `url(suffix)` addresses the current webhook, `run(work)` runs one guarded action. */
export function createWebhookSkills({ url, run, say, onCount }) {
  let skills = [];
  let inventory = [];
  const panel = byId("webhookSkillPanel");

  const list = createFittedList({
    list: byId("webhookSkillList"), pager: byId("webhookSkillPager"), testPrefix: "webhook-skills",
    emptyText: "No skills yet. Add one from this machine, a folder or Git.",
    fetchPage: async (page, size) => ({ total: skills.length, items: skills.slice((page - 1) * size, page * size) }),
    renderItem: skillRow,
  });

  async function reload() {
    [skills, inventory] = (await Promise.all([api(url("/skills")), api(url("/skills?inventory=1"))])).map((body) => body.skills);
    onCount(skills.length);
    renderInventory();
    await list.reload();
  }

  const post = (body) => api(url("/skills"), { method: "POST", body: JSON.stringify(body) });
  const add = (body, after) => run(async () => { await post(body); await reload(); await after?.(); });

  function sourceLabel(skill) {
    if (skill.source !== "git") return skill.source;
    return `Git · ${skill.sourceUrl}${skill.sourceCommit ? ` @ ${skill.sourceCommit.slice(0, 7)}` : ""}`;
  }

  async function updateFromGit(skill) {
    const source = await post({ action: "discover-git", url: skill.sourceUrl, ref: skill.sourceRef ?? null });
    if (!source.skills.some((item) => item.key === skill.sourceKey)) throw new Error("This skill is no longer available at the selected Git ref");
    if (source.commit === skill.sourceCommit) { say("This skill is already current."); return; }
    await post({ action: "import-git", url: skill.sourceUrl, ref: skill.sourceRef ?? null, commit: source.commit, key: skill.sourceKey, skillId: skill.id });
    await reload();
    say("Git skill updated.", "ok");
  }

  function skillRow(skill) {
    const row = makeNode("div", "relay-row");
    const main = makeNode("div", "relay-row-main");
    const title = makeNode("div", "relay-row-title");
    title.append(makeNode("strong", "relay-row-name", skill.name), makeBadge(sourceLabel(skill)));
    main.append(title, makeNode("p", "relay-row-meta", skill.description));
    const actions = makeNode("div", "relay-row-actions");
    if (skill.source === "git" && skill.sourceUrl && skill.sourceKey) actions.append(makeTwoStepButton({ label: "Update from Git", armedLabel: "Update to latest?", testid: "webhook-git-skill-update-button", onConfirm: () => run(() => updateFromGit(skill)) }));
    actions.append(makeButton("Remove", "webhook-skill-remove-button", () => void run(async () => {
      await api(url(`/skills/${skill.id}`), { method: "DELETE" });
      await reload();
    })));
    row.append(main, actions);
    return row;
  }

  function pickRow(name, detail, action) {
    const row = makeNode("div", "relay-row relay-row-compact");
    row.append(makeNode("div", "relay-row-main", `${name} · ${detail}`), action);
    return row;
  }

  function renderInventory() {
    const query = byId("webhookSkillSearch").value.trim().toLowerCase();
    const matches = inventory.filter((skill) => `${skill.name} ${skill.harness} ${skill.description}`.toLowerCase().includes(query));
    const rows = matches.slice(0, INVENTORY_ROWS).map((skill) => pickRow(skill.name, `${skill.harness} · ${skill.description}`, makeButton("Add", "webhook-skill-import-existing-button", () => void add({ action: "import-existing", inventoryId: skill.inventoryId }))));
    if (!inventory.length) rows.push(makeNode("p", "relay-empty", "No skills on this machine. Upload a folder or use Git."));
    else if (!matches.length) rows.push(makeNode("p", "relay-empty", "No skills match."));
    if (matches.length > INVENTORY_ROWS) rows.push(makeNode("p", "relay-empty", `${matches.length - INVENTORY_ROWS} more. Search to narrow the list.`));
    byId("webhookSkillInventory").replaceChildren(...rows);
  }

  async function uploadFolder(files) {
    let total = 0;
    const encoded = [];
    for (const file of files) {
      total += file.size;
      if (total > MAX_FOLDER_BYTES) throw new Error("A skill folder must be at most 4 MiB");
      encoded.push({ relativePath: file.webkitRelativePath?.split("/").slice(1).join("/") || file.name, data: await encodeFile(file) });
    }
    await post({ action: "upload", files: encoded });
    await reload();
  }

  function showGitResults(found, gitUrl, ref) {
    const rows = found.skills.map((skill) => {
      const added = skills.some((item) => item.sourceKey === skill.key && item.sourceUrl === gitUrl);
      const action = added ? makeBadge("Added", "ok") : makeButton("Add", "webhook-git-skill-import-button", () => void add({ action: "import-git", url: gitUrl, ref, commit: found.commit, key: skill.key }, () => showGitResults(found, gitUrl, ref)));
      return pickRow(skill.name, skill.description, action);
    });
    if (!rows.length) rows.push(makeNode("p", "relay-empty", "No skills found at this ref."));
    byId("webhookSkillGitResults").replaceChildren(...rows);
  }

  async function findInGit() {
    const gitUrl = byId("webhookSkillGitUrl").value.trim();
    if (!gitUrl) throw new Error("Enter a Git repository URL");
    const ref = byId("webhookSkillGitRef").value.trim() || null;
    showGitResults(await post({ action: "discover-git", url: gitUrl, ref }), gitUrl, ref);
  }

  function showMethod(method) {
    for (const section of panel.querySelectorAll("[data-skill-method]")) section.hidden = section.dataset.skillMethod !== method;
  }

  byId("webhookSkillMethods").append(makeSegmented([
    { value: "machine", label: "From this machine", testid: "webhook-skill-method-machine" },
    { value: "upload", label: "Upload a folder", testid: "webhook-skill-method-upload" },
    { value: "git", label: "From Git", testid: "webhook-skill-method-git" },
  ], "machine", showMethod));
  byId("webhookSkillAdd").addEventListener("click", () => { panel.hidden = false; });
  byId("webhookSkillClose").addEventListener("click", () => { panel.hidden = true; });
  byId("webhookSkillSearch").addEventListener("input", renderInventory);
  byId("webhookSkillChoose").addEventListener("click", () => byId("webhookSkillFolder").click());
  byId("webhookSkillFolder").addEventListener("change", () => {
    const files = [...byId("webhookSkillFolder").files];
    byId("webhookSkillFolder").value = "";
    if (files.length) void run(() => uploadFolder(files));
  });
  byId("webhookSkillGitDiscover").addEventListener("click", () => void run(findInGit));

  return {
    async open(hook) {
      panel.hidden = true;
      byId("webhookSkillGitResults").replaceChildren();
      if (hook) await reload();
      else { skills = []; onCount(0); }
    },
  };
}
