import { api } from "./api.js";
import { elements } from "./elements.js";
import { confirmAction, toast } from "./shell.js";

/**
 * Inline ntfy server management (Settings → Notifications). ntfy has no topic
 * objects: a "topic" here is the set of access grants on a name or `home-*` pattern.
 * Every list is paginated so the section fits the panel instead of scrolling.
 */

const TOPICS_PER_PAGE = 3;
const MESSAGES_PER_PAGE = 4;
const USERS_PER_PAGE = 8;
const CONCRETE_TOPIC = /^[A-Za-z0-9_-]{1,64}$/;
const PERMISSIONS = [
  ["read-write", "Read & write"],
  ["read-only", "Read only"],
  ["write-only", "Write only"],
  ["deny-all", "Deny all"],
];
const VIEWS = [
  ["topics", "Topics"],
  ["messages", "Messages"],
  ["users", "Users"],
  ["token", "Token"],
];

/** The open manager, or null. Replaced (never mutated across services) so stale responses can be dropped. */
let manager = null;
let onServiceChanged = async () => {};

const displayUser = (username) => (username === "*" ? "everyone" : username);
/** "everyone" is the friendly name for ntfy's anonymous `*` user. */
const wireUser = (username) => {
  const trimmed = username.trim();
  return trimmed.toLowerCase() === "everyone" ? "*" : trimmed;
};

function servicePath(suffix) {
  return `/api/ntfy/services/${encodeURIComponent(manager.service.id)}${suffix}`;
}

