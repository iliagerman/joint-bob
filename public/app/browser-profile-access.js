// Browser profile access management for the viewer's profiles list. Shares decide
// which conversations, on which machines, may open a profile. Loaded beside
// browser-viewer.js on the standalone page and imported by the app's
// browser.js; the viewer picks the factory up from globalThis so its own
// source stays import-free for synthetic-DOM harnesses.

const OWNER_ONLY = /owning node|machine and its twins/i;
const SCOPE_ORDER = ["cluster", "node", "workspace", "project", "conversation"];
const SCOPE_LABELS = { cluster: "Cluster", node: "Machine", workspace: "Workspace", project: "Project", conversation: "Conversation" };

/** The broadest share decides the profile's chip. */
export function shareScopeLabel(grants) {
  const scope = SCOPE_ORDER.find((candidate) => grants.some((grant) => grant.scope === candidate));
  return scope ? SCOPE_LABELS[scope] : "No access";
}
export function shareGrantPayload(grant) {
  const payload = { scope: grant.scope };
  for (const key of ["projectId", "conversationId", "workspaceId", "nodeId", "clusterId"]) if (grant[key]) payload[key] = grant[key];
  return payload;
}
export function shareGrantValue(grant) {
  const pin = grant.nodeId && (grant.scope === "project" || grant.scope === "conversation") ? `@${grant.nodeId}` : "";
  if (grant.scope === "project") return `project:${grant.projectId}${pin}`;
  if (grant.scope === "conversation") return `conversation:${grant.projectId}:${grant.conversationId}${pin}`;
  if (grant.scope === "workspace") return `workspace:${grant.nodeId}:${grant.workspaceId}`;
  if (grant.scope === "node") return `node:${grant.nodeId}`;
  return `cluster:${grant.clusterId}`;
}
/** names: { machine(id), project(id), conversation(projectId, id), workspace(id), cluster(id) } */
export function describeShare(grant, names, current = {}) {
  const pinned = grant.nodeId && (grant.scope === "project" || grant.scope === "conversation") ? ` on ${names.machine(grant.nodeId)}` : "";
  if (grant.scope === "cluster") return `Everyone in cluster ${names.cluster(grant.clusterId)}`;
  if (grant.scope === "node") return `Every conversation on ${names.machine(grant.nodeId)}`;
  if (grant.scope === "workspace") return `Workspace ${names.workspace(grant.workspaceId)} on ${names.machine(grant.nodeId)}`;
  if (grant.scope === "project") return `Project · ${names.project(grant.projectId)}${pinned}`;
  if (grant.projectId === current.projectId && grant.conversationId === current.conversationId) return `This conversation${pinned}`;
  return `Conversation · ${names.conversation(grant.projectId, grant.conversationId)}${pinned}`;
}

