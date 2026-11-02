import { del, post, put, request } from "./api.js";
import { app, closeOverlay, fail, isMobile, navigate, notify, openSheet } from "./context.js";
import { avatar, bot, chip, fitPage, h, icon, rowText, switchButton } from "./dom.js";
import { openInviteSheet } from "./groups.js";
import { setDefault, setDiscovery } from "./settings.js";

// Who can find you, Find, and a found person's or assistant's card.

export async function loadMe() {
  app.me = await request("/api/social/me");
  return app.me;
}

function head(title, subtitle) {
  return h("header", { class: "head" },
    isMobile() ? h("button", { type: "button", class: "icon ghost", "aria-label": "Back", onclick: () => history.back() }, icon("back")) : null,
    h("div", { class: "head-text" }, h("h1", {}, title), subtitle ? h("p", {}, subtitle) : null));
}

const relayMissing = () => h("div", { class: "notice plain" }, icon("info"), h("span", {}, "This machine isn't on a relay yet. Join one in Joint Bob Settings → Relays, then people there can find you and your assistants."));

function findableMatrix(me) {
  const subjects = [["person", me.account.accountId, "You", avatar(me.account.name, "you")], ...me.assistants.filter(entry => entry.local).map(entry => ["assistant", entry.id, entry.name, bot()])];
  const isOn = (kind, id, relay) => me.discovery.some(item => item.subjectKind === kind && item.subjectId === id && item.relayNodeId === relay);
  return h("table", { class: "matrix" },
    h("thead", {}, h("tr", {}, h("th", { scope: "col" }), me.relays.map(relay => h("th", { scope: "col" }, relay.name, relay.active ? "" : " (offline)")))),
    h("tbody", {}, subjects.map(([kind, id, label, glyph]) => h("tr", {}, h("td", {}, h("span", { style: "display:inline-flex;gap:9px;align-items:center" }, glyph, label)),
      me.relays.map(relay => h("td", {}, switchButton({ checked: isOn(kind, id, relay.relayNodeId), label: `${label} findable on ${relay.name}`, testid: `assistant-findable-${kind}`, onToggle: async () => { await setDiscovery(kind, id, relay.relayNodeId, !isOn(kind, id, relay.relayNodeId)); await showYou(); } })))))));
}

function defaultChoices(me) {
  const choice = (id, label, glyph) => h("button", { type: "button", class: "radio", role: "radio", "aria-checked": String((me.profile.defaultAssistantId ?? null) === id), onclick: async () => { await setDefault(id); await showYou(); } },
    h("span", { class: "dot" }), glyph, label);
  return h("div", { role: "radiogroup", "aria-label": "Default assistant" },
    me.assistants.map(entry => choice(entry.id, entry.name, bot())), choice(null, "No default. Only I join groups.", null));
}

function limitsForm(me) {
  const form = h("form", {},
    h("div", { class: "pair" },
      h("label", { class: "field" }, h("span", {}, "Requests per person each day"), h("input", { type: "number", name: "requestLimit", min: 1, max: 1000, value: me.profile.requestLimit })),
      h("label", { class: "field" }, h("span", {}, "Decision checks per assistant each day"), h("input", { type: "number", name: "decisionLimit", min: 1, max: 10000, value: me.profile.decisionLimit }))),
    h("label", { class: "field" }, h("span", {}, "About you (shown in your listing)"), h("input", { name: "description", maxlength: 300, value: me.profile.description, placeholder: "Product lead" })),
    h("button", { type: "submit" }, "Save"));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const data = new FormData(form);
    try {
      const { profile } = await put("/api/social/profile", { requestLimit: Number(data.get("requestLimit")), decisionLimit: Number(data.get("decisionLimit")), description: String(data.get("description")).trim() });
      app.me.profile = profile; notify("Saved.");
    } catch (error) { fail(error); }
  });
  return form;
}

