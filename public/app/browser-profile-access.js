// Browser profile access management for the viewer's profiles list. Scope
// grants decide which conversations may open a profile; the cross-node flag
// decides whether paired nodes may reach it through the relay. Loaded beside
// browser-viewer.js on the standalone page and imported by the app's
// browser.js; the viewer picks the factory up from globalThis so its own
// source stays import-free for synthetic-DOM harnesses.

const OWNER_ONLY = /owning node/i;

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
  const scopeLabel = (grants) => grants.some((grant) => grant.scope === "global") ? "Global"
    : grants.some((grant) => grant.scope === "project") ? "Project"
    : grants.length ? "Conversation"
    : "No access";
  const grantValue = (grant) => grant.scope === "global" ? "global:"
    : grant.scope === "project" ? `project:${grant.projectId ?? ""}`
    : `conversation:${grant.projectId ?? ""}:${grant.conversationId ?? ""}`;
  const grantPayload = (grant) => ({ scope: grant.scope, ...(grant.projectId ? { projectId: grant.projectId } : {}), ...(grant.conversationId ? { conversationId: grant.conversationId } : {}) });

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
    const current = identity() ?? {};
    if (grant.scope === "global") return "All projects (global)";
    if (grant.scope === "project") return `Project · ${projectNames.get(grant.projectId) ?? grant.projectId ?? ""}`;
    if (grant.projectId === current.projectId && grant.conversationId === current.conversationId) return "This conversation";
    return `Conversation · ${conversationTitles.get(grant.projectId)?.get(grant.conversationId) ?? grant.conversationId ?? ""}`;
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

    const crossRow = document.createElement("label");
    crossRow.className = "browser-profile-cross-node-row";
    const cross = document.createElement("input");
    cross.type = "checkbox";
    cross.dataset.testid = "browser-profile-cross-node";
    const crossText = document.createElement("span");
    crossText.textContent = "Allow other nodes to open this profile through the relay";
    crossRow.append(cross, crossText);

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

    panel.append(crossRow, grantsList, form, status);
    item.append(label, toggle, remove, panel);

    const setStatus = (text) => { statusLines.set(profile.id, text); status.textContent = text; };
    const describeOwner = () => machineName(profile.nodeId) || "the machine that created it";

    let pending = false;
    async function apply(update, successText) {
      if (pending) return;
      pending = true;
      const controls = [cross, add, ...grantsList.querySelectorAll("button")];
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
        cross.checked = profile.crossNodeAccess !== false;
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
        empty.textContent = "No conversation can open this profile yet. Grant access below.";
        grantsList.append(empty);
      }
    }

    function renderScopeOptions() {
      const current = identity() ?? {};
      const options = [new Option("Grant access to…", "")];
      options.push(new Option("All projects (global)", "global"));
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

    cross.addEventListener("change", () => {
      void apply({ crossNodeAccess: cross.checked },
        cross.checked ? "Cross-node access enabled. Paired nodes may open this profile." : "Cross-node access disabled. This profile is limited to its own node.");
    });

    scope.addEventListener("change", syncGrantForm);
    projectChoice.addEventListener("change", syncGrantForm);
    conversationProject.addEventListener("change", () => { void fillConversations(); });
    conversation.addEventListener("change", syncGrantForm);

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = scope.value;
      const grant = value === "global" ? { scope: "global" }
        : value === "project" ? { scope: "project", projectId: projectChoice.value }
        : value.startsWith("project:") ? { scope: "project", projectId: value.slice("project:".length) }
        : value === "conversation" ? { scope: "conversation", projectId: conversationProject.value, conversationId: conversation.value }
        : value.startsWith("conversation:")
          ? (([projectId, conversationId]) => ({ scope: "conversation", projectId, conversationId }))(value.slice("conversation:".length).split(":"))
          : null;
      if (!grant || (grant.scope !== "global" && !grant.projectId) || (grant.scope === "conversation" && !grant.conversationId)) return;
      void (async () => {
        if (grant.scope === "global" && !(await confirmAccess({
          title: "Grant every project access?",
          message: `Any conversation on ${describeOwner()} could open “${profile.label}” and use its signed-in websites. Other nodes still need cross-node access enabled. Prefer a project or a single conversation when possible.`,
          confirmLabel: "Grant everyone",
        }))) return;
        await apply({ grant }, `Access granted: ${describeGrant(grant)}.`);
        scope.value = "";
        syncGrantForm();
      })();
    });

    async function hydrate() {
      cross.checked = profile.crossNodeAccess !== false;
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
    // hydrate it so grants, labels and the cross-node state come back.
    if (!panel.hidden) void hydrate();

    return item;
  }

  return { renderProfileRow };
}

globalThis.createBrowserProfileAccessControls ??= createProfileAccessControls;
