import { del, post, put, request } from "./api.js";
import { app, closeOverlay, fail, isMobile, notify, openSheet } from "./context.js";
import { chip, fitPage, formatTime, h, icon, rowText, siteBox, switchButton } from "./dom.js";
import { saveAssistant } from "./settings.js";

// Resources: what this assistant can use in its owner's private chat and every topic it opens.

const SECTIONS = [["browser", "Browser logins", "globe"], ["files", "Files", "file"], ["memory", "Memory", "note"], ["telegram", "Telegram", "send-out"], ["skills", "Skills", "book"], ["plugins", "Plugins", "puzzle"], ["mcp", "MCP servers", "plug"], ["secrets", "Secrets", "key"]];
const COPY = {
  browser: "Sites this assistant stays signed in to. You sign in yourself, and it never sees your password or codes. One topic uses a login at a time.",
  files: "A folder this assistant keeps across all its topics, however a topic started. It can read and save files here.",
  memory: "Notes this assistant keeps between topics. It reads them before work and adds what's worth keeping. You can edit them anytime.",
  telegram: "Talk to this assistant from Telegram through a bot of its own. Nobody reaches it until you approve them.",
  skills: "Every topic this assistant opens can use the skills you turn on, and the ones you add just for it.",
  plugins: "A plugin adds a set of skills and MCP servers. While it is off, none of them load.",
  mcp: "Servers this assistant can call. Install new servers in Joint Bob Resources first.",
  secrets: "Accounts this assistant can use. Values stay in Settings → Secrets and are never shown here.",
};
const view = { section: "browser", open: false, pages: {} };
let secrets = { accounts: [], attached: [] };

const scope = () => encodeURIComponent(`${app.assistant.engine}:${app.assistant.sessionId}`);
const base = () => `/api/personal-assistants/${app.assistant.id}`;

export async function loadResources() {
  const [resources, accounts, attached] = await Promise.all([
    request(`${base()}/resources`),
    request("/api/secrets").catch(error => ({ accounts: [], error: error.message })),
    request(`/api/secrets/scopes/conversation/${scope()}`).catch(() => ({ accountIds: [] })),
  ]);
  const local = resources.executionNode.local;
  const [files, memory, own, telegram] = local
    ? await Promise.all([request(`${base()}/files`), request(`${base()}/memory`), request(`${base()}/own-skills`), request(`${base()}/telegram`)])
    : [{ files: [] }, null, { skills: [] }, null];
  app.resources = { ...resources, files: files.files, memory, ownSkills: own.skills, telegram };
  secrets = { accounts: accounts.accounts, attached: attached.accountIds, error: accounts.error };
  return resources;
}

const decisionVariable = () => app.assistant.classifierId === "laya" ? "LAYA_API_KEY" : "TYPESAFE_AI_API_KEY";
const variableNames = account => (account.variables ?? []).map(variable => variable.name);
const mcpEnabled = name => app.assistant.mcpServerNames === null || app.assistant.mcpServerNames.includes(name);

function items(section) {
  const resources = app.resources;
  return { browser: resources.logins, files: resources.files, memory: [], telegram: [], skills: [...resources.ownSkills.map(skill => ({ ...skill, own: true, enabled: true })), ...resources.skills], plugins: resources.plugins, mcp: resources.mcpServers, secrets: secrets.accounts }[section];
}

function summary(section) {
  const list = items(section);
  if (section === "browser") {
    const attention = list.filter(login => login.state === "needs-sign-in").length;
    return `${list.length} login${list.length === 1 ? "" : "s"}${attention ? ` · ${attention} need${attention === 1 ? "s" : ""} you` : ""}`;
  }
  if (section === "files") return `${list.length} file${list.length === 1 ? "" : "s"}`;
  if (section === "telegram") {
    const telegram = app.resources.telegram;
    if (!telegram) return "On its machine";
    if (!telegram.connected) return "Not connected";
    return `@${telegram.botUsername}${telegram.waiting.length ? ` · ${telegram.waiting.length} waiting` : ""}`;
  }
  if (section === "memory") return !app.resources.memory ? "On its machine" : !app.resources.memory.enabled ? "Off" : app.resources.memory.content.trim() ? "On" : "On · Empty";
  if (section === "secrets") return `${list.filter(account => secrets.attached.includes(account.id)).length} of ${list.length} attached`;
  if (section === "mcp") return `${list.filter(server => mcpEnabled(server.name)).length} of ${list.length} on`;
  return `${list.filter(item => item.enabled).length} of ${list.length} on`;
}

