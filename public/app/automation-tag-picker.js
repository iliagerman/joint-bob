import { api } from "./api.js";

export function createAutomationTagPicker(container, testId) {
  container.classList.add("automation-tag-picker");
  let workspaceId = "", managed = [], value = { managedTagIds: [], manualTags: [] };
  const select = document.createElement("select");
  select.multiple = true; select.dataset.testid = `${testId}-managed`; select.setAttribute("aria-label", "Managed tags");
  const chips = document.createElement("div"); chips.className = "automation-tag-chips"; chips.dataset.testid = `${testId}-selected`;
  const manual = document.createElement("input"); manual.type = "text"; manual.maxLength = 80; manual.placeholder = "Add a manual tag"; manual.dataset.testid = `${testId}-manual`;
  const manualButton = document.createElement("button"); manualButton.type = "button"; manualButton.className = "ghost"; manualButton.textContent = "Add manual tag"; manualButton.dataset.testid = `${testId}-add-manual`;
  const managedName = document.createElement("input"); managedName.type = "text"; managedName.maxLength = 80; managedName.placeholder = "New managed tag"; managedName.dataset.testid = `${testId}-new-managed`;
  const createButton = document.createElement("button"); createButton.type = "button"; createButton.className = "ghost"; createButton.textContent = "Add to managed tags"; createButton.dataset.testid = `${testId}-create-managed`;
  const error = document.createElement("p"); error.className = "automation-tag-error"; error.setAttribute("role", "status");
  const manualRow = document.createElement("div"); manualRow.className = "automation-tag-entry"; manualRow.append(manual, manualButton);
  const managedRow = document.createElement("div"); managedRow.className = "automation-tag-entry"; managedRow.append(managedName, createButton);
  container.replaceChildren(select, chips, manualRow, managedRow, error);

  function render() {
    chips.replaceChildren();
    const entries = [...value.managedTagIds.map(id => managed.find(tag => tag.id === id) ?? { id, name: "Retired tag" }).map(tag => ({ id: tag.id, name: tag.name, managed: true })),
      ...value.manualTags.map(name => ({ id: name, name, managed: false }))];
    for (const entry of entries) {
      const chip = document.createElement("span"); chip.className = "automation-tag-chip"; chip.textContent = entry.name;
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.setAttribute("aria-label", `Remove ${entry.name}`);
      remove.addEventListener("click", () => { value = entry.managed ? { ...value, managedTagIds: value.managedTagIds.filter(id => id !== entry.id) } : { ...value, manualTags: value.manualTags.filter(name => name !== entry.name) }; render(); });
      chip.append(remove); chips.append(chip);
    }
    select.hidden = !managed.some(tag => !tag.retired);
    select.replaceChildren(...managed.filter(tag => !tag.retired).map(tag => { const option = new Option(tag.name, tag.id); option.selected = value.managedTagIds.includes(tag.id); return option; }));
  }
  async function refresh() {
    error.textContent = "";
    if (!workspaceId) { managed = []; render(); return; }
    try { managed = (await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/automation-tags`)).tags; render(); }
    catch (cause) { error.textContent = cause instanceof Error ? cause.message : String(cause); }
  }
  function addManual() {
    const name = manual.value.trim().replace(/\s+/g, " "); if (!name) return;
    if (![...value.manualTags, ...managed.filter(tag => value.managedTagIds.includes(tag.id)).map(tag => tag.name)].some(item => item.toLocaleLowerCase() === name.toLocaleLowerCase())) value = { ...value, manualTags: [...value.manualTags, name] };
    manual.value = ""; render();
  }
  select.addEventListener("change", () => { value = { ...value, managedTagIds: [...select.selectedOptions].map(option => option.value) }; render(); });
  manualButton.addEventListener("click", addManual);
  manual.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); addManual(); } });
  createButton.addEventListener("click", async () => {
    if (!workspaceId || !managedName.value.trim()) return;
    error.textContent = "";
    try {
      const { tag } = await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/automation-tags`, { method: "POST", body: JSON.stringify({ name: managedName.value }) });
      managedName.value = ""; value = { ...value, managedTagIds: [...new Set([...value.managedTagIds, tag.id])] }; await refresh();
    } catch (cause) { error.textContent = cause instanceof Error ? cause.message : String(cause); }
  });
  return {
    async setWorkspace(id) { workspaceId = id; await refresh(); },
    setValue(input = { managedTagIds: [], manualTags: [] }) { value = { managedTagIds: [...(input.managedTagIds ?? [])], manualTags: [...(input.manualTags ?? [])] }; render(); },
    getValue() { return { managedTagIds: [...value.managedTagIds], manualTags: [...value.manualTags] }; },
    refresh,
  };
}
