// Shared by the conversation panel and the browser-only page. No app imports:
// a browser tab must not boot the conversation app or its sockets.
export function createBrowserViewer(root, { api: request, identity, sessionId, nodeId, confirm: confirmAction, onClose }) {
  let session = null, socket = null, disposed = false, retry = 0, retryTimer, connectionTimer;
  let framePending = null, drawing = false, frameVersion = 0, frameSize = null;
  let sessionVersion = 0;
  let busy = false, connected = false, loaded = false, profiles = [], sessions = [];
  let uploading = false, uploadTarget = null;
  let nodes = [], configuration = null, preference = null, profilesNodeId = null, profilesReady = false;
  function browserUrl(path, ownerId) {
    if (!ownerId) throw new Error("Browser machine is not configured. Choose a machine first.");
    const url = new URL(path, location.href);
    url.searchParams.set("nodeId", ownerId);
    return `${url.pathname}${url.search}`;
  }
  const api = request;
  const sessionApi = (path, options) => api(browserUrl(path, session.nodeId), options);
  const machineName = (id) => nodes.find((node) => node.id === id)?.name || id || "Not configured";
  const startNodeId = () => get("start-node").value || preference?.effectiveNodeId;
  const preferenceUrl = () => `/api/browser/preferences?${new URLSearchParams({ projectId: identity.projectId, engine: identity.engine, conversationId: identity.conversationId })}`;
  root.classList.add("browser-viewer");
  // Static markup only; page content and other dynamic values use textContent.
  root.replaceChildren(document.createRange().createContextualFragment(`
    <header class="browser-heading">
      <div><span class="eyebrow">Conversation browser</span><h2>Live browser</h2></div>
      <a class="ghost compact browser-link" data-testid="browser-open-tab" target="_blank" rel="noopener">Open in tab</a>
      <button type="button" class="ghost compact" data-testid="browser-close-viewer">Close viewer</button>
    </header>
    <div class="browser-body">
      <p class="browser-notice" data-testid="browser-session-status" role="status">Finding this conversation's browser…</p>
      <p class="browser-error" data-testid="browser-error" role="alert" hidden></p>
      <p class="browser-error" data-testid="browser-discovery-status" role="status" hidden></p>
      <label class="browser-account-picker">Conversation machine<select data-testid="browser-conversation-node" aria-label="Conversation machine"></select></label>
      <p class="browser-hint" data-testid="browser-machine-status"></p>
      <label class="browser-account-picker">Viewing account<select data-testid="browser-session-select" aria-label="Viewing account"></select></label>
      <p class="browser-hint">Switching accounts changes only this viewer. With multiple accounts, tell the agent which profile ID to use.</p>
      <div class="browser-start-row" data-part="start">
        <label class="browser-machine-picker">Start on machine<select data-testid="browser-start-node" aria-label="Start on machine"></select></label>
        <label>Project profile<select data-testid="browser-profile-select"><option value="">Conversation default</option></select></label>
        <label data-part="profile-name" hidden>New profile name<input data-testid="browser-profile-name" maxlength="80" placeholder="e.g. Work account" /></label>
        <button class="primary" type="button" data-testid="browser-start" disabled>Start browser</button>
      </div>
      <div class="browser-toolbar">
        <span class="browser-connection" data-testid="browser-connection-status" role="status">Not connected</span>
        <button class="ghost compact" type="button" data-testid="browser-reconnect">Reconnect viewer</button>
        <span data-testid="browser-control-status" role="status">Agent control</span>
        <button class="primary compact" type="button" data-testid="browser-take-control">Take control</button>
        <button class="ghost compact" type="button" data-testid="browser-resume-agent">Resume agent</button>
      </div>
      <p class="browser-hint" data-part="control-hint">Take control to interact. Viewing does not pause the agent.</p>
      <div class="browser-tabs" data-testid="browser-tabs" aria-label="Browser tabs"></div>
      <form class="browser-navigation" data-part="navigation">
        <button class="ghost compact" type="button" data-command="back" data-testid="browser-back" aria-label="Go back" title="Go back">←</button>
        <button class="ghost compact" type="button" data-command="forward" data-testid="browser-forward" aria-label="Go forward" title="Go forward">→</button>
        <button class="ghost compact" type="button" data-command="reload" data-testid="browser-reload" aria-label="Reload page" title="Reload page">↻</button>
        <input type="url" aria-label="Website address" placeholder="https://example.com" data-testid="browser-url" required />
        <button class="ghost compact" type="submit" data-testid="browser-go">Go</button>
        <button class="ghost compact" type="button" data-command="newTab" data-testid="browser-new-tab" aria-label="New browser tab" title="New browser tab">+</button>
      </form>
      <div class="browser-stage">
        <p class="browser-empty" data-part="frame-hint">Start a browser to see its live page.</p>
        <img class="browser-screen" data-testid="browser-screen" tabindex="0" draggable="false" alt="Live remote browser. Take control, then focus here to use keyboard and mouse. Tab leaves the viewer; use Send Tab to tab within the remote page." hidden />
      </div>
      <div class="browser-toolbar">
        <button class="ghost compact" type="button" data-testid="browser-send-tab">Send Tab</button>
        <button class="ghost compact" type="button" data-testid="browser-send-shift-tab">Send Shift+Tab</button>
        <span class="browser-hint">Keyboard goes to the browser only while its image is focused.</span>
      </div>
      <section class="browser-prompt" data-part="dialog" aria-label="Website dialog" hidden>
        <p data-part="dialog-message"></p>
        <input aria-label="Website prompt response" data-testid="browser-dialog-input" maxlength="10000" />
        <div class="browser-toolbar"><button class="primary compact" type="button" data-testid="browser-dialog-accept">Accept</button><button class="ghost compact" type="button" data-testid="browser-dialog-dismiss">Dismiss</button></div>
      </section>
      <section class="browser-prompt" data-part="upload" hidden>
        <label>Choose files for this website<input type="file" multiple data-testid="browser-upload" /></label>
        <p class="browser-hint">Up to 25 files, 20 MiB total. Files are sent to the remote browser.</p>
      </section>
      <p class="browser-hint" role="status" data-testid="browser-upload-status"></p>
      <details class="browser-details" data-testid="browser-downloads-details"><summary data-testid="browser-downloads-toggle">Downloads</summary><ul data-testid="browser-downloads-list"></ul></details>
      <details class="browser-details" open data-testid="browser-profiles-details"><summary data-testid="browser-profiles-toggle">Browser profiles for this project</summary>
        <p class="browser-hint">Cookies and browser data are saved automatically on this node. Sign in here; no separate Secrets account is required. Opening a profile here attaches all its signed-in websites to this conversation. Keep sensitive accounts in separate profiles. For WhatsApp, take control and scan the QR code with your phone to link this browser. Profiles are not synced to other nodes. Browser data is not app-encrypted; use FileVault or LUKS for disk protection.</p>
        <form class="browser-profile-form" data-part="profile-form"><input aria-label="Current profile name" placeholder="Rename current profile" maxlength="80" required data-testid="browser-profile-label" /><button class="ghost compact" type="submit" data-testid="browser-save-profile">Rename profile</button></form>
        <ul data-testid="browser-profiles-list"></ul>
      </details>
      <footer class="browser-footer"><p class="browser-hint">Closing this viewer leaves the browser running.</p><button class="ghost compact danger" type="button" data-testid="browser-end">End browser</button></footer>
    </div>`));
  const get = (name) => root.querySelector(`[data-testid="browser-${name}"]`);
  const part = (name) => root.querySelector(`[data-part="${name}"]`);
  const screen = get("screen");
  const error = (message = "") => { get("error").textContent = message; get("error").hidden = !message; };
  const running = () => session?.state === "running";
  const human = () => running() && session.owner === "human";
  const canInput = () => human() && session.canControl !== false && connected && !busy;
  const endpoint = () => `/api/browser/sessions/${encodeURIComponent(session.id)}`;
  function button(label, testid, handler, className = "ghost compact") {
    const element = document.createElement("button");
    element.type = "button"; element.className = className; element.textContent = label;
    element.dataset.testid = `browser-${testid}`;
    element.addEventListener("click", handler);
    return element;
  }
  function updateLink() {
    const params = new URLSearchParams(identity || {});
    if (session || sessionId) params.set("browserSessionId", session?.id || sessionId);
    if (session?.nodeId || nodeId) params.set("nodeId", session?.nodeId || nodeId);
    params.set("theme", document.documentElement.dataset.theme || "light");
    get("open-tab").href = `/browser.html?${params}`;
  }
  function controls() {
    get("start").disabled = !loaded || !profilesReady || busy || !identity?.conversationId || !identity?.appNodeId || !nodes.some((node) => node.id === startNodeId() && node.available && node.reachable);
    get("conversation-node").disabled = get("start-node").disabled = busy || !preference;
    get("session-select").disabled = busy || !sessions.length;
    get("profile-select").disabled = get("profile-name").disabled = busy;
    get("start").textContent = running() ? "Open profile" : "Start browser";
    for (const element of part("navigation").querySelectorAll("button,input")) element.disabled = !canInput();
    for (const name of ["send-tab", "send-shift-tab", "dialog-input", "dialog-accept", "dialog-dismiss", "save-profile", "profile-label"]) get(name).disabled = !canInput();
    get("upload").disabled = !canInput() || uploading || !session?.fileChooserRequest;
    get("take-control").disabled = !running() || !connected || busy || (human() && session.canControl === true);
    get("take-control").textContent = human() ? session.canControl === true ? "You have control" : "Take over control" : "Take control";
    get("resume-agent").disabled = !human() || session.canControl === false || !connected || busy;
    get("end").disabled = (!running() && !session?.restoreOnRestart) || busy;
    get("reconnect").disabled = busy;
    screen.setAttribute("aria-disabled", String(!canInput()));
    root.dataset.control = human() ? "human" : "agent";
  }
  function render() {
    updateLink();
    let restartStatus = "";
    if (session?.restoreOnRestart) {
      restartStatus = running() ? "Restores automatically after a service restart; sites reopen at their origins, actions are not replayed."
        : session.error ? "Restore stopped; no automatic retry. Reconnect to check status or start this profile again."
        : "Waiting for automatic restore after restart.";
    }
    get("session-status").textContent = session
      ? `${session.profileLabel || "Browser"} · ${machineName(session.nodeId)} · Browser ${session.state}${session.error ? `: ${session.error}` : ""}${restartStatus ? ` · ${restartStatus}` : ""}`
      : !loaded ? busy ? "Loading browser session…" : "Browser session has not loaded. Reconnect viewer to retry."
      : "No browser selected. Choose an account or start a project profile.";
    get("session-select").replaceChildren(...sessions.map((item) => new Option(`${item.profileLabel || item.profileId || "Browser"} · ${machineName(item.nodeId)} · ${item.state}`, item.id)));
    get("session-select").value = session?.id || "";
    get("control-status").textContent = human() ? "Human control · agent paused" : "Agent control";
    part("control-hint").textContent = human()
      ? session.canControl === false
        ? "Another viewer controls this browser. Take over control to replace it; the agent remains paused."
        : "Human control pauses browser actions from the agent. Closing the viewer does not resume the agent."
      : "Take control to interact. Viewing does not pause the agent.";
    const active = session?.tabs.find((tab) => tab.id === session.activePageId);
    if (document.activeElement !== get("url")) get("url").value = active?.url || "";
    const tabs = get("tabs");
    const signature = JSON.stringify([session?.tabs, session?.activePageId, canInput()]);
    if (tabs.dataset.signature !== signature) {
      tabs.dataset.signature = signature;
      tabs.replaceChildren(...(session?.tabs || []).map((tab) => {
        const row = document.createElement("div"); row.className = "browser-tab";
        const select = button(tab.title || tab.url || "New tab", "select-tab", () => sendInput({ action: "selectTab", pageId: tab.id }));
        select.setAttribute("aria-pressed", String(tab.id === session.activePageId)); select.title = tab.url;
        const close = button("×", "close-tab", () => sendInput({ action: "closeTab", pageId: tab.id }));
        close.setAttribute("aria-label", `Close tab ${tab.title || tab.url}`);
        select.disabled = close.disabled = !canInput(); row.append(select, close); return row;
      }));
    }
    part("dialog").hidden = !session?.dialog;
    if (session?.dialog) {
      const signature = JSON.stringify(session.dialog);
      part("dialog-message").textContent = `${session.dialog.type}: ${session.dialog.message}`;
      get("dialog-input").hidden = session.dialog.type !== "prompt";
      if (part("dialog").dataset.signature !== signature) get("dialog-input").value = session.dialog.defaultValue || "";
      part("dialog").dataset.signature = signature;
    }
    part("upload").hidden = !session?.fileChooser;
    get("downloads-list").replaceChildren(...(session?.downloads || []).map((download) => {
      const item = document.createElement("li");
      if (download.ready) {
        const link = document.createElement("a"); link.textContent = download.name;
        link.href = browserUrl(`${endpoint()}/downloads/${encodeURIComponent(download.id)}`, session.nodeId);
        link.dataset.testid = "browser-download"; link.download = download.name; item.append(link);
      } else item.textContent = `${download.name}: ${download.error || "Downloading…"}`;
      return item;
    }));
    if (!session?.downloads.length) get("downloads-list").textContent = "No downloads yet.";
    controls();
  }
  function acceptSession(next) {
    if (disposed || !next || (session && (next.id !== session.id || next.nodeId !== session.nodeId))) return;
    sessionVersion++;
    if (next.activePageId !== session?.activePageId) {
      frameVersion++; framePending = null; frameSize = null; screen.hidden = true;
      part("frame-hint").hidden = false; part("frame-hint").textContent = "Waiting for this tab's live image…";
    }
    if (next.canControl === undefined && session?.canControl !== undefined) next = { ...next, canControl: session.canControl };
    session = next;
    const index = sessions.findIndex((item) => item.id === next.id);
    if (index < 0) sessions.push(next); else sessions[index] = next;
    const { projectId, engine, conversationId, appNodeId } = session;
    identity = { projectId, engine, conversationId, appNodeId, ...identity };
    if (!running()) { stopSocket(); get("connection-status").textContent = "Not connected"; screen.hidden = true; part("frame-hint").hidden = false; part("frame-hint").textContent = `Browser ${session.state}. Start a new browser when ready.`; }
    render();
  }
  function renderMachines() {
    for (const [name, label, inherited, selected] of [
      ["conversation-node", "Use Settings default", configuration.executorNodeId, preference.nodeId || ""],
      ["start-node", "Use conversation setting", preference.effectiveNodeId, get("start-node").value],
    ]) {
      const options = nodes.map((node) => {
        const option = new Option(`${node.name}${node.available && node.reachable ? "" : ` · ${node.reason || "Unavailable"}`}`, node.id);
        option.disabled = !node.available || !node.reachable;
        return option;
      });
      if (selected && !nodes.some((node) => node.id === selected)) {
        const option = new Option(`${selected} · Unavailable`, selected); option.disabled = true; options.push(option);
      }
      get(name).replaceChildren(new Option(`${label} · ${machineName(inherited)}`, ""), ...options);
      get(name).value = selected;
    }
    get("machine-status").textContent = `New browsers use ${machineName(startNodeId())}. Existing accounts stay on their own machines.`;
  }
  get("conversation-node").addEventListener("change", () => operation(async () => {
    try {
      preference = await api(preferenceUrl(), { method: "PUT", body: JSON.stringify({ nodeId: get("conversation-node").value || null }) });
    } finally { if (!disposed) renderMachines(); }
    await loadProfiles();
  }));
  get("start-node").addEventListener("change", () => operation(async () => {
    renderMachines(); await loadProfiles();
  }));
  async function loadProfiles() {
    const projectId = identity?.projectId || session?.projectId;
    if (!projectId) return;
    const ownerId = startNodeId();
    profilesNodeId = ownerId; profilesReady = false;
    profiles = []; get("profile-select").value = ""; part("profile-name").hidden = true;
    get("profiles-list").replaceChildren();
    get("profile-select").replaceChildren(new Option("Conversation default", ""), new Option("New named profile…", "new"));
    if (!ownerId) return;
    const result = await api(browserUrl(`/api/browser/profiles?${new URLSearchParams({ projectId })}`, ownerId));
    if (disposed || profilesNodeId !== ownerId) return;
    profiles = result.profiles; profilesReady = true;
    const selected = get("profile-select").value;
    get("profile-select").replaceChildren(new Option("Conversation default", ""), new Option("New named profile…", "new"), ...profiles.map((profile) => new Option(`${profile.label} · ${profile.persistent ? "Persistent" : "Legacy import"}`, profile.id)));
    get("profile-select").value = selected === "new" || profiles.some((profile) => profile.id === selected) ? selected : "";
    get("profiles-list").replaceChildren(...profiles.map((profile) => {
      const item = document.createElement("li"), label = document.createElement("span"); label.textContent = `${profile.label} · ${profile.persistent ? "Persistent" : "Legacy import on next start"} · ${profile.id}`;
      const remove = button("Delete", "delete-profile", async () => {
        if (!await confirmAction({ title: "Delete browser profile?", message: `Permanently delete “${profile.label}” and its cookies and browser data from this project on this node? End all sessions using it first. Running or restore-pending profiles cannot be deleted.`, confirmLabel: "Delete profile", destructive: true })) return;
        await operation(async () => {
          if (startNodeId() !== ownerId) throw new Error("Start machine changed. Choose Delete again on the intended machine.");
          await api(browserUrl(`/api/browser/profiles/${encodeURIComponent(profile.id)}?${new URLSearchParams({ projectId })}`, ownerId), { method: "DELETE" }); await loadProfiles();
        });
      });
      remove.setAttribute("aria-label", `Delete browser profile ${profile.label}`); item.append(label, remove); return item;
    }));
    if (!profiles.length) get("profiles-list").textContent = "No browser profiles for this project yet.";
  }
  async function operation(work) {
    if (busy || disposed) return;
    busy = true; error(); controls();
    try { await work(); } catch (failure) { if (!disposed) error(failure.message); }
    finally { busy = false; if (!disposed) render(); }
  }
  async function command(value) {
    if (!running() && !(value.action === "close" && session?.restoreOnRestart)) return;
    const version = sessionVersion;
    const body = await sessionApi(`${endpoint()}/command`, { method: "POST", body: JSON.stringify(value) });
    if (version === sessionVersion) acceptSession(body.session);
  }
  function sendInput(command) {
    if (!canInput()) return;
    // Never queue disconnected input or grow an unbounded send buffer. The user
    // must retry, rather than have a delayed click land on a different page.
    if (socket?.readyState !== WebSocket.OPEN || socket.bufferedAmount > 64 * 1024) { error("Viewer connection is busy. Try that action again."); return; }
    const fromFrame = ["click", "key", "text", "scroll"].includes(command.action);
    if (fromFrame && (!frameSize || frameSize.pageId !== session.activePageId)) { error("Wait for the current tab's image before sending input."); return; }
    const expectedPageId = command.expectedPageId || (fromFrame ? frameSize.pageId : session.activePageId);
    socket.send(JSON.stringify({ type: "browserCommand", command: { ...command, ...(expectedPageId ? { expectedPageId } : {}) } }));
  }
  function stopSocket() {
    clearTimeout(retryTimer); clearTimeout(connectionTimer);
    const old = socket; socket = null; connected = false;
    old?.close();
  }
  function connect() {
    stopSocket();
    if (disposed || !running()) return;
    get("connection-status").textContent = "Connecting…"; controls();
    const url = new URL("/ws", location.href); url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    url.search = new URLSearchParams({ mode: "browser", browserSessionId: session.id, nodeId: session.nodeId }).toString();
    const ws = new WebSocket(url); socket = ws;
    connectionTimer = setTimeout(() => { if (socket === ws && !connected) ws.close(); }, 10000);
    ws.addEventListener("message", (event) => {
      if (disposed || socket !== ws) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === "browserState") {
          clearTimeout(connectionTimer);
          connected = true; get("connection-status").textContent = "Live"; acceptSession(message.session);
        } else if (message.type === "browserFrame" && message.pageId === session.activePageId) {
          framePending = message; drawFrame();
        } else if (message.type === "browserError") error(message.error);
      } catch { error("Invalid browser stream message. Reconnect the viewer."); }
    });
    ws.addEventListener("close", () => {
      if (disposed || socket !== ws) return;
      clearTimeout(connectionTimer);
      socket = null; connected = false; render();
      if (retry >= 5) { get("connection-status").textContent = "Offline · automatic retries stopped"; return; }
      const delay = Math.min(1000 * 2 ** retry++, 8000);
      get("connection-status").textContent = `Disconnected · reconnecting (${retry}/5)…`;
      retryTimer = setTimeout(connect, delay);
    });
    ws.addEventListener("error", () => { if (socket === ws) error("Browser connection failed. Your browser session has not been ended."); });
  }
  function drawFrame() {
    if (drawing || !framePending || disposed) return;
    const frame = framePending, version = frameVersion;
    framePending = null; drawing = true;
    const image = new Image();
    image.onload = () => {
      drawing = false;
      if (!disposed && version === frameVersion && frame.pageId === session?.activePageId) {
        screen.src = image.src; screen.hidden = false; part("frame-hint").hidden = true;
        frameSize = { pageId: frame.pageId, width: frame.width || image.naturalWidth, height: frame.height || image.naturalHeight };
      }
      drawFrame();
    };
    image.onerror = () => { drawing = false; if (!disposed) error("Could not decode browser image."); drawFrame(); };
    image.src = `data:image/jpeg;base64,${frame.data}`;
  }
  function selectSession(next) {
    stopSocket(); frameVersion++; framePending = null; frameSize = null;
    get("upload-status").textContent = ""; error();
    screen.hidden = true; part("frame-hint").hidden = false;
    part("frame-hint").textContent = "Waiting for this account's live image…";
    sessionVersion++; session = null; acceptSession(next); retry = 0; render(); connect();
  }
  async function loadBrowserSessions() {
    const query = new URLSearchParams(identity);
    query.delete("appNodeId");
    const result = await api(`/api/browser/sessions?${query}`);
    if (!disposed) {
      sessions = result.sessions;
      // Exact GET and streamed state outrank aggregate discovery snapshots.
      if (session) {
        const index = sessions.findIndex((item) => item.id === session.id && item.nodeId === session.nodeId);
        if (index < 0) sessions.push(session); else sessions[index] = session;
      }
      const unavailable = result.unavailableNodes || [];
      get("discovery-status").hidden = !unavailable.length;
      get("discovery-status").textContent = unavailable.length
        ? `Some accounts could not be checked: ${unavailable.map((node) => `${machineName(node.nodeId)}: ${node.reason}`).join("; ")}. Reconnect to retry.` : "";
    }
  }
  async function refresh() {
    loaded = false;
    await operation(async () => {
      const failures = [];
      if (session || sessionId) {
        const version = sessionVersion;
        const path = `/api/browser/sessions/${encodeURIComponent(session?.id || sessionId)}`;
        const ownerId = session?.nodeId || nodeId;
        try {
          const result = await api(ownerId ? browserUrl(path, ownerId) : path);
          if (disposed) return;
          if (version === sessionVersion) acceptSession(result.session);
          retry = 0; connect();
        } catch (failure) { failures.push(failure.message); }
      }
      if (identity?.projectId && identity?.engine && identity?.conversationId) {
        try {
          const status = await api("/api/browser/status");
          if (disposed) return;
          configuration = status.config; nodes = status.nodes;
          preference = await api(preferenceUrl());
          if (disposed) return;
          renderMachines();
        } catch (failure) { failures.push(failure.message); }
        try { await loadBrowserSessions(); } catch (failure) { failures.push(failure.message); }
        if (disposed) return;
        loaded = true;
        if (!session && !sessionId) selectSession(sessions.find((candidate) => candidate.state === "running") || sessions[0]);
        try { await loadProfiles(); } catch (failure) { failures.push(failure.message); }
      }
      if (!disposed) error(failures.join(" "));
    });
  }
  get("start").addEventListener("click", () => operation(async () => {
    if (!identity?.conversationId || !identity?.appNodeId || !loaded) return;
    const profileId = get("profile-select").value;
    const profileName = get("profile-name").value.trim();
    if (profileId === "new" && (!profileName || profileName.length > 80)) throw new Error("Profile name must be 1 to 80 characters.");
    const explicitNodeId = profileId && profileId !== "new" ? profilesNodeId : get("start-node").value;
    const result = await api(explicitNodeId ? browserUrl("/api/browser/sessions", explicitNodeId) : "/api/browser/sessions", { method: "POST", body: JSON.stringify({ ...identity, ...(profileId === "new" ? { profileName } : profileId ? { profileId } : {}) }) });
    if (disposed) return;
    selectSession(result.session); await loadProfiles();
  }));
  get("profile-select").addEventListener("change", () => { part("profile-name").hidden = get("profile-select").value !== "new"; });
  get("session-select").addEventListener("change", () => operation(async () => {
    const id = get("session-select").value;
    const selected = sessions.find((candidate) => candidate.id === id);
    const result = await api(browserUrl(`/api/browser/sessions/${encodeURIComponent(id)}`, selected.nodeId));
    if (!disposed) selectSession(result.session);
  }));
  get("reconnect").addEventListener("click", refresh);
  get("take-control").addEventListener("click", async () => {
    const id = session.id, force = human();
    if (force && !await confirmAction({ title: "Take over browser control?", message: "Replaces the current human controller, including a closed or signed-out viewer. The agent stays paused.", confirmLabel: "Take over control" })) return;
    await operation(() => {
      if (session.id !== id) throw new Error("Viewed account changed. Choose Take control again for the account you want.");
      return command({ action: "takeControl", ...(force ? { force: true } : {}) });
    });
  });
  get("resume-agent").addEventListener("click", () => operation(() => command({ action: "resumeAgent" })));
  get("end").addEventListener("click", async () => {
    const id = session.id;
    if (await confirmAction({ title: "End this browser?", message: `Takes control and closes only the selected account, ${session?.profileLabel || "this browser"}. Its cookies and browser data stay saved, but it will not restart automatically. Other accounts stay running. Closing the viewer does not end an account.`, confirmLabel: "End browser", destructive: true })) await operation(async () => {
      if (session.id !== id) throw new Error("Viewed account changed. Choose End again for the account you want to close.");
      if (running()) await command({ action: "takeControl", force: true });
      await command({ action: "close" });
    });
  });
  get("close-viewer").addEventListener("click", async () => {
    if (human() && !await confirmAction({ title: "Close viewer while agent is paused?", message: "The browser will keep running under human control. The agent stays paused until you reopen the viewer and choose Resume agent.", confirmLabel: "Close viewer" })) return;
    dispose(); onClose?.();
  });
  for (const control of root.querySelectorAll("[data-command]")) control.addEventListener("click", () => sendInput({ action: control.dataset.command }));
  part("navigation").addEventListener("submit", (event) => { event.preventDefault(); sendInput({ action: "navigate", url: get("url").value.trim() }); });
  for (const [name, key] of [["send-tab", "Tab"], ["send-shift-tab", "Shift+Tab"]]) get(name).addEventListener("click", () => sendInput({ action: "key", key }));
  for (const [name, accept] of [["dialog-accept", true], ["dialog-dismiss", false]]) get(name).addEventListener("click", () => {
    const target = session?.dialog;
    if (!target?.id || !target.pageId) { error("Dialog request changed. Wait for the current request."); return; }
    sendInput({ action: "dialog", accept, requestId: target.id, expectedPageId: target.pageId, ...(target.type === "prompt" ? { promptText: get("dialog-input").value } : {}) });
  });
  part("profile-form").addEventListener("submit", (event) => {
    event.preventDefault(); if (!canInput()) return;
    const label = get("profile-label").value.trim();
    if (label) void operation(async () => { await command({ action: "saveProfile", label }); await loadProfiles(); get("profile-label").value = ""; });
  });
  const currentUploadTarget = () => session?.fileChooserRequest ? { sessionId: session.id, ...session.fileChooserRequest } : null;
  // The native picker and FileReader both yield while another viewer can open
  // a new chooser, even on the same page. Retain the request the user saw.
  get("upload").addEventListener("click", () => { uploadTarget = currentUploadTarget(); });
  get("upload").addEventListener("cancel", () => { uploadTarget = null; });
  get("upload").addEventListener("change", () => {
    const target = uploadTarget || currentUploadTarget(); uploadTarget = null;
    const files = [...get("upload").files]; get("upload").value = "";
    if (!canInput() || uploading || !files.length) return;
    if (files.length > 25 || files.reduce((size, file) => size + file.size, 0) > 20 * 1024 * 1024) { error("Choose at most 25 files and 20 MiB total."); return; }
    const checkTarget = () => {
      const current = currentUploadTarget();
      if (disposed || !canInput() || !target || current?.sessionId !== target.sessionId || current?.id !== target.id || current?.pageId !== target.pageId) throw new Error("File chooser request changed. Selected files were discarded; choose files again.");
    };
    // Uploads must not hold the viewer's busy lock: dialogs and End preempt them.
    const accountId = session.id;
    uploading = true; error(); controls();
    void (async () => {
      checkTarget();
      get("upload-status").textContent = "Uploading…";
      const encoded = await Promise.all(files.map((file) => new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
        reader.onload = () => resolve({ name: file.name, data: String(reader.result).split(",")[1] }); reader.readAsDataURL(file);
      })));
      checkTarget();
      await command({ action: "upload", requestId: target.id, expectedPageId: target.pageId, files: encoded });
      if (!disposed && session?.id === accountId) get("upload-status").textContent = "Uploaded files.";
    })().catch(failure => {
      if (!disposed && session?.id === accountId) { error(failure.message); get("upload-status").textContent = "Selected files discarded."; }
    }).finally(() => { uploading = false; if (!disposed) controls(); });
  });
  function click(event, button) {
    if (!canInput() || !frameSize) return;
    event.preventDefault(); screen.focus();
    const rect = screen.getBoundingClientRect();
    sendInput({ action: "click", x: Math.max(0, Math.min(frameSize.width, (event.clientX - rect.left) / rect.width * frameSize.width)), y: Math.max(0, Math.min(frameSize.height, (event.clientY - rect.top) / rect.height * frameSize.height)), button, clickCount: Math.min(event.detail || 1, 3) });
  }
  screen.addEventListener("click", (event) => click(event, "left"));
  screen.addEventListener("contextmenu", (event) => click(event, "right"));
  screen.addEventListener("auxclick", (event) => { if (event.button === 1) click(event, "middle"); });
  screen.addEventListener("wheel", (event) => {
    if (!canInput() || document.activeElement !== screen) return;
    event.preventDefault();
    const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frameSize?.height || 800 : 1;
    sendInput({ action: "scroll", x: Math.max(-20000, Math.min(20000, event.deltaX * multiplier)), y: Math.max(-20000, Math.min(20000, event.deltaY * multiplier)) });
  }, { passive: false });
  screen.addEventListener("keydown", (event) => {
    if (!canInput() || document.activeElement !== screen || event.key === "Tab") return;
    event.stopPropagation();
    // Let the local browser emit paste; never also send a remote Control+V.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
    event.preventDefault();
    if (["Control", "Meta", "Alt", "Shift"].includes(event.key) || event.isComposing) return;
    const key = [...(event.ctrlKey ? ["Control"] : []), ...(event.metaKey ? ["Meta"] : []), ...(event.altKey ? ["Alt"] : []), ...(event.shiftKey ? ["Shift"] : []), event.key === " " ? "Space" : event.key].join("+");
    sendInput({ action: "key", key });
  });
  screen.addEventListener("paste", (event) => {
    if (!canInput() || document.activeElement !== screen) return;
    event.preventDefault(); event.stopPropagation();
    const text = event.clipboardData?.getData("text/plain") || "";
    if (text.length > 100000) error("Paste is limited to 100,000 characters.");
    else if (text) sendInput({ action: "text", text });
  });
  function dispose() { disposed = true; frameVersion++; framePending = null; stopSocket(); }
  updateLink(); controls();
  if (!identity?.conversationId && !sessionId) {
    error("Open an existing conversation before starting its browser."); get("session-status").textContent = "No conversation selected.";
  } else void refresh();
  return { dispose, get session() { return session; } };
}