async function savePreferences(change) {
  const current = app.resources.preferences;
  const next = { disabledSkills: current.disabledSkills, disabledPlugins: current.disabledPlugins, ...change };
  const { preferences } = await put(`${base()}/resources`, next);
  app.resources.preferences = preferences;
  for (const skill of app.resources.skills) skill.enabled = !preferences.disabledSkills.includes(skill.name);
  for (const plugin of app.resources.plugins) plugin.enabled = !preferences.disabledPlugins.includes(plugin.name);
}

async function toggle(section, item) {
  try {
    if (section === "skills") {
      const disabled = new Set(app.resources.preferences.disabledSkills);
      if (item.enabled) disabled.add(item.name); else disabled.delete(item.name);
      await savePreferences({ disabledSkills: [...disabled] });
    } else if (section === "plugins") {
      const disabled = new Set(app.resources.preferences.disabledPlugins);
      if (item.enabled) disabled.add(item.name); else disabled.delete(item.name);
      await savePreferences({ disabledPlugins: [...disabled] });
    } else if (section === "mcp") {
      const all = app.resources.mcpServers.map(server => server.name);
      const enabled = new Set(all.filter(mcpEnabled));
      if (enabled.has(item.name)) enabled.delete(item.name); else enabled.add(item.name);
      await saveAssistant({ mcpServerNames: all.filter(name => enabled.has(name)) });
      for (const server of app.resources.mcpServers) server.enabled = mcpEnabled(server.name);
    } else if (section === "secrets") {
      const attached = new Set(secrets.attached);
      if (attached.has(item.id)) attached.delete(item.id); else attached.add(item.id);
      const { accountIds } = await put(`/api/secrets/scopes/conversation/${scope()}`, { accountIds: [...attached] });
      secrets.attached = accountIds ?? [...attached];
    }
    notify("Saved. Changes take effect on the next turn.");
    renderResources();
  } catch (error) { fail(error); renderResources(); }
}

function resRow({ glyph, title, chips = [], detail, control, off = false }) {
  return h("div", { class: `res-row${off ? " off" : ""}` }, glyph, rowText(title, detail, chips), h("span", { class: "res-ctl" }, control));
}

function loginRow(login) {
  const states = { idle: chip("Signed in", "ok"), "in-use": chip("In use", "ok"), "needs-sign-in": chip("Needs sign-in", "amber") };
  const detail = `${login.sites[0] ?? "No site visited yet"} · ${app.resources.executionNode.name ?? "this machine"}${login.state === "in-use" ? " · A topic is using it. Others wait." : ""}`;
  const control = login.state === "needs-sign-in"
    ? h("button", { type: "button", "data-testid": "assistant-login-sign-in", onclick: () => openSignIn(login) }, "Sign in")
    : h("button", { type: "button", class: "ghost", onclick: () => detach(login) }, "Detach");
  return resRow({ glyph: siteBox((login.label[0] || "?").toUpperCase()), title: login.label, chips: [states[login.state]], detail, control, off: !app.assistant.allowBrowser });
}

const fileSize = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
const toBase64 = file => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

function confirmDelete(title, detail, action) {
  openSheet({ title, body: h("p", { style: "font-size:13.5px;color:#c9cdd1" }, detail), foot: [h("button", { type: "button", onclick: closeOverlay }, "Cancel"),
    h("button", { type: "button", class: "danger", "data-testid": "assistant-resource-delete-confirm", onclick: async () => {
      try { await action(); closeOverlay(); renderResources(); } catch (error) { fail(error); }
    } }, "Delete")] });
}