function el(tag, { className, text, testid, attrs } = {}, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  if (testid) node.dataset.testid = testid;
  for (const [name, value] of Object.entries(attrs || {})) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

function button(text, testid, className, action, label) {
  const node = el("button", { className, text, testid, attrs: { type: "button" } });
  if (label) node.setAttribute("aria-label", label);
  node.addEventListener("click", action);
  return node;
}

function field(labelText, control) {
  return el("label", {}, el("span", { text: labelText }), control);
}

function input(testid, { type = "text", placeholder = "", autocomplete = "off", maxLength } = {}) {
  const node = el("input", { testid, attrs: { type, autocomplete, placeholder } });
  if (maxLength) node.maxLength = maxLength;
  return node;
}

function permissionSelect(testid, value) {
  const select = el("select", { testid });
  for (const [permission, label] of PERMISSIONS) select.append(new Option(label, permission, false, permission === value));
  return select;
}

function pageCount(total, size) {
  return Math.max(1, Math.ceil(total / size));
}

/** Prev / "Page X of Y" / Next. `list.page` is clamped so deletes never strand the user on an empty page. */
function paginator(prefix, list, total, size, rerender) {
  const pages = pageCount(total, size);
  list.page = Math.min(Math.max(list.page, 0), pages - 1);
  const label = el("span", { className: "settings-hint", text: `Page ${list.page + 1} of ${pages}`, testid: `${prefix}-page-label`, attrs: { "aria-live": "polite" } });
  const prev = button("Prev", `${prefix}-prev-button`, "ghost compact", () => { list.page -= 1; rerender(); });
  const next = button("Next", `${prefix}-next-button`, "ghost compact", () => { list.page += 1; rerender(); });
  prev.disabled = list.page === 0;
  next.disabled = list.page >= pages - 1;
  return el("div", { className: "ntfy-manage-pager", testid: `${prefix}-pager` }, prev, label, next);
}

function slice(items, list, size) {
  return items.slice(list.page * size, (list.page + 1) * size);
}

function status(text, testid) {
  return el("p", { className: "settings-hint", text, testid, attrs: { role: "status" } });
}

/** Runs a mutation, surfaces failures verbatim, and reports whether it succeeded. */
async function attempt(action) {
  try {
    await action();
    return true;
  } catch (error) {
    toast(error.message, 8000);
    return false;
  }
}

// ---------------------------------------------------------------- loading

async function loadInto(kind, request) {
  const current = manager;
  const slot = current[kind];
  slot.loading = true;
  slot.error = "";
  // A reload keeps the stale list on screen so half-typed form fields survive.
  if (!slot.data) render();
  try {
    const result = await request();
    if (manager !== current) return;
    slot.data = result;
  } catch (error) {
    if (manager !== current) return;
    slot.error = error.message;
    toast(error.message, 8000);
  }
  slot.loading = false;
  render();
}

const loadTopics = () => loadInto("topics", async () => (await api(servicePath("/topics"))).topics);
const loadUsers = () => loadInto("users", async () => (await api(servicePath("/users"))).users);

function loadMessages(topic) {
  manager.messages.topic = topic;
  manager.messages.page = 0;
  manager.messages.data = null;
  return loadInto("messages", async () => {
    const query = new URLSearchParams({ topic, since: "all", limit: "200" });
    const { messages } = await api(servicePath(`/messages?${query}`));
    return [...messages].reverse();
  });
}

// ---------------------------------------------------------------- views

function renderTopicRow(topic) {
  const row = el("li", { className: "ntfy-manage-topic", testid: "ntfy-manage-topic-row" });
  const isPattern = topic.topic.includes("*");
  const name = el("strong", { className: "ntfy-manage-topic-name", text: topic.topic, testid: "ntfy-manage-topic-name" });
  const actions = el("span", { className: "ntfy-service-actions" });
  const messages = button("Messages", "ntfy-manage-topic-messages-button", "ghost compact", async () => {
    manager.view = "messages";
    manager.messageTopicInput = topic.topic;
    await loadMessages(topic.topic);
  }, `Read messages on ${topic.topic}`);
  messages.disabled = isPattern;
  if (isPattern) messages.title = "Wildcard patterns cannot be read; open a concrete topic";
  const remove = button("Delete topic", "ntfy-manage-topic-delete-button", "ghost compact danger", async () => {
    const confirmed = await confirmAction({
      eyebrow: "ntfy topic",
      title: `Delete ${topic.topic}?`,
      message: "Every access grant on this topic is removed. Cached messages are not touched.",
      confirmLabel: "Delete topic",
      destructive: true,
    });
    if (!confirmed) return;
    if (await attempt(() => api(servicePath("/topics"), { method: "DELETE", body: JSON.stringify({ topic: topic.topic }) }))) {
      toast("Topic deleted");
      await loadTopics();
    }
  }, `Delete topic ${topic.topic}`);
  actions.append(messages, remove);
  const grants = el("ul", { className: "ntfy-manage-grants settings-list" });
  for (const grant of topic.grants) {
    const who = displayUser(grant.username);
    const select = permissionSelect("ntfy-manage-grant-permission-select", grant.permission);
    select.setAttribute("aria-label", `Permission for ${who} on ${topic.topic}`);
    select.addEventListener("change", async () => {
      const ok = await attempt(() => api(servicePath("/topics"), {
        method: "PUT",
        body: JSON.stringify({ topic: topic.topic, username: grant.username, permission: select.value }),
      }));
      if (ok) toast(`${who} on ${topic.topic}: ${select.value}`);
      await loadTopics(); // On failure this also restores the select to the server's truth.
    });
    const removeGrant = button("Remove", "ntfy-manage-grant-remove-button", "ghost compact danger", async () => {
      if (await attempt(() => api(servicePath("/topics"), { method: "DELETE", body: JSON.stringify({ topic: topic.topic, username: grant.username }) }))) {
        await loadTopics();
      }
    }, `Remove ${who} from ${topic.topic}`);
    grants.append(el("li", { testid: "ntfy-manage-grant-row" }, el("span", { className: "ntfy-manage-grant-user", text: who, testid: "ntfy-manage-grant-user" }), select, removeGrant));
  }
  if (!topic.grants.length) grants.append(el("li", {}, el("span", { className: "settings-hint", text: "No grants." })));
  row.append(el("div", { className: "ntfy-manage-topic-head" }, name, actions), grants);
  return row;
}

function renderAddGrantForm() {
  const topic = input("ntfy-manage-add-topic-input", { placeholder: "home-* or alerts", maxLength: 64 });
  const user = input("ntfy-manage-add-user-input", { placeholder: "everyone maps to *", maxLength: 64 });
  const permission = permissionSelect("ntfy-manage-add-permission-select", "read-write");
  const add = button("Add access", "ntfy-manage-add-grant-button", "ghost compact", async () => {
    const topicName = topic.value.trim();
    const username = wireUser(user.value);
    if (!topicName || !username) { toast("Access needs a topic and a user"); return; }
    if (await attempt(() => api(servicePath("/topics"), { method: "PUT", body: JSON.stringify({ topic: topicName, username, permission: permission.value }) }))) {
      topic.value = "";
      user.value = "";
      toast("Access saved");
      await loadTopics();
    }
  });
  return el("div", { className: "ntfy-manage-form", testid: "ntfy-manage-add-grant-form" }, field("Topic", topic), field("User", user), field("Permission", permission), add);
}

function renderTopicsView(body) {
  const slot = manager.topics;
  body.append(status("A topic is the set of access grants on a name or wildcard pattern such as home-*.", "ntfy-manage-topics-hint"));
  if (slot.error) body.append(status(slot.error, "ntfy-manage-topics-error"));
  else if (!slot.data) body.append(status("Loading topics…", "ntfy-manage-topics-loading"));
  else if (!slot.data.length) body.append(status("No topics have access grants yet.", "ntfy-manage-topics-empty"));
  else {
    const list = el("ul", { className: "ntfy-manage-topic-list settings-list", testid: "ntfy-manage-topic-list" });
    list.append(...slice(slot.data, slot, TOPICS_PER_PAGE).map(renderTopicRow));
    body.append(list, paginator("ntfy-manage-topics", slot, slot.data.length, TOPICS_PER_PAGE, render));
  }
  body.append(renderAddGrantForm());
}

function describeMessage(message) {
  const meta = [new Date(message.time * 1000).toLocaleString()];
  if (message.priority) meta.push(`priority ${message.priority}`);
  if (message.tags?.length) meta.push(message.tags.join(", "));
  const item = el("li", { className: "ntfy-manage-message", testid: "ntfy-manage-message-row" });
  if (message.title) item.append(el("strong", { text: message.title, testid: "ntfy-manage-message-title" }));
  item.append(
    el("span", { className: "ntfy-manage-message-body", text: message.message, testid: "ntfy-manage-message-body" }),
    el("span", { className: "settings-hint", text: meta.join(" · "), testid: "ntfy-manage-message-meta" }),
  );
  return item;
}

function renderMessagesView(body) {
  const slot = manager.messages;
  const topic = input("ntfy-manage-read-topic-input", { placeholder: "alerts", maxLength: 64 });
  topic.value = manager.messageTopicInput;
  topic.addEventListener("input", () => { manager.messageTopicInput = topic.value; });
  const read = async () => {
    const name = topic.value.trim();
    if (!CONCRETE_TOPIC.test(name)) { toast("Enter a concrete topic: letters, digits, _ or -, up to 64 characters", 8000); return; }
    await loadMessages(name);
  };
  topic.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); void read(); } });
  const readButton = button("Read topic", "ntfy-manage-read-topic-button", "ghost compact", read);
  const refresh = button("Refresh", "ntfy-manage-messages-refresh-button", "ghost compact", () => loadMessages(slot.topic));
  refresh.disabled = !slot.topic;
  body.append(el("div", { className: "ntfy-manage-form", testid: "ntfy-manage-read-form" }, field("Read topic", topic), readButton, refresh));
  if (!slot.topic) { body.append(status("Choose a topic above, or press Messages on a topic.", "ntfy-manage-messages-idle")); return; }
  body.append(el("h4", { className: "ntfy-manage-subheading", text: `Messages on ${slot.topic}`, testid: "ntfy-manage-messages-heading" }));
  if (slot.error) body.append(status(slot.error, "ntfy-manage-messages-error"));
  else if (!slot.data) body.append(status("Loading messages…", "ntfy-manage-messages-loading"));
  else if (!slot.data.length) body.append(status("No cached messages. The server only keeps messages for about 12 hours, so an empty list is normal.", "ntfy-manage-messages-empty"));
  else {
    const list = el("ul", { className: "ntfy-manage-message-list settings-list", testid: "ntfy-manage-message-list" });
    list.append(...slice(slot.data, slot, MESSAGES_PER_PAGE).map(describeMessage));
    body.append(list, paginator("ntfy-manage-messages", slot, slot.data.length, MESSAGES_PER_PAGE, render));
  }
}