// The main app supplies its normal API/CSRF helper. A dedicated viewer cannot
// import that helper: it imports the entire app's DOM listener graph.
const standalone = document.querySelector("[data-browser-standalone]");
if (standalone) {
  const params = new URLSearchParams(location.search);
  document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
  let csrfToken = "";
  const request = async (path, options = {}) => {
    const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken } });
    const body = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(response.status === 401 ? "Sign in to Joint Bob in another tab, then reload this viewer." : body?.error || response.statusText);
    return body;
  };
  const confirm = ({ title, message, confirmLabel }) => {
    const dialog = document.querySelector("#browserConfirm");
    dialog.querySelector("h2").textContent = title; dialog.querySelector("p").textContent = message;
    dialog.querySelector('[value="confirm"]').textContent = confirmLabel;
    dialog.returnValue = ""; dialog.showModal();
    return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), { once: true }));
  };
  request("/api/auth/status").then((auth) => {
    if (!auth.authenticated) throw new Error("Sign in to Joint Bob in another tab, then reload this viewer.");
    csrfToken = auth.csrfToken;
    const identity = Object.fromEntries(["projectId", "engine", "conversationId", "appNodeId"].filter((key) => params.has(key)).map((key) => [key, params.get(key)]));

    const viewer = createBrowserViewer(standalone, { api: request, identity, sessionId: params.get("browserSessionId"), nodeId: params.get("nodeId"), confirm, onClose: () => { standalone.replaceChildren(); const message = document.createElement("p"); message.className = "browser-notice"; message.textContent = "Viewer closed. Browser session is still running. You can close this tab or reload to reconnect."; standalone.append(message); } });
    window.addEventListener("pagehide", () => viewer.dispose(), { once: true });
  }).catch((error) => { standalone.textContent = error.message; });
}
