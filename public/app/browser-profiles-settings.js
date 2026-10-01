// Settings → Browser → Profiles: every browser profile this machine may see across the
// cluster. Logins stay on the machine that owns a profile; changes go to that machine.
import { api } from "./api.js";
import { describeShare, shareGrantPayload, shareGrantValue, shareScopeLabel } from "./browser-profile-access.js";
import { confirmAction, toast } from "./shell.js";
import { state } from "./state.js";

let loading = false;
let targets = { localNodeId: null, nodes: [], clusters: [], workspaces: [] };

const container = () => document.querySelector("#browserProfileDirectory");
const statusLine = () => document.querySelector("#browserProfileDirectoryStatus");

function names(profile) {
  const machine = (id) => targets.nodes.find((node) => node.id === id)?.name ?? (id === profile.nodeId ? profile.nodeName : id);
  return {
    machine,
    project: (id) => state.projects.find((project) => project.id === id)?.name ?? id,
    conversation: (_projectId, id) => `${id.slice(0, 8)}…`,
    workspace: (id) => targets.workspaces.find((workspace) => workspace.id === id)?.label ?? id,
    cluster: (id) => targets.clusters.find((cluster) => cluster.id === id)?.name ?? id,
  };
}

export async function loadBrowserProfileDirectory() {
  if (loading) return;
  loading = true;
  statusLine().textContent = "Loading browser profiles…";
  try {
    const [directory, shareTargets] = await Promise.all([api("/api/browser/directory"), api("/api/browser/share-targets")]);
    targets = shareTargets;
    render(directory.profiles);
    statusLine().textContent = directory.unavailableNodes.length
      ? `Not shown: ${directory.unavailableNodes.map((node) => `${node.name} (${node.reason})`).join("; ")}.`
      : "";
  } catch (error) { statusLine().textContent = `Browser profiles unavailable: ${error.message}`; }
  finally { loading = false; }
}

function text(tag, className, content) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = content;
  return element;
}

function button(label, testid, onClick, extra = "") {
  const element = document.createElement("button");
  element.type = "button"; element.className = `ghost compact${extra}`; element.textContent = label; element.dataset.testid = testid;
  element.addEventListener("click", onClick);
  return element;
}

function render(profiles) {
  const list = container();
  if (!profiles.length) { list.textContent = "No browser profiles yet. Agents create one the first time a conversation opens a browser."; return; }
  list.replaceChildren(...profiles.map((profile) => {
    const row = document.createElement("div"); row.className = "secret-account-row"; row.dataset.testid = "browser-profile-directory-row"; row.dataset.profileId = profile.id;
    const meta = document.createElement("span"); meta.className = "secret-account-meta";
    const label = names(profile);
    meta.append(text("strong", "", `${profile.label} · ${label.machine(profile.nodeId)}`));
    meta.append(text("span", "secret-account-vars", profile.sites?.length ? `Sites: ${profile.sites.map((site) => site.replace(/^https?:\/\//, "")).join(", ")}` : "No sites yet"));
    const shares = profile.grants?.length ? profile.grants.map((grant) => describeShare(grant, label)).join("; ") : "Not usable by any conversation";
    meta.append(text("span", "secret-account-vars", `${shareScopeLabel(profile.grants ?? [])} · ${shares}`));
    const holderText = profile.holder ? (profile.holder.inUse ? "In use by another conversation" : `Open in a conversation on ${label.machine(profile.holder.appNodeId)}`) : "Idle";
    const stateLine = text("span", "secret-account-vars", profile.canManage ? holderText : `${holderText} · Shared with this machine · read-only`);
    stateLine.dataset.testid = "browser-profile-directory-state";
    meta.append(stateLine);
    row.append(meta);
    if (profile.canManage) {
      row.append(button("Share…", "browser-profile-share", () => void openShareDialog(profile).catch((error) => toast(error.message))));
      row.append(button("Rename", "browser-profile-rename", () => startRename(row, profile)));
      if (profile.holder) row.append(button("Close there", "browser-profile-close", () => void closeProfile(profile)));
      else row.append(button("Delete", "browser-profile-delete", () => void deleteProfile(profile), " danger"));
    }
    return row;
  }));
}

async function change(profile, body, success) {
  await api(`/api/browser/directory/${encodeURIComponent(profile.nodeId)}/${encodeURIComponent(profile.id)}`, { method: "POST", body: JSON.stringify(body) });
  if (success) toast(success);
}

function startRename(row, profile) {
  const form = document.createElement("form"); form.className = "browser-profile-rename";
  const input = document.createElement("input"); input.value = profile.label; input.maxLength = 80; input.required = true; input.setAttribute("aria-label", "Profile name"); input.dataset.testid = "browser-profile-rename-input";
  const save = document.createElement("button"); save.type = "submit"; save.className = "ghost compact"; save.textContent = "Save";
  form.append(input, save);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      try { await change(profile, { label: input.value.trim() }, "Profile renamed"); await loadBrowserProfileDirectory(); }
      catch (error) { toast(error.message); }
    })();
  });
  row.append(form); input.focus(); input.select();
}