function fileRow(file) {
  const remove = () => confirmDelete(`Delete ${file.path}?`, "The assistant won't be able to use this file anymore.", async () => {
    const { files } = await del(`${base()}/files?path=${encodeURIComponent(file.path)}`);
    app.resources.files = files;
  });
  return resRow({ glyph: siteBox(icon("file")), title: file.path, detail: `${fileSize(file.bytes)} · ${formatTime(file.modifiedAt)}`,
    control: h("span", { class: "res-actions" }, h("a", { href: `${base()}/files/download?path=${encodeURIComponent(file.path)}`, download: "" }, "Download"), h("button", { type: "button", class: "ghost", onclick: remove }, "Delete")) });
}

function uploadControl() {
  const input = h("input", { type: "file", multiple: true, class: "hidden", "data-testid": "assistant-file-input" });
  input.addEventListener("change", async () => {
    try {
      for (const file of input.files) app.resources.files = (await post(`${base()}/files`, { name: file.name, data: await toBase64(file) })).files;
      notify("Saved to this assistant's folder.");
      renderResources();
    } catch (error) { fail(error); }
  });
  return h("span", {}, input, h("button", { type: "button", class: "primary", "data-testid": "assistant-upload-file", disabled: !app.resources.executionNode.local, onclick: () => input.click() }, icon("plus"), "Upload"));
}

function memoryPanel() {
  const memory = app.resources.memory;
  if (!memory) return h("div", { class: "notice" }, icon("alert"), h("span", {}, "Open this assistant on its execution machine to manage its memory."));
  const box = h("input", { type: "checkbox", class: "switch", role: "switch", "aria-label": "Keep memory", "data-testid": "assistant-memory-switch" });
  box.checked = memory.enabled;
  box.addEventListener("change", async () => {
    try { app.resources.memory = await put(`${base()}/memory/enabled`, { enabled: box.checked }); notify(box.checked ? "Memory is on." : "Memory is off. Its notes stay saved."); renderResources(); }
    catch (error) { fail(error); box.checked = !box.checked; }
  });
  const text = h("textarea", { class: "memory-text", maxlength: 200000, "aria-label": "Memory notes", "data-testid": "assistant-memory-text", placeholder: "Nothing yet. Write what this assistant should always remember, or let it add notes as it works." });
  text.value = memory.content;
  const save = h("button", { type: "button", class: "primary", "data-testid": "assistant-memory-save", onclick: async () => {
    try { app.resources.memory = await put(`${base()}/memory`, { content: text.value, expectedRevision: app.resources.memory.revision }); notify("Memory saved."); }
    catch (error) { fail(error); }
  } }, "Save memory");
  return [h("div", { class: "res-bar" }, h("span", {}, memory.enabled ? "Keeps notes between topics" : "Memory is off. Its notes stay saved."), box), text, h("div", { class: "actions" }, save)];
}

/** The one-time link, shown only for the assistant it's for, until the owner it would replace changes. */
let pairing = null;
const telegramBase = () => `${base()}/telegram`;

async function telegramAct(work, message) {
  try {
    const status = await work();
    app.resources.telegram = status;
    if (status.pairingLink) pairing = { link: status.pairingLink, assistantId: app.assistant.id, ownerId: status.owner?.id ?? null };
    if (message) notify(message);
    renderResources();
  } catch (error) { fail(error); }
}