export async function showYou() {
  const me = await loadMe();
  const target = document.querySelector("#social-view");
  const companions = me.groups.length ? h("table", { class: "matrix" }, h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Group"), h("th", { scope: "col" }, "Joined with"))),
    h("tbody", {}, me.groups.map(group => h("tr", {}, h("td", {}, group.name), h("td", { style: "text-align:left" }, group.companionName || "None"))))) : h("p", { class: "fine" }, "You aren't in any groups yet.");
  const blocks = me.blocks.length ? me.blocks.map(person => h("div", { class: "work", style: "align-items:center" }, avatar(person.name), h("div", {}, h("strong", {}, person.name)),
    h("button", { type: "button", onclick: async () => { try { await del(`/api/social/blocks/${encodeURIComponent(person.accountId)}`); await showYou(); } catch (error) { fail(error); } } }, "Unblock"))) : h("p", { class: "fine" }, "Nobody is blocked.");
  target.replaceChildren(head("Who can find you", "Off until you turn it on, separately for each relay"), h("div", { class: "scroll" }, h("div", { class: "narrow" },
    h("section", { class: "settings-sec" }, h("h2", {}, "Findable on"), h("p", { class: "muted" }, "Signed-in people on a relay can find what you turn on there. Nothing is on the public Internet."), me.relays.length ? findableMatrix(me) : relayMissing()),
    h("section", { class: "settings-sec" }, h("h2", {}, "What people see"), h("p", { class: "muted" }, "Your listings show only this."),
      h("div", { class: "card" }, h("div", { class: "listing" }, avatar(me.account.name, "you"), h("div", {}, h("strong", {}, me.account.name), h("p", { class: "fine" }, `Person · Verified home: ${me.account.nodeName}`)))),
      h("p", { class: "fine" }, "Never in a listing:"), h("div", { class: "never" }, ["Email", "Private instructions", "Credentials", "Projects", "Calendar contents", "Private chats"].map(item => chip(item)))),
    h("section", { class: "settings-sec" }, h("h2", {}, "Default assistant"), h("p", { class: "muted" }, "It joins every group you join from now on and leaves when you leave. Everyone in the group can see it."), defaultChoices(me),
      h("p", { class: "fine", style: "margin:12px 0 6px" }, "Changing this doesn't change the groups you're already in:"), companions),
    h("section", { class: "settings-sec" }, h("h2", {}, "Blocked people"), h("p", { class: "muted" }, "A block applies at once, including to requests already in progress."), blocks),
    h("section", { class: "settings-sec" }, h("h2", {}, "Limits"), h("p", { class: "muted" }, "Requests over a limit are refused before any model runs, so strangers can't run up your usage."), limitsForm(me)))));
}

// ---- Find ----

const find = { query: "", kind: "all", answer: null, page: 0, timer: null };

function resultRow(result) {
  const detail = result.kind === "person" ? [result.description, `Verified home: ${result.nodeName}`].filter(Boolean).join(" · ") : `Owned by ${result.ownerName} (${result.nodeName})${result.description ? ` · ${result.description}` : ""}`;
  const relayNames = result.relays.map(id => app.me?.relays.find(relay => relay.relayNodeId === id)?.name ?? "Relay");
  return h("button", { type: "button", class: "result", "data-testid": "assistant-search-result", onclick: () => openProfile(result) }, result.kind === "person" ? avatar(result.name) : bot("other"),
    rowText(result.name, `${detail} · ${relayNames.join(", ")}`, [chip(result.kind === "person" ? "Person" : "Assistant")]));
}

function paintResults(list, pager) {
  const results = find.answer?.results ?? [];
  find.page = fitPage({ list, pager, items: results, rowHeight: 73, page: find.page, renderRow: resultRow,
    empty: h("div", { class: "empty" }, find.answer ? `Nobody matches${find.query ? ` “${find.query}”` : ""}. People and assistants appear here only if they turned on discovery.` : "Searching…"),
    onPage: next => { find.page = next; paintResults(list, pager); } });
}

async function runSearch(list, pager, status) {
  try {
    find.answer = await request(`/api/social/search?${new URLSearchParams({ q: find.query, kind: find.kind })}`);
    const unavailable = find.answer.relays.filter(relay => relay.status === "unavailable");
    const partial = find.answer.relays.filter(relay => relay.unreachableMachines > 0);
    status.replaceChildren(
      h("small", {}, find.answer.relays.length ? `Searching ${find.answer.relays.filter(relay => relay.status === "ok").map(relay => relay.name).join(", ") || "no connected relay"}` : ""),
      unavailable.length || partial.length ? h("div", { class: "notice", style: "margin-top:8px" }, icon("alert"), h("span", {},
        unavailable.length ? `${unavailable.map(relay => relay.name).join(", ")} didn't respond. Anyone only on ${unavailable.length > 1 ? "those relays" : "that relay"} is missing from these results. ` : "",
        partial.length ? `${partial.reduce((sum, relay) => sum + relay.unreachableMachines, 0)} machine(s) didn't answer.` : ""),
      h("button", { type: "button", onclick: () => runSearch(list, pager, status) }, "Retry")) : null);
  } catch (error) { find.answer = { results: [], relays: [] }; fail(error); }
  paintResults(list, pager);
}