async function closeProfile(profile) {
  const confirmed = await confirmAction({ eyebrow: "Browser profile", title: `Close ${profile.label}?`, message: "Its browser closes in the conversation that has it open, and that conversation's agent stops using it. Its saved logins stay. Any conversation it is shared with can then open it.", confirmLabel: "Close browser", destructive: true });
  if (!confirmed) return;
  try { await change(profile, { close: true }, `${profile.label} closed`); } catch (error) { toast(error.message); }
  await loadBrowserProfileDirectory();
}

async function deleteProfile(profile) {
  const confirmed = await confirmAction({ eyebrow: "Browser profile", title: `Delete ${profile.label}?`, message: "Its saved logins are deleted from its machine. This cannot be undone.", confirmLabel: "Delete profile", destructive: true });
  if (!confirmed) return;
  try { await change(profile, { delete: true }, `${profile.label} deleted`); } catch (error) { toast(error.message); }
  await loadBrowserProfileDirectory();
}

/** Options offered here plus every share the profile already has, so unchecking any of them removes it. */
function shareOptions(profile) {
  const label = names(profile);
  const options = [
    ...targets.clusters.map((cluster) => ({ group: "Clusters", grant: { scope: "cluster", clusterId: cluster.id } })),
    ...targets.nodes.map((node) => ({ group: "Machines", grant: { scope: "node", nodeId: node.id } })),
    ...targets.workspaces.map((workspace) => ({ group: `Workspaces on ${label.machine(targets.localNodeId)}`, grant: { scope: "workspace", workspaceId: workspace.id, nodeId: targets.localNodeId } })),
    ...state.projects.map((project) => ({ group: "Projects", grant: { scope: "project", projectId: project.id } })),
  ];
  for (const grant of profile.grants ?? []) {
    if (!options.some((option) => shareGrantValue(option.grant) === shareGrantValue(grant))) options.push({ group: "Current shares", grant });
  }
  return options.map((option) => ({ ...option, label: describeShare(option.grant, label) }));
}

async function openShareDialog(profile) {
  const current = new Set((profile.grants ?? []).map(shareGrantValue));
  const options = shareOptions(profile);
  const dialog = document.createElement("dialog"); dialog.className = "secret-sharing-dialog"; dialog.dataset.testid = "browser-profile-share-dialog";
  const form = document.createElement("form"); form.method = "dialog"; form.className = "dialog-card secret-sharing-card";
  const hint = text("p", "", `Logins stay on ${names(profile).machine(profile.nodeId)}; shared conversations anywhere open it there. Only one conversation can have it open at a time.`);
  hint.id = "browser-profile-share-hint"; dialog.setAttribute("aria-describedby", hint.id);
  form.append(text("h3", "", `Share ${profile.label}`), hint);
  for (const group of [...new Set(options.map((option) => option.group))]) {
    const fieldset = document.createElement("fieldset");
    fieldset.append(text("legend", "", group));
    for (const option of options.filter((candidate) => candidate.group === group)) {
      const row = document.createElement("label"); row.className = "checkbox-row";
      const input = document.createElement("input"); input.type = "checkbox"; input.dataset.testid = "browser-profile-share-option"; input.dataset.value = shareGrantValue(option.grant);
      input.checked = current.has(input.dataset.value);
      row.append(input, document.createTextNode(option.label)); fieldset.append(row);
    }
    form.append(fieldset);
  }
  const actions = document.createElement("div"); actions.className = "dialog-actions";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Cancel"; cancel.addEventListener("click", () => dialog.close());
  const save = document.createElement("button"); save.type = "submit"; save.className = "primary"; save.textContent = "Save sharing"; save.dataset.testid = "browser-profile-share-save";
  actions.append(cancel, save); form.append(actions); dialog.append(form); document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove(), { once: true });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void (async () => {
      const chosen = new Set([...form.querySelectorAll("input[type=checkbox]:checked")].map((input) => input.dataset.value));
      const byValue = new Map(options.map((option) => [shareGrantValue(option.grant), option.grant]));
      const added = [...chosen].filter((value) => !current.has(value)).map((value) => byValue.get(value));
      const removed = [...current].filter((value) => !chosen.has(value)).map((value) => byValue.get(value));
      if (!added.length && !removed.length) { dialog.close(); return; }
      if (added.some((grant) => grant.scope === "cluster" || grant.scope === "node")) {
        const confirmed = await confirmAction({ eyebrow: "Share browser profile", title: `Share ${profile.label} widely?`, message: "Every conversation in the chosen machines or clusters could open it and use its signed-in websites.", confirmLabel: "Save sharing" });
        if (!confirmed) return;
      }
      save.disabled = true;
      try {
        for (const grant of added) await change(profile, { grant: shareGrantPayload(grant) });
        for (const grant of removed) await change(profile, { revoke: shareGrantPayload(grant) });
        dialog.close();
        toast("Browser profile sharing saved");
      } catch (error) { toast(error.message); }
      finally { save.disabled = false; await loadBrowserProfileDirectory(); }
    })();
  });
  dialog.showModal(); cancel.focus();
}
