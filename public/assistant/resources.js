import { del, post, put, request } from "./api.js";
import { app, closeOverlay, fail, isMobile, notify, openSheet } from "./context.js";
import { chip, fitPage, h, icon, rowText, siteBox, switchButton } from "./dom.js";
import { saveAssistant } from "./settings.js";

// Resources: what this assistant can use in its owner's private chat and every topic it opens.

const SECTIONS = [["browser", "Browser logins", "globe"], ["skills", "Skills", "book"], ["plugins", "Plugins", "puzzle"], ["mcp", "MCP servers", "plug"], ["secrets", "Secrets", "key"]];
const COPY = {
  browser: "Sites this assistant stays signed in to. You sign in yourself, and it never sees your password or codes. One topic uses a login at a time.",
  skills: "Every topic this assistant opens can use the skills you turn on.",
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
  app.resources = resources;
  secrets = { accounts: accounts.accounts, attached: attached.accountIds, error: accounts.error };
  return resources;
}

const decisionVariable = () => app.assistant.classifierId === "laya" ? "LAYA_API_KEY" : "TYPESAFE_AI_API_KEY";
const variableNames = account => (account.variables ?? []).map(variable => variable.name);
const mcpEnabled = name => app.assistant.mcpServerNames === null || app.assistant.mcpServerNames.includes(name);

function items(section) {
  const resources = app.resources;
  return { browser: resources.logins, skills: resources.skills, plugins: resources.plugins, mcp: resources.mcpServers, secrets: secrets.accounts }[section];
}

function summary(section) {
  const list = items(section);
  if (section === "browser") {
    const attention = list.filter(login => login.state === "needs-sign-in").length;
    return `${list.length} login${list.length === 1 ? "" : "s"}${attention ? ` · ${attention} need${attention === 1 ? "s" : ""} you` : ""}`;
  }
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

function row(section, item) {
  if (section === "browser") return loginRow(item);
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
  const node = h("div", { class: "res-detail" },
    isMobile() ? h("button", { type: "button", class: "link", style: "align-self:flex-start;margin-bottom:10px", onclick: () => { view.open = false; renderResources(); } }, "Back to resources") : null,
    h("div", { class: "res-top" }, h("div", {}, h("h2", {}, label), h("p", {}, COPY[section])), topAction(section)),
    notices, section === "browser" ? browserBar() : null, list, pager);
  const empty = section === "browser" ? "No logins yet. Add one and sign in yourself. Every topic can use it." : section === "secrets" ? "Create a secret account in Settings → Secrets first." : "Nothing installed yet. Add some in Joint Bob Resources.";
  return { node, paint: () => { view.pages[section] = fitPage({ list, pager, items: items(section), rowHeight: 58, page: view.pages[section] ?? 0, renderRow: item => row(section, item), empty: h("div", { class: "empty" }, empty), onPage: next => { view.pages[section] = next; renderResources(); } }); } };
}

function sideList() {
  const name = app.resources.executionNode.name;
  return h("div", { class: "side-list" },
    SECTIONS.map(([id, label, symbol]) => h("button", { type: "button", class: "side-item", "aria-current": String(!isMobile() && view.section === id), "data-testid": `assistant-resources-section-${id}`, onclick: () => { view.section = id; view.open = true; renderResources(); } },
      h("strong", {}, icon(symbol), label), h("small", {}, summary(id)))),
    h("div", { class: "side-foot" },
      h("p", { class: "fine" }, `${app.assistant.name} runs on ${name ?? "another machine"}. Browser logins must be on the same machine.`),
      h("p", { class: "fine" }, "Only your private chat and its topics use these. Groups and requests never do.")));
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