function telegramConnectForm(status) {
  const token = h("input", { name: "token", type: "password", required: true, autocomplete: "off", placeholder: "123456789:AA…", "aria-label": "Bot token", "data-testid": "assistant-telegram-token" });
  const address = h("select", { name: "base", "aria-label": "Address Telegram uses" }, status.bases.map(item => h("option", { value: item.id }, item.label)));
  const form = h("form", { "data-testid": "assistant-telegram-connect" },
    h("ol", { class: "bullets numbered" },
      h("li", {}, "In Telegram, open @BotFather, send /newbot and copy the token."),
      h("li", {}, "Paste it here. Only Joint Bob uses it; the agent can't read it."),
      h("li", {}, "Open the one-time link you get next, to link your own Telegram account.")),
    h("label", { class: "field" }, "Bot token", token),
    status.bases.length > 1 ? h("label", { class: "field" }, "Address Telegram uses", address) : null,
    status.bases.length ? null : h("div", { class: "notice" }, icon("alert"), h("span", {}, "This machine has no address Telegram can reach. Join a relay in Settings → Relays first.")),
    h("button", { type: "submit", class: "primary", disabled: !status.bases.length }, "Connect"));
  form.addEventListener("submit", event => {
    event.preventDefault();
    telegramAct(() => post(telegramBase(), { token: token.value.trim(), ...(address.value ? { baseId: address.value } : {}) }), "Connected. Now link your Telegram account.");
  });
  return form;
}

function telegramAccessRow(item, controls) {
  const glyph = siteBox(icon(item.kind === "chat" ? "people" : "send-out"));
  return resRow({ glyph, title: item.name, chips: [chip(item.kind === "chat" ? "Group" : "Person")], detail: `Telegram ID ${item.id}`, control: h("span", { class: "res-actions" }, controls.map(([label, state, cls]) =>
    h("button", { type: "button", class: cls, onclick: () => telegramAct(() => put(`${telegramBase()}/access`, { kind: item.kind, id: item.id, state })) }, label))) });
}

function telegramConnected(status) {
  const owner = status.owner
    ? h("div", { class: "res-bar", "data-testid": "assistant-telegram-owner" }, h("span", {}, `Linked to ${status.owner.name} (${status.owner.id})`),
      h("button", { type: "button", class: "ghost", onclick: () => telegramAct(() => post(`${telegramBase()}/pairing`, {})) }, "Link another account"))
    : null;
  if (pairing && (pairing.assistantId !== app.assistant.id || pairing.ownerId !== (status.owner?.id ?? null))) pairing = null;
  const linkNotice = pairing ? h("div", { class: "notice plain", "data-testid": "assistant-telegram-link" }, icon("lock"), h("span", {}, h("a", { href: pairing.link, target: "_blank", rel: "noopener" }, "Open this link in Telegram"), ` to link your account as @${status.botUsername}'s owner. It works once and expires in 10 minutes.`))
    : status.owner ? null : h("div", { class: "notice" }, icon("alert"), h("span", {}, "No account is linked yet, so the bot answers nobody."), h("button", { type: "button", onclick: () => telegramAct(() => post(`${telegramBase()}/pairing`, {})) }, "New link"));
  const list = (title, rows) => rows.length ? [h("h3", { class: "sec" }, title), h("div", { class: "res-list whole" }, rows)] : null;
  return [
    h("div", { class: "res-bar" }, h("a", { href: `https://t.me/${status.botUsername}`, target: "_blank", rel: "noopener" }, `@${status.botUsername}`),
      h("button", { type: "button", class: "danger", "data-testid": "assistant-telegram-disconnect", onclick: () => confirmDelete(`Disconnect @${status.botUsername}?`, "The bot stops reaching this assistant at once, and its approvals are removed. Its conversations stay.", async () => {
        await del(telegramBase());
        app.resources.telegram = await request(telegramBase());
      }) }, "Disconnect")),
    owner, linkNotice,
    status.readsAllGroupMessages ? null : h("div", { class: "notice", "data-testid": "assistant-telegram-privacy" }, icon("alert"), h("span", {}, "In groups, this bot only sees commands and replies to it. To let it read a whole group, send /setprivacy to @BotFather, turn privacy off, then add the bot to the group again. Or make it a group admin."),
      h("button", { type: "button", onclick: () => telegramAct(() => post(`${telegramBase()}/refresh`, {}), "Checked with Telegram.") }, "Check again")),
    list("Waiting for approval", status.waiting.map(item => telegramAccessRow(item, [["Block", "blocked", "ghost"], ["Approve", "approved", "primary"]]))),
    list("Can use it", status.allowed.map(item => telegramAccessRow(item, [["Remove", null, "ghost"]]))),
    list("Blocked", status.blocked.map(item => telegramAccessRow(item, [["Unblock", null, "ghost"]]))),
    h("div", { class: "notice plain" }, icon("info"), h("span", {}, `Everyone in an approved group can use what ${app.assistant.name} can use, including its tools, secrets, files and memory, and can ask about them. For a group with other people, connect a separate assistant that has only what you're happy to share. A group you add the bot to yourself is approved automatically.`)),
    list("Recent calls", status.calls.map(call => h("div", { class: "work" }, chip(call.status, call.status === "delivered" ? "ok" : call.status === "failed" ? "bad" : ""), h("div", {}, h("small", {}, `${call.detail} · ${formatTime(call.at)}`))))),
  ];
}