export function createProfileAccessControls({ api, accessRequest, confirm: confirmAccess, machineName, identity, onChanged }) {
  // Panel state survives the viewer re-rendering the list after every change.
  const openPanels = new Set();
  const statusLines = new Map();
  const projectNames = new Map();
  let projectsList = [];
  const conversationTitles = new Map();
  const conversationLoads = new Map();
  let projectsLoad = null;

  const grantsOf = (profile) => Array.isArray(profile.grants) ? profile.grants : [];
  const scopeLabel = shareScopeLabel;
  const grantValue = shareGrantValue;
  const grantPayload = shareGrantPayload;

  const ensureProjects = () => projectsLoad ??= api("/api/projects?syncStatus=false")
    .then((result) => {
      projectsList = result.projects ?? [];
      for (const project of projectsList) projectNames.set(project.id, project.name);
      return projectsList;
    })
    .catch(() => []);
  const conversationsOf = (projectId) => {
    let load = conversationLoads.get(projectId);
    if (!load) {
      load = api(`/api/projects/${encodeURIComponent(projectId)}/sessions`)
        .then((result) => {
          const titles = new Map();
          for (const conversation of result.sessions ?? []) if (!titles.has(conversation.conversationId ?? conversation.id)) titles.set(conversation.conversationId ?? conversation.id, conversation.title);
          conversationTitles.set(projectId, titles);
          return titles;
        })
        .catch(() => new Map());
      conversationLoads.set(projectId, load);
    }
    return load;
  };

  function describeGrant(grant) {
    return describeShare(grant, {
      machine: (id) => machineName(id) || id,
      project: (id) => projectNames.get(id) ?? id ?? "",
      conversation: (projectId, id) => conversationTitles.get(projectId)?.get(id) ?? id ?? "",
      workspace: (id) => id,
      cluster: (id) => id,
    }, identity() ?? {});
  }

  function renderProfileRow(profile, handlers) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.className = "browser-profile-label";
    label.textContent = `${profile.label} · ${profile.persistent ? "Persistent" : "Legacy import on next start"} · ${profile.id}${profile.nodeId ? ` · on ${machineName(profile.nodeId)}` : ""}`;
    const chip = document.createElement("span");
    chip.className = "browser-profile-chip";
    chip.dataset.testid = "browser-profile-scope";
    chip.title = "Who may open this profile";
    chip.textContent = scopeLabel(grantsOf(profile));
    label.append(chip);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost compact";
    remove.dataset.testid = "browser-delete-profile";
    remove.textContent = "Delete";
    remove.setAttribute("aria-label", `Delete browser profile ${profile.label}`);
    remove.addEventListener("click", () => { void handlers.onDelete(profile); });

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ghost compact";
    toggle.dataset.testid = "browser-profile-access-toggle";
    toggle.textContent = "Access…";

    const panel = document.createElement("div");
    panel.className = "browser-profile-access";
    panel.dataset.testid = "browser-profile-access";

    const sharingHint = document.createElement("p");
    sharingHint.className = "browser-hint";
    sharingHint.textContent = "Its logins stay on its machine; other machines reach it only through a share. Share with a workspace or a cluster from Settings → Browser → Profiles.";

    const grantsList = document.createElement("div");
    grantsList.className = "browser-profile-grants";
    grantsList.dataset.testid = "browser-profile-grants";

    const form = document.createElement("form");
    form.className = "browser-profile-access-form";
    const scope = document.createElement("select");
    scope.dataset.testid = "browser-profile-grant-scope";
    scope.setAttribute("aria-label", "Grant access to");
    const projectChoice = document.createElement("select");
    projectChoice.dataset.testid = "browser-profile-grant-project";
    projectChoice.setAttribute("aria-label", "Project");
    const conversationProject = document.createElement("select");
    conversationProject.dataset.testid = "browser-profile-grant-conversation-project";
    conversationProject.setAttribute("aria-label", "Conversation's project");
    const conversation = document.createElement("select");
    conversation.dataset.testid = "browser-profile-grant-conversation";
    conversation.setAttribute("aria-label", "Conversation");
    const add = document.createElement("button");
    add.type = "submit";
    add.className = "ghost compact";
    add.dataset.testid = "browser-profile-grant-add";
    add.textContent = "Grant access";
    form.append(scope, projectChoice, conversationProject, conversation, add);

    const status = document.createElement("p");
    status.className = "browser-hint";
    status.setAttribute("role", "status");
    status.dataset.testid = "browser-profile-access-status";
    status.textContent = statusLines.get(profile.id) ?? "";

    panel.append(sharingHint, grantsList, form, status);
    item.append(label, toggle, remove, panel);

    const setStatus = (text) => { statusLines.set(profile.id, text); status.textContent = text; };
    const describeOwner = () => machineName(profile.nodeId) || "the machine that created it";

    let pending = false;
    async function apply(update, successText) {
      if (pending) return;
      pending = true;
      const controls = [add, ...grantsList.querySelectorAll("button")];
      for (const control of controls) control.disabled = true;
      try {
        const result = await accessRequest(profile.id, update);
        setStatus(successText);
        onChanged({ ...profile, ...result.profile });
      } catch (failure) {
        // Relay-refused changes name the owning node; point the human there
        // instead of leaving a silently reverted control.
        const hint = failure instanceof Error && OWNER_ONLY.test(failure.message) ? ` Manage this profile on ${describeOwner()}.` : "";
        setStatus(`${failure instanceof Error ? failure.message : "Access change failed."}${hint}`);
        renderGrants();
      } finally {
        pending = false;
        for (const control of controls) control.disabled = false;
      }
    }

    function renderGrants() {
      const grants = grantsOf(profile);
      grantsList.replaceChildren(...grants.map((grant) => {
        const row = document.createElement("div");
        row.className = "browser-profile-grant";
        row.dataset.testid = "browser-profile-grant";
        row.dataset.scope = grantValue(grant);
        const text = document.createElement("span");
        text.textContent = describeGrant(grant);
        const revoke = document.createElement("button");
        revoke.type = "button";
        revoke.className = "ghost compact";
        revoke.dataset.testid = "browser-profile-grant-remove";
        revoke.dataset.scope = grantValue(grant);
        revoke.textContent = "Remove";
        revoke.setAttribute("aria-label", `Remove access: ${describeGrant(grant)}`);
        revoke.addEventListener("click", () => { void apply({ revoke: grantPayload(grant) }, `Access removed: ${describeGrant(grant)}.`); });
        row.append(text, revoke);
        return row;
      }));
      if (!grants.length) {
        const empty = document.createElement("p");
        empty.className = "browser-hint";
        empty.textContent = "No conversation can open this profile yet. Share it below.";
        grantsList.append(empty);
      }
    }

    function renderScopeOptions() {
      const current = identity() ?? {};
      const options = [new Option("Grant access to…", "")];
      if (profile.nodeId) options.push(new Option(`Every conversation on ${machineName(profile.nodeId) || "its machine"}`, `node:${profile.nodeId}`));
      if (current.projectId) options.push(new Option(`This project (${projectNames.get(current.projectId) ?? current.projectId})`, `project:${current.projectId}`));
      options.push(new Option("Another project…", "project"));
      if (current.projectId && current.conversationId) options.push(new Option("This conversation", `conversation:${current.projectId}:${current.conversationId}`));
      options.push(new Option("Another conversation…", "conversation"));
      scope.replaceChildren(...options);
      scope.value = "";
    }

    async function fillProjectChoices() {
      await ensureProjects();
      // Fresh option nodes per select: one node instance can live in only one
      // of them, and reusing it would empty the other select.
      const freshOptions = () => [new Option("Choose project…", ""), ...projectsList.map((project) => new Option(project.name ?? project.id, project.id))];
      projectChoice.replaceChildren(...freshOptions());
      conversationProject.replaceChildren(...freshOptions());
      const current = identity() ?? {};
      conversationProject.value = current.projectId && projectsList.some((project) => project.id === current.projectId) ? current.projectId : "";
      await fillConversations();
    }

    async function fillConversations() {
      const projectId = conversationProject.value;
      if (!projectId) conversation.replaceChildren(new Option("Choose project first…", ""));
      else {
        const titles = await conversationsOf(projectId);
        // A newer project selection may have won while titles loaded.
        if (conversationProject.value !== projectId) return;
        conversation.replaceChildren(new Option("Choose conversation…", ""), ...[...titles].map(([id, title]) => new Option(title ?? id, id)));
      }
      syncGrantForm();
    }

    function syncGrantForm() {
      const value = scope.value;
      projectChoice.hidden = value !== "project";
      conversationProject.hidden = value !== "conversation";
      conversation.hidden = value !== "conversation";
      add.disabled = !value
        || (value === "project" && !projectChoice.value)
        || (value === "conversation" && !(conversationProject.value && conversation.value));
    }

    scope.addEventListener("change", syncGrantForm);
    projectChoice.addEventListener("change", syncGrantForm);
    conversationProject.addEventListener("change", () => { void fillConversations(); });
    conversation.addEventListener("change", syncGrantForm);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = scope.value;
      const grant = value.startsWith("node:") ? { scope: "node", nodeId: value.slice("node:".length) }
        : value === "project" ? { scope: "project", projectId: projectChoice.value }
        : value.startsWith("project:") ? { scope: "project", projectId: value.slice("project:".length) }
        : value === "conversation" ? { scope: "conversation", projectId: conversationProject.value, conversationId: conversation.value }
        : value.startsWith("conversation:")
          ? (([projectId, conversationId]) => ({ scope: "conversation", projectId, conversationId }))(value.slice("conversation:".length).split(":"))
          : null;
      if (!grant || (grant.scope !== "node" && !grant.projectId) || (grant.scope === "conversation" && !grant.conversationId)) return;
      void (async () => {
        if (grant.scope === "node" && !(await confirmAccess({
          title: "Share with every conversation on this machine?",
          message: `Any conversation on ${describeOwner()} could open “${profile.label}” and use its signed-in websites. Prefer a project or a single conversation when possible.`,
          confirmLabel: "Share",
        }))) return;
        await apply({ grant }, `Access granted: ${describeGrant(grant)}.`);
        scope.value = "";
        syncGrantForm();
      })();
    });

    async function hydrate() {
      status.textContent = statusLines.get(profile.id) ?? "";
      renderScopeOptions();
      syncGrantForm();
      await Promise.all([
        fillProjectChoices().then(() => renderScopeOptions()),
        ...[...new Set(grantsOf(profile).filter((grant) => grant.scope === "conversation").map((grant) => grant.projectId))].map((projectId) => conversationsOf(projectId)),
      ]);
      renderGrants();
    }

    const syncOpen = () => {
      const open = openPanels.has(profile.id);
      toggle.setAttribute("aria-expanded", String(open));
      panel.hidden = !open;
    };
    toggle.addEventListener("click", () => {
      if (openPanels.has(profile.id)) openPanels.delete(profile.id);
      else openPanels.add(profile.id);
      syncOpen();
      if (!panel.hidden) void hydrate();
    });
    syncOpen();
    // A re-render after an access change rebuilds the row with its panel open;
    // hydrate it so grants and labels come back.
    if (!panel.hidden) void hydrate();

    return item;
  }

  return { renderProfileRow };
}

globalThis.createBrowserProfileAccessControls ??= createProfileAccessControls;