export async function showFind() {
  if (!app.me) await loadMe();
  const target = document.querySelector("#social-view");
  if (!app.me.relays.length) { target.replaceChildren(head("Find people and assistants", "Searches all your active relays together"), h("div", { class: "narrow" }, relayMissing())); return; }
  const list = h("div", { class: "res-list" }), pager = h("div"), status = h("div");
  const input = h("input", { type: "search", id: "find-input", placeholder: "Search by name or what they do", "aria-label": "Find people and assistants", value: find.query });
  input.addEventListener("input", () => { find.query = input.value; find.page = 0; clearTimeout(find.timer); find.timer = setTimeout(() => runSearch(list, pager, status), 300); });
  const filters = h("div", { class: "seg" }, [["all", "All"], ["person", "People"], ["assistant", "Assistants"]].map(([id, label]) => h("button", { type: "button", "aria-pressed": String(find.kind === id), onclick: () => { find.kind = id; find.page = 0; showFind(); } }, label)));
  target.replaceChildren(head("Find people and assistants", "Searches all your active relays together"),
    h("div", { class: "res-detail", style: "max-width:800px;width:100%;margin:0 auto" }, h("div", { class: "search" }, icon("search"), input), h("div", { class: "find-bar" }, status, filters), list, pager));
  input.focus();
  paintResults(list, pager);
  await runSearch(list, pager, status);
}

// ---- A found person or assistant ----

async function blockListing(result) {
  const accountId = result.kind === "person" ? result.id : result.ownerAccountId;
  const name = result.kind === "person" ? result.name : result.ownerName;
  try { await post("/api/social/blocks", { accountId, name, nodeId: result.nodeId }); closeOverlay(); notify(`Blocked ${name}. Their open requests stopped.`); }
  catch (error) { fail(error); }
}

async function startRequest(result) {
  try {
    const opened = await post("/api/social/threads", { assistantId: result.id, nodeId: result.nodeId, relayNodeId: result.relays[0] ?? "" });
    await navigate({ thread: opened.threadId });
  } catch (error) { fail(error); }
}

export function openProfile(result) {
  const routes = h("div", { class: "chips gap" }, h("small", {}, "Reachable through"), result.relays.map(id => chip(app.me?.relays.find(relay => relay.relayNodeId === id)?.name ?? "Relay")));
  const invite = () => openInviteSheet(null, result);
  if (result.kind === "person") {
    openSheet({ title: result.name, body: [h("div", { class: "listing" }, avatar(result.name), h("div", {}, result.description ? h("p", {}, result.description) : null, h("p", { class: "fine" }, `Person · Verified home: ${result.nodeName}`))), routes,
      h("p", { class: "fine", style: "margin-top:14px" }, `You can talk with people in groups. Invite ${result.name} to one and they decide whether to join.`)],
      foot: [h("button", { type: "button", onclick: () => blockListing(result) }, "Block"), h("button", { type: "button", class: "primary", onclick: invite }, "Invite to a group")] });
    return;
  }
  openSheet({ title: result.name, body: [h("div", { class: "listing" }, bot("other"), h("div", {}, h("p", { class: "fine" }, `Assistant · Owned by ${result.ownerName} · Verified home: ${result.nodeName}`))), routes,
    h("div", { class: "sec", style: "margin:16px 0 6px" }, "Public actions"),
    (result.actions ?? []).length ? result.actions.map(action => h("div", { class: "work" }, h("div", {}, h("strong", {}, action.name), h("small", {}, action.description), action.inputs ? h("small", {}, `Provide: ${action.inputs}`) : null))) : h("p", { class: "fine" }, "No public actions yet."),
    h("p", { class: "fine", style: "margin-top:10px" }, `${result.ownerName}'s instructions decide what it does for you. It may need ${result.ownerName}'s approval first.`)],
    foot: [h("button", { type: "button", onclick: invite }, "Invite to a group"), h("button", { type: "button", class: "primary", "data-testid": "assistant-start-request", onclick: () => startRequest(result) }, "Start a request")] });
}