function telegramPanel() {
  const status = app.resources.telegram;
  if (!status) return h("div", { class: "notice" }, icon("alert"), h("span", {}, "Open this assistant on its execution machine to manage Telegram."));
  return status.connected ? telegramConnected(status) : telegramConnectForm(status);
}

/** Someone just linked, asked for access or was refused: show it while this section is open. */
export async function refreshTelegram() {
  if (document.querySelector("#resources-view").classList.contains("hidden") || view.section !== "telegram" || !app.resources?.telegram) return;
  app.resources.telegram = await request(telegramBase());
  renderResources();
}

async function reloadOwnSkills(message) {
  app.resources.ownSkills = (await request(`${base()}/own-skills`)).skills;
  closeOverlay();
  notify(message);
  renderResources();
}

function openAddSkill() {
  const folder = h("input", { type: "file", webkitdirectory: true, multiple: true, class: "hidden", "data-testid": "assistant-skill-folder" });
  folder.addEventListener("change", async () => {
    try {
      const files = await Promise.all([...folder.files].map(async file => ({ relativePath: file.webkitRelativePath.split("/").slice(1).join("/") || file.name, data: await toBase64(file) })));
      const { skill } = await post(`${base()}/own-skills`, { action: "upload", files });
      await reloadOwnSkills(`Added ${skill.name}. Only this assistant has it.`);
    } catch (error) { fail(error); }
  });
  const found = h("div");
  const url = h("input", { required: true, maxlength: 2048, placeholder: "https://github.com/org/skills", autocomplete: "off" });
  const form = h("form", { id: "add-skill-git" }, h("label", { class: "field" }, "Git repository", url));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const { commit, skills } = await post(`${base()}/own-skills`, { action: "discover-git", url: url.value.trim() });
      found.replaceChildren(...(skills.length ? skills.map(skill => h("div", { class: "work", style: "align-items:center" }, h("div", {}, h("strong", {}, skill.name), h("small", {}, skill.description)),
        h("button", { type: "button", onclick: async () => {
          try { await post(`${base()}/own-skills`, { action: "import-git", url: url.value.trim(), commit, key: skill.key }); await reloadOwnSkills(`Added ${skill.name}. Only this assistant has it.`); }
          catch (error) { fail(error); }
        } }, "Add"))) : [h("p", { class: "fine" }, "No skills in this repository.")]));
    } catch (error) { fail(error); }
  });
  openSheet({ title: "Add a skill", body: [
    h("p", { class: "fine", style: "margin-bottom:10px" }, "Only this assistant gets it. Files are stored as they are and never run on upload."),
    folder, h("button", { type: "button", class: "primary", style: "width:100%;margin-bottom:16px", onclick: () => folder.click() }, "Choose a folder with SKILL.md"),
    form, found, h("a", { href: "/", class: "fine" }, "Install for every conversation in Joint Bob Resources")],
    foot: [h("button", { type: "button", onclick: closeOverlay }, "Cancel"), h("button", { type: "submit", form: "add-skill-git" }, "Find skills")] });
}