function renderUserRow(user) {
  const protectedUser = user.username === "*" || user.role === "admin";
  const who = displayUser(user.username);
  const grants = user.grants.length;
  const meta = [user.role, user.tier ? `tier ${user.tier}` : null, `${grants} grant${grants === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
  const row = el("li", { className: "ntfy-manage-user", testid: "ntfy-manage-user-row" },
    el("span", {}, el("strong", { text: who, testid: "ntfy-manage-user-name" }), document.createTextNode(" "), el("span", { className: "settings-hint", text: meta, testid: "ntfy-manage-user-meta" })));
  if (!protectedUser) {
    row.append(button("Delete", "ntfy-manage-user-delete-button", "ghost compact danger", async () => {
      const confirmed = await confirmAction({
        eyebrow: "ntfy user",
        title: `Delete ${who}?`,
        message: "The user and their access grants are removed from the ntfy server.",
        confirmLabel: "Delete user",
        destructive: true,
      });
      if (!confirmed) return;
      if (await attempt(() => api(servicePath(`/users/${encodeURIComponent(user.username)}`), { method: "DELETE" }))) {
        toast("User deleted");
        await loadUsers();
      }
    }, `Delete user ${who}`));
  }
  return row;
}

function renderUsersView(body) {
  const slot = manager.users;
  if (slot.error) body.append(status(slot.error, "ntfy-manage-users-error"));
  else if (!slot.data) body.append(status("Loading users…", "ntfy-manage-users-loading"));
  else if (!slot.data.length) body.append(status("No users on this server.", "ntfy-manage-users-empty"));
  else {
    const list = el("ul", { className: "ntfy-manage-user-list settings-list", testid: "ntfy-manage-user-list" });
    list.append(...slice(slot.data, slot, USERS_PER_PAGE).map(renderUserRow));
    body.append(list, paginator("ntfy-manage-users", slot, slot.data.length, USERS_PER_PAGE, render));
  }
  const username = input("ntfy-manage-user-name-input", { placeholder: "alice", maxLength: 64 });
  const password = input("ntfy-manage-user-password-input", { type: "password", autocomplete: "new-password" });
  const tier = input("ntfy-manage-user-tier-input", { placeholder: "optional", maxLength: 64 });
  const create = button("Create user", "ntfy-manage-user-create-button", "ghost compact", async () => {
    const name = username.value.trim();
    if (!name || !password.value) { toast("A user needs a username and a password"); return; }
    const payload = { username: name, password: password.value, ...(tier.value.trim() ? { tier: tier.value.trim() } : {}) };
    if (await attempt(() => api(servicePath("/users"), { method: "POST", body: JSON.stringify(payload) }))) {
      toast(`User ${name} created`);
      await loadUsers();
    }
  });
  body.append(el("div", { className: "ntfy-manage-form", testid: "ntfy-manage-user-form" }, field("Username", username), field("Password", password), field("Tier", tier), create));
}

function renderTokenView(body) {
  const token = input("ntfy-manage-token-input", { type: "password", autocomplete: "off" });
  const save = button("Save token", "ntfy-manage-token-save-button", "ghost compact", async () => {
    const value = token.value.trim();
    if (!value) { toast("Paste the admin token first"); return; }
    if (await attempt(() => api(servicePath(""), { method: "PUT", body: JSON.stringify({ token: value }) }))) {
      token.value = "";
      toast("Token replaced");
      await onServiceChanged();
    }
  });
  body.append(
    status("Topic and user management needs an ADMIN token. Replacing it updates this node only; share the service again to push it to others.", "ntfy-manage-token-hint"),
    el("div", { className: "ntfy-manage-form", testid: "ntfy-manage-token-form" }, field(manager.service.hasToken ? "Replace token" : "Set token", token), save),
  );
}

const VIEW_RENDERERS = { topics: renderTopicsView, messages: renderMessagesView, users: renderUsersView, token: renderTokenView };

async function selectView(view) {
  manager.view = view;
  render();
  if (view === "users" && !manager.users.data && !manager.users.loading) await loadUsers();
}

function render() {
  const root = elements.ntfyManagePanel;
  if (!manager) { root.hidden = true; root.replaceChildren(); return; }
  root.hidden = false;
  const heading = el("h3", { className: "ntfy-manage-heading", text: `Manage ${manager.service.name}`, testid: "ntfy-manage-heading", attrs: { id: "ntfyManageHeading" } });
  const close = button("Close", "ntfy-manage-close-button", "ghost compact", closeNtfyManager);
  const tabs = el("div", { className: "ntfy-manage-tabs", testid: "ntfy-manage-tabs", attrs: { role: "group", "aria-label": "ntfy management sections" } });
  for (const [view, label] of VIEWS) {
    const tab = button(label, `ntfy-manage-tab-${view}`, "ghost compact", () => selectView(view));
    tab.setAttribute("aria-pressed", String(manager.view === view));
    tabs.append(tab);
  }
  const body = el("div", { className: "ntfy-manage-body", testid: `ntfy-manage-view-${manager.view}` });
  VIEW_RENDERERS[manager.view](body);
  root.setAttribute("aria-labelledby", "ntfyManageHeading");
  root.replaceChildren(el("div", { className: "ntfy-manage-head" }, heading, close), tabs, body);
}

function freshList() {
  return { data: null, loading: false, error: "", page: 0 };
}

/** Opens (or switches) the inline manager for a service and loads its topics. */
export async function openNtfyManager(service, changed) {
  onServiceChanged = changed;
  manager = {
    service,
    view: "topics",
    messageTopicInput: "",
    topics: freshList(),
    messages: { ...freshList(), topic: "" },
    users: freshList(),
  };
  render();
  elements.ntfyManagePanel.scrollIntoView?.({ block: "nearest" });
  await loadTopics();
}

export function closeNtfyManager() {
  manager = null;
  render();
}

/** Called after the service list reloads: close if the service is gone, otherwise pick up fresh fields. */
export function syncNtfyManager(services) {
  if (!manager) return;
  const fresh = services.find((service) => service.id === manager.service.id);
  if (!fresh) { closeNtfyManager(); return; }
  manager.service = fresh;
  render();
}
