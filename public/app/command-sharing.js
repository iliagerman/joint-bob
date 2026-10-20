import { api } from "./api.js";
import { toast } from "./shell.js";

function button(text, testid, action) {
  const node = document.createElement("button");
  node.type = "button"; node.className = "ghost compact";
  node.textContent = text; node.dataset.testid = testid;
  node.addEventListener("click", action);
  return node;
}

export function mountReceivedCommands(parent) {
  let section = document.querySelector("#receivedCommands");
  if (!section) {
    section = document.createElement("section"); section.id = "receivedCommands";
    const title = document.createElement("h3"); title.textContent = "Received commands";
    const list = document.createElement("div"); list.dataset.testid = "received-commands-list";
    const refresh = button("Refresh", "received-commands-refresh", () => { void load(); });
    section.append(title, refresh, list); parent.after(section);
    async function load() {
      refresh.disabled = true;
      try {
        const body = await api("/api/commands/sharing");
        list.replaceChildren();
        for (const command of body.commands.filter((item) => item.kind === "received")) {
          const row = document.createElement("article"); row.className = "command-received-row";
          const name = document.createElement("strong"); name.textContent = command.name;
          const source = document.createElement("small"); source.textContent = `From ${command.receivedFromName || command.receivedFrom || "another node"} · Read only`;
          const prompt = document.createElement("p"); prompt.textContent = command.prompt;
          row.append(name, source, prompt); list.append(row);
        }
        if (!list.children.length) list.textContent = "No received commands.";
      } catch (error) { list.textContent = error.message; }
      finally { refresh.disabled = false; }
    }
  }
  section.querySelector("button").click();
}

export async function openCommandSharing(id) {
  try {
    const body = await api("/api/commands/sharing");
    const command = body.commands.find((item) => (item.presetId === id || item.id === id) && item.kind === "local");
    if (!command) { toast("Save settings before sharing this command, then reopen Settings."); return; }
    const dialog = document.createElement("dialog"); dialog.className = "secret-sharing-dialog"; dialog.dataset.testid = "command-share-dialog";
    const form = document.createElement("form"); form.className = "dialog-card secret-sharing-card command-share-card";
    const heading = document.createElement("h3"); heading.textContent = `Share ${command.name}`;
    const hint = document.createElement("p");
    hint.textContent = "The machine owner's commands are automatically shared with its twins. Choose any additional sharing here. Cluster and machine grants cover every project there. Narrower grants apply only to their projects or conversations. Other accounts' commands stay private without grants. Received copies are read-only and stay available while this machine is offline. Changes and revocations sync when the machines can connect.";
    form.append(heading, hint);
    const checks = [];
    function check(group, field, value, label, checked) {
      const row = document.createElement("label"); row.className = "checkbox-row";
      const input = document.createElement("input"); input.type = "checkbox"; input.dataset.testid = `command-share-${field}`; input.checked = checked;
      row.append(input, document.createTextNode(label)); group.append(row); checks.push({ input, field, value });
    }
    function group(title) {
      const fieldset = document.createElement("fieldset"); const legend = document.createElement("legend"); legend.textContent = title; fieldset.append(legend); form.append(fieldset); return fieldset;
    }
    for (const [field, collection, title] of [["clusterIds", "clusters", "Clusters"], ["nodeIds", "nodes", "Machines"], ["workspaceIds", "workspaces", "Workspaces"], ["projectIds", "projects", "Projects"]]) {
      const fieldset = group(title);
      for (const target of body[collection] || []) {
        const value = target.nodeId || target.id;
        check(fieldset, field, value, target.name || target.label || value, (command[field] || []).includes(value));
      }
      if (!fieldset.querySelector("input")) fieldset.append(document.createTextNode("No available targets."));
    }
    const conversations = group("Conversations");
    const seen = new Set();
    const add = (value, label, checked) => {
      const key = JSON.stringify(value);
      if (seen.has(key)) return;
      seen.add(key); check(conversations, "conversations", value, label, checked);
    };
    for (const value of command.conversations || []) add(value, `${value.projectId} / ${value.conversationId}`, true);
    const project = document.createElement("select"); project.dataset.testid = "command-share-conversation-project"; project.setAttribute("aria-label", "Load conversations for project");
    project.append(new Option("Choose project for conversations…", ""));
    for (const item of body.projects || []) project.append(new Option(item.name || item.id, item.id));
    conversations.append(project);
    project.addEventListener("change", async () => {
      const chosen = project.value;
      if (!chosen) return;
      try {
        const result = await api(`/api/projects/${encodeURIComponent(chosen)}/sessions`);
        if (!dialog.open || project.value !== chosen) return;
        for (const session of result.sessions || []) add({ projectId: chosen, conversationId: session.conversationId || session.id }, session.title || session.id, false);
      } catch (error) { toast(error.message); }
    });
    const actions = document.createElement("div"); actions.className = "dialog-actions";
    const cancel = button("Cancel", "command-share-cancel", () => dialog.close());
    const save = button("Save sharing", "command-share-save", () => { form.requestSubmit(); });
    actions.append(cancel, save); form.append(actions); dialog.append(form); document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    form.addEventListener("submit", async (event) => {
      event.preventDefault(); save.disabled = true;
      const grants = {};
      for (const field of ["clusterIds", "nodeIds", "workspaceIds", "projectIds", "conversations"]) {
        const offered = checks.filter((entry) => entry.field === field);
        // Preserve grants absent from a constrained target inventory.
        grants[field] = [...(command[field] || []).filter((value) => !offered.some((entry) => JSON.stringify(entry.value) === JSON.stringify(value))), ...offered.filter((entry) => entry.input.checked).map((entry) => entry.value)];
      }
      try {
        await api(`/api/commands/${encodeURIComponent(command.id)}/sharing`, { method: "PUT", body: JSON.stringify(grants) });
        dialog.close(); toast("Command sharing saved");
      } catch (error) { toast(error.message); }
      finally { save.disabled = false; }
    });
    dialog.showModal();
  } catch (error) { toast(error.message); }
}