function ownSkillRow(skill) {
  const remove = () => confirmDelete(`Delete ${skill.name}?`, "This assistant won't have this skill anymore.", async () => {
    await del(`${base()}/own-skills/${skill.id}`);
    app.resources.ownSkills = app.resources.ownSkills.filter(item => item.id !== skill.id);
  });
  return resRow({ glyph: siteBox(icon("book")), title: skill.name, chips: [chip("Only this assistant", "ok")], detail: skill.description, control: h("button", { type: "button", class: "ghost", onclick: remove }, "Delete") });
}

function row(section, item) {
  if (section === "browser") return loginRow(item);
  if (section === "files") return fileRow(item);
  if (item.own) return ownSkillRow(item);
  if (section === "secrets") {
    const names = variableNames(item);
    const locked = names.includes(decisionVariable());
    const attached = secrets.attached.includes(item.id);
    return resRow({ glyph: siteBox(icon("key")), title: item.label, chips: locked ? [chip("Decision model")] : [], detail: `${names.join(", ") || item.provider}${locked && attached ? " · The decision model needs it" : ""}`,
      control: switchButton({ checked: attached, label: `Attach ${item.label}`, disabled: locked && attached, onToggle: () => toggle(section, item) }), off: !attached });
  }
  const enabled = section === "mcp" ? mcpEnabled(item.name) : item.enabled;
  const glyph = siteBox(icon(section === "skills" ? "book" : section === "plugins" ? "puzzle" : "plug"));
  const detail = section === "skills" ? item.description || item.origin : `From ${item.source}`;
  return resRow({ glyph, title: item.name, chips: section === "skills" && item.origin ? [chip(item.origin)] : [], detail, control: switchButton({ checked: enabled, label: `Use ${item.name}`, onToggle: () => toggle(section, item) }), off: !enabled });
}

function topAction(section) {
  if (section === "memory" || section === "telegram") return null;
  if (section === "files") return uploadControl();
  if (section === "skills") return h("button", { type: "button", "data-testid": "assistant-add-skill", disabled: !app.resources.executionNode.local, onclick: openAddSkill }, icon("plus"), "Add skill");
  if (section === "browser") return h("button", { type: "button", class: "primary", "data-testid": "assistant-add-login", disabled: !app.resources.executionNode.local, onclick: () => openAddLogin("new") }, icon("plus"), "Add login");
  if (section === "secrets") return h("a", { href: "/", class: "fine" }, "Manage secrets in Settings → Secrets");
  return h("a", { href: "/", class: "fine" }, "Install more in Joint Bob Resources");
}

function browserBar() {
  const box = h("input", { type: "checkbox", id: "allow-browser", class: "switch", role: "switch", "aria-label": "Use a browser" });
  box.checked = app.assistant.allowBrowser;
  box.addEventListener("change", async () => {
    try { await saveAssistant({ allowBrowser: box.checked }); notify(box.checked ? "Browser use is on." : "Browser use is off. Logins stay saved."); renderResources(); }
    catch (error) { fail(error); box.checked = !box.checked; }
  });
  return h("div", { class: "res-bar" }, h("span", {}, app.assistant.allowBrowser ? "Can use a browser" : "Browser use is off. Logins stay saved."), box);
}

function detail() {
  const section = view.section;
  const label = SECTIONS.find(entry => entry[0] === section)[1];
  const list = h("div", { class: "res-list", "data-testid": `assistant-resources-${section}` });
  const pager = h("div");
  const notices = [];
  if (section === "browser" && !app.resources.executionNode.local) notices.push(h("div", { class: "notice" }, icon("alert"), h("span", {}, "Open this assistant on its execution machine to manage its browser logins.")));
  if (section === "secrets" && secrets.error) notices.push(h("div", { class: "notice" }, icon("alert"), h("span", {}, `Secret management unavailable: ${secrets.error}`)));
  const node = h("div", { class: `res-detail${section === "telegram" || section === "memory" ? " scrolls" : ""}` },
    isMobile() ? h("button", { type: "button", class: "link", style: "align-self:flex-start;margin-bottom:10px", onclick: () => { view.open = false; renderResources(); } }, "Back to resources") : null,
    h("div", { class: "res-top" }, h("div", {}, h("h2", {}, label), h("p", {}, COPY[section])), topAction(section)),
    notices, section === "browser" ? browserBar() : null, section === "memory" ? memoryPanel() : section === "telegram" ? telegramPanel() : [list, pager]);
  const empty = section === "files" ? "No files yet. Upload some, or ask the assistant to save one here." : section === "browser" ? "No logins yet. Add one and sign in yourself. Every topic can use it." : section === "secrets" ? "Create a secret account in Settings → Secrets first." : "Nothing installed yet. Add some in Joint Bob Resources.";
  return { node, paint: () => { if (section === "memory" || section === "telegram") return; view.pages[section] = fitPage({ list, pager, items: items(section), rowHeight: 58, page: view.pages[section] ?? 0, renderRow: item => row(section, item), empty: h("div", { class: "empty" }, empty), onPage: next => { view.pages[section] = next; renderResources(); } }); } };
}

function sideList() {
  const name = app.resources.executionNode.name;
  return h("div", { class: "side-list" },
    SECTIONS.map(([id, label, symbol]) => h("button", { type: "button", class: "side-item", "aria-current": String(!isMobile() && view.section === id), "data-testid": `assistant-resources-section-${id}`, onclick: () => { view.section = id; view.open = true; renderResources(); } },
      h("strong", {}, icon(symbol), label), h("small", {}, summary(id)))),
    h("div", { class: "side-foot" },
      h("p", { class: "fine" }, `${app.assistant.name} runs on ${name ?? "another machine"}. Browser logins must be on the same machine.`),
      h("p", { class: "fine" }, "Your private chat, its topics and Telegram use these. Relay groups and requests never do.")));
}

export function renderResources() {
  const target = document.querySelector("#resources-view");
  if (!app.resources) return;
  const showDetail = !isMobile() || view.open;
  const parts = showDetail ? detail() : null;
  target.replaceChildren(h("div", { class: "list-layout" }, isMobile() && showDetail ? null : sideList(), parts?.node));
  parts?.paint();
}

export async function showResources(section) {
  if (section) { view.section = section; view.open = true; }
  await loadResources();
  renderResources();
}

async function detach(login) {
  try { await del(`${base()}/logins/${login.profileId}`); notify(`Detached ${login.label}. Its login stays saved in Settings → Browser → Profiles.`); await showResources(); }
  catch (error) { fail(error); }
}

function normalizedUrl(value) {
  const text = value.trim();
  return /^https?:\/\//i.test(text) ? text : `https://${text}`;
}

export function openAddLogin(mode = "new") {
  const tabs = h("div", { class: "seg", style: "margin-bottom:14px" }, [["new", "New sign-in"], ["saved", "Saved login"]].map(([id, label]) =>
    h("button", { type: "button", "aria-pressed": String(mode === id), onclick: () => openAddLogin(id) }, label)));
  if (mode === "saved") {
    const rows = app.resources.savedLogins.map(profile => h("div", { class: "work", style: "align-items:center" }, siteBox((profile.label[0] || "?").toUpperCase()),
      h("div", {}, h("strong", {}, profile.label), h("small", {}, profile.sites[0] ?? "No site visited yet")),
      h("button", { type: "button", onclick: () => attach(profile) }, "Attach")));
    openSheet({ title: "Add a browser login", body: [tabs, h("p", { class: "fine", style: "margin-bottom:6px" }, "Logins already saved for this conversation on this machine. Attaching one doesn't copy it."), rows.length ? rows : h("div", { class: "empty" }, "No saved logins to attach.")],
      foot: [h("button", { type: "button", onclick: closeOverlay }, "Cancel")] });
    return;
  }
  const form = h("form", { id: "add-login" },
    h("label", { class: "field" }, "Name", h("input", { name: "label", required: true, maxlength: 80, placeholder: "WhatsApp", autocomplete: "off" })),
    h("label", { class: "field" }, "Website", h("input", { name: "url", required: true, maxlength: 2000, placeholder: "web.whatsapp.com", autocomplete: "off" })),
    h("div", { class: "notice plain" }, icon("lock"), h("span", {}, `The browser opens on ${app.resources.executionNode.name ?? "the assistant's machine"}, where ${app.assistant.name} runs. A login stays on the machine where you sign in.`)));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const data = new FormData(form);
    try {
      const started = await post(`${base()}/logins`, { label: String(data.get("label")).trim(), url: normalizedUrl(String(data.get("url"))) });
      openSignInSheet(started.login, started.session);
      loadResources().then(renderResources).catch(fail);
    } catch (error) { fail(error); }
  });
  openSheet({ title: "Add a browser login", body: [tabs, form], foot: [h("button", { type: "button", onclick: closeOverlay }, "Cancel"), h("button", { type: "submit", class: "primary", form: "add-login" }, "Open browser")] });
}

async function attach(profile) {
  try { await post(`${base()}/logins/attach`, { profileId: profile.profileId }); closeOverlay(); notify(`Attached ${profile.label}.`); await showResources(); }
  catch (error) { fail(error); }
}

/** Sign in again: open the attached profile for the person in the viewer. */
export async function openSignIn(login) {
  try {
    const opened = await post(`${base()}/logins/${login.profileId}/open`, {});
    openSignInSheet(opened.login, opened.session);
  } catch (error) { fail(error); }
}

function viewerUrl(session, embedded) {
  const query = new URLSearchParams({ ...(embedded ? { embedded: "1" } : {}), projectId: app.assistant.projectId, engine: app.assistant.engine, conversationId: app.assistant.sessionId, browserSessionId: session.id, nodeId: session.nodeId, theme: "dark" });
  return `/browser.html?${query}`;
}

function openSignInSheet(login, session) {
  const fallback = h("div", { class: "notice hidden" }, icon("alert"), h("span", {}, "The browser can't be shown here. Use the link below to open it in a new tab."));
  const frame = h("iframe", { class: "viewer-frame", title: `Browser signed in as ${login.label}`, src: viewerUrl(session, true) });
  frame.addEventListener("load", () => {
    let ready = false;
    try { ready = Boolean(frame.contentDocument?.querySelector("[data-browser-standalone]")); } catch { ready = false; }
    fallback.classList.toggle("hidden", ready);
  });
  openSheet({
    title: `Sign in to ${login.label}`, wide: true,
    body: [h("p", { style: "font-size:13.5px;color:#c9cdd1;margin-bottom:10px" }, "Sign in yourself in this browser. Choose Done when you see your account."), fallback, frame,
      h("ul", { class: "bullets" },
        h("li", {}, icon("dot"), "For WhatsApp, open WhatsApp on your phone, then Settings → Linked devices → Link a device, and scan the code."),
        h("li", {}, icon("dot"), `The browser runs on ${app.resources?.executionNode.name ?? "the assistant's machine"}, and the login stays there.`),
        h("li", {}, icon("dot"), "The assistant never sees what you type. Codes and captchas stay with you.")),
      h("a", { href: viewerUrl(session, false), target: "_blank", rel: "noopener" }, "Open the browser in a new tab")],
    foot: [h("button", { type: "button", class: "primary", "data-testid": "assistant-login-done", onclick: async () => { closeOverlay(); notify(`Signed in to ${login.label}. Every topic can use it now.`); await showResources().catch(fail); } }, "Done, I'm signed in")],
  });
}

window.addEventListener("resize", () => { if (!document.querySelector("#resources-view").classList.contains("hidden")) renderResources(); });
