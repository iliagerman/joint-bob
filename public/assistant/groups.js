import { post, request } from "./api.js";
import { app, closeOverlay, fail, isMobile, navigate, notify, openSheet } from "./context.js";
import { avatar, bot, chip, formatTime, h, icon, rowText } from "./dom.js";

// Groups: the chat, its members and whose assistant is whose, and invitations.

const relayName = id => app.me?.relays.find(relay => relay.relayNodeId === id)?.name ?? "Relay";
let current = null;

export async function loadGroups() {
  const [{ groups }, invitations] = await Promise.all([request("/api/social/groups"), request("/api/social/invitations")]);
  app.groups = groups;
  app.invitations = invitations;
}
export const pendingInvitations = () => app.invitations.received.filter(invitation => invitation.state === "pending").length;

function head(title, subtitle, right = []) {
  return h("header", { class: "head" },
    isMobile() ? h("button", { type: "button", class: "icon ghost", "aria-label": "Back", onclick: () => history.back() }, icon("back")) : null,
    h("span", { class: "av", "aria-hidden": "true" }, icon("people")),
    h("div", { class: "head-text" }, h("h1", {}, title), subtitle ? h("p", {}, subtitle) : null), h("div", { class: "head-actions" }, right));
}

// ---- One group ----

function messageNode(message, detail) {
  if (message.authorKind === "system") return h("div", { class: "sys" }, message.text);
  if (detail.me && message.authorMembershipId === detail.me.membershipId) return h("div", { class: "m me" }, h("div", {}, h("div", { class: "bubble" }, message.text), h("div", { class: "send-state" }, formatTime(message.createdAt))));
  if (message.authorKind === "assistant") return h("div", { class: "m bot-msg" }, bot("other"), h("div", {}, h("div", { class: "who" }, h("b", {}, message.authorName), `Assistant · For ${message.ownerName}`), h("div", { class: "bubble" }, message.text)));
  return h("div", { class: "m" }, avatar(message.authorName), h("div", {}, h("div", { class: "who" }, h("b", {}, message.authorName)), h("div", { class: "bubble" }, message.text)));
}

function outboxNode(entry) {
  const state = entry.status === "rejected" ? `Not sent: ${entry.error}` : "Waiting for the host";
  return h("div", { class: "m me" }, h("div", {}, h("div", { class: "bubble" }, entry.text), h("div", { class: "send-state" }, state)));
}

function memberTree(detail) {
  const myAccount = app.me?.account.accountId;
  const creator = detail.group.creatorAccountId === myAccount;
  const people = detail.members.filter(member => member.kind === "person");
  const assistants = detail.members.filter(member => member.kind === "assistant");
  const removeButton = (member, label) => h("button", { type: "button", class: "ghost tree-remove", onclick: () => confirmRemove(detail, member) }, label);
  const assistantRow = member => h("div", { class: `tree-bot${member.link === "alone" ? " alone" : ""}` }, bot(member.accountId === myAccount ? "" : "other"),
    h("div", { class: "tree-text" }, h("b", {}, member.name), h("small", {}, member.link === "with" ? `Joined with ${member.ownerName}. Leaves with ${member.ownerName}.` : `Invited on its own. ${member.ownerName} approved.`)),
    creator && member.link === "alone" ? removeButton(member, "Remove") : null);
  const nodes = people.map(person => [h("div", { class: "tree-person" }, avatar(person.name, person.accountId === myAccount ? "you" : ""),
    h("div", { class: "tree-text" }, h("b", {}, person.name), h("small", {}, [person.accountId === myAccount ? "You" : "", person.accountId === detail.group.creatorAccountId ? "Created this group" : ""].filter(Boolean).join(" · "))),
    creator && person.accountId !== myAccount ? removeButton(person, "Remove") : null),
    assistants.filter(member => member.companionOf === person.membershipId).map(assistantRow)]);
  const alone = assistants.filter(member => !member.companionOf);
  const owners = [...new Set(alone.map(member => member.ownerName))];
  const absent = owners.map(owner => [h("div", { class: "tree-person" }, avatar(owner, "ghost"), h("div", { class: "tree-text" }, h("b", {}, owner), h("small", {}, people.some(person => person.name === owner) ? "Owner" : "Owner · Not in this group"))),
    alone.filter(member => member.ownerName === owner).map(assistantRow)]);
  const invited = detail.invitations.filter(invitation => invitation.state === "pending");
  return [nodes, absent,
    invited.length ? [h("div", { class: "sec", style: "margin:14px 0 2px" }, "Invited"), invited.map(invitation => h("div", { class: "tree-person" }, avatar(invitation.inviteeName, "ghost"), h("div", { class: "tree-text" }, h("b", {}, invitation.inviteeName), h("small", {}, invitation.inviteeKind === "assistant" ? `Waiting for ${invitation.ownerName}` : "Waiting for an answer"))))] : null,
    h("p", { class: "fine", style: "margin-top:14px" }, "An assistant reads new messages and can report them to its owner, who can review what it saw and decided here."),
    h("div", { class: "members-foot" }, detail.group.status === "open" ? h("button", { type: "button", "data-testid": "assistant-group-invite", onclick: () => openInviteSheet(detail.group, null) }, icon("plus"), "Invite a person or assistant") : null,
      creator ? h("button", { type: "button", class: "danger", onclick: () => confirmClose(detail) }, "Close group") : h("button", { type: "button", class: "danger", onclick: () => confirmLeave(detail) }, "Leave group"))];
}

function composer(detail) {
  const box = h("textarea", { rows: 1, required: true, maxlength: 8000, placeholder: `Message ${detail.group.name}…`, "aria-label": `Message ${detail.group.name}` });
  const form = h("form", { class: "composer", id: "group-composer" }, box, h("div", { class: "composer-foot" }, h("span", { class: "spacer" }), h("button", { type: "submit", class: "primary icon", "aria-label": "Send" }, icon("send"))));
  box.addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const text = box.value.trim();
    if (!text) return;
    try {
      const { message } = await post(`/api/social/groups/${detail.group.id}/messages`, { id: crypto.randomUUID(), text });
      box.value = "";
      if (message.status === "pending") notify("The host is offline. Your message waits on this machine until it's back.");
      if (message.status === "rejected") notify(`Not sent: ${message.error}`, true);
      await showGroup(detail.group.id);
    } catch (error) { fail(error); }
  });
  return h("div", { class: "composer-wrap" }, form);
}

export async function showGroup(groupId) {
  const target = document.querySelector("#social-view");
  let detail;
  try { detail = await request(`/api/social/groups/${groupId}`); }
  catch (error) {
    if (error.status === 404) { target.replaceChildren(head("Group", ""), h("div", { class: "narrow" }, h("div", { class: "empty" }, "You're no longer in this group, or it was closed."))); await loadGroups().catch(() => {}); return; }
    throw error;
  }
  current = groupId;
  const me = app.me?.account.nodeId;
  const host = detail.group.hostNodeId === me ? "your machine" : "another member's machine";
  const count = detail.members.length;
  const right = isMobile() && detail.hostOnline ? [h("button", { type: "button", "aria-label": `${count} members`, onclick: () => openSheet({ title: `${detail.group.name} members`, body: memberTree(detail) }) }, icon("people"), String(count))] : [];
  const scroll = h("div", { class: "scroll" }, h("div", { class: "msgs", "data-testid": "assistant-group-messages" }, detail.messages.map(message => messageNode(message, detail)), detail.outbox.map(outboxNode)));
  target.replaceChildren(head(detail.group.name, `${relayName(detail.group.relayNodeId)} · Hosted on ${host}${detail.hostOnline ? "" : " · Offline"}`, right),
    h("div", { class: "split" }, h("div", { class: "col" },
      detail.hostOnline ? null : h("div", { class: "strip" }, icon("alert"), h("span", {}, "The machine hosting this group is offline. New messages wait on this device until it's back.")),
      detail.group.status === "closed" ? h("div", { class: "strip" }, h("span", {}, "This group is closed.")) : null,
      scroll, detail.group.status === "open" ? composer(detail) : null),
    !isMobile() && detail.hostOnline ? h("aside", { class: "members", "aria-label": "Members" }, h("div", { class: "sec", style: "margin:0 0 4px" }, `Members · ${count}`), memberTree(detail)) : null));
  scroll.scrollTop = scroll.scrollHeight;
}
export const currentGroup = () => current;
export function leftGroupScreen() { current = null; }

function confirmSheet(title, bullets, confirmLabel, action) {
  openSheet({ title, body: h("ul", { class: "bullets" }, bullets.map(text => h("li", {}, icon("dot"), text))),
    foot: [h("button", { type: "button", onclick: closeOverlay }, "Cancel"), h("button", { type: "button", class: "danger", onclick: async () => { try { await action(); } catch (error) { fail(error); } } }, confirmLabel)] });
}

function confirmLeave(detail) {
  const mine = detail.members.filter(member => member.kind === "assistant" && member.companionOf === detail.me?.membershipId);
  const alone = detail.members.filter(member => member.kind === "assistant" && member.link === "alone" && member.accountId === app.me?.account.accountId);
  confirmSheet(`Leave ${detail.group.name}?`, [
    ...mine.map(member => `${member.name} leaves with you. Its pending work here stops and its open approvals are cancelled.`),
    ...alone.map(member => `${member.name} stays, because it was invited on its own. You can remove it separately.`),
    "You stop getting new messages. Messages already delivered to your devices can't be erased."],
  "Leave group", async () => { await post(`/api/social/groups/${detail.group.id}/leave`); notify(`You left ${detail.group.name}.${mine.length ? ` ${mine.map(member => member.name).join(", ")} left with you.` : ""}`); await loadGroups(); await navigate({}); });
}

function confirmRemove(detail, member) {
  const companions = detail.members.filter(item => item.companionOf === member.membershipId);
  confirmSheet(`Remove ${member.name}?`, member.kind === "assistant"
    ? [`${member.name} stops watching this group, and its pending work here stops. Its owner sees that it was removed.`]
    : [...companions.map(item => `${item.name} leaves too, and its pending work here stops.`), `${member.name} stops getting new messages. Messages already delivered can't be erased.`],
  "Remove", async () => { await post(`/api/social/groups/${detail.group.id}/members/${member.membershipId}/remove`); closeOverlay(); await showGroup(detail.group.id); });
}

function confirmClose(detail) {
  confirmSheet(`Close ${detail.group.name}?`, ["Nobody can send messages, and every assistant stops watching.", "Pending work and open approvals from this group are cancelled.", "You created this group, so leaving it also closes it. Handing it to someone else comes later."],
    "Close group", async () => { await post(`/api/social/groups/${detail.group.id}/close`); notify(`Closed ${detail.group.name}.`); await loadGroups(); await navigate({}); });
}

// ---- New group and invitations ----

export function openNewGroupSheet() {
  const relays = (app.me?.relays ?? []).filter(relay => relay.active);
  if (!relays.length) { openSheet({ title: "New group", body: h("div", { class: "notice plain" }, icon("info"), h("span", {}, "Connect this machine to a relay first. A group lives on one relay.")) }); return; }
  const companion = app.assistants.find(entry => entry.id === app.me.profile.defaultAssistantId);
  const form = h("form", { id: "new-group" },
    h("label", { class: "field" }, h("span", {}, "Group name"), h("input", { name: "name", required: true, maxlength: 100, placeholder: "Vendor review", autocomplete: "off" })),
    h("label", { class: "field" }, h("span", {}, "Relay"), h("select", { name: "relayNodeId" }, relays.map(relay => h("option", { value: relay.relayNodeId }, relay.name))), h("small", {}, "A group lives on one relay. Your machine hosts it, so messages reach people only while it's online.")),
    h("div", { class: "notice plain" }, companion ? bot() : icon("info"), h("span", {}, companion ? `${companion.name} joins with you. Everyone in the group can see it.` : "You have no default assistant, so only you join.", " ", h("button", { type: "button", class: "link", onclick: () => navigate({ screen: "you" }) }, "Change"))));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const data = new FormData(form);
    try {
      const { group } = await post("/api/social/groups", { name: String(data.get("name")).trim(), relayNodeId: String(data.get("relayNodeId")) });
      await loadGroups();
      await navigate({ group: group.id });
    } catch (error) { fail(error); }
  });
  openSheet({ title: "New group", body: form, foot: [h("button", { type: "button", onclick: closeOverlay }, "Cancel"), h("button", { type: "submit", class: "primary", form: "new-group" }, "Create group")] });
}

const inviteePayload = result => result.kind === "person"
  ? { kind: "person", id: result.id, accountId: result.id, nodeId: result.nodeId, name: result.name, ownerName: "" }
  : { kind: "assistant", id: result.id, accountId: result.ownerAccountId, nodeId: result.nodeId, name: result.name, ownerName: result.ownerName };

/** Invite someone: from a group (search here) or from a found card (choose the group). */
export function openInviteSheet(group, invitee) {
  let chosen = invitee;
  const groups = app.groups.filter(entry => !invitee || invitee.relays.includes(entry.relayNodeId));
  const groupSelect = group ? null : h("select", { name: "group" }, groups.map(entry => h("option", { value: entry.groupId }, `${entry.name} (${relayName(entry.relayNodeId)})`)));
  const results = h("div");
  const pick = result => { chosen = result; render(); };
  const describe = result => result.kind === "assistant" ? `${result.ownerName} must approve and doesn't join the group.` : "Can accept or decline. If they accept, their default assistant joins too.";
  const render = () => results.replaceChildren(...(chosen ? [h("div", { class: "work" }, result(chosen), h("div", {}, h("strong", {}, chosen.name), h("small", {}, describe(chosen))), invitee ? null : h("button", { type: "button", class: "ghost", onclick: () => { chosen = null; search(); } }, "Change"))] : []));
  const result = entry => entry.kind === "person" ? avatar(entry.name) : bot("other");
  const query = h("input", { type: "search", placeholder: "Search people and assistants", "aria-label": "Search people and assistants" });
  let timer;
  const search = async () => {
    if (chosen) { render(); return; }
    try {
      const answer = await request(`/api/social/search?${new URLSearchParams({ q: query.value.trim(), kind: "all" })}`);
      const usable = answer.results.filter(entry => !group || entry.relays.includes(group.relayNodeId));
      results.replaceChildren(...(usable.length ? usable.slice(0, 6).map(entry => h("button", { type: "button", class: "result", onclick: () => pick(entry) }, result(entry), rowText(entry.name, entry.kind === "assistant" ? `${entry.ownerName}'s assistant` : entry.description || entry.nodeName, [chip(entry.kind === "person" ? "Person" : "Assistant")])))
        : [h("div", { class: "empty" }, "Nobody found on this group's relay.")]));
    } catch (error) { fail(error); }
  };
  query.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 300); });
  const send = async () => {
    const groupId = group?.id ?? groupSelect?.value;
    if (!groupId) { notify("Create a group on this relay first.", true); return; }
    if (!chosen) { notify("Choose who to invite.", true); return; }
    try { await post(`/api/social/groups/${groupId}/invitations`, inviteePayload(chosen)); closeOverlay(); notify(`Invitation sent to ${chosen.name}.`); await loadGroups(); if (current === groupId) await showGroup(groupId); }
    catch (error) { fail(error); }
  };
  openSheet({ title: "Invite to a group", body: [
    groupSelect ? (groups.length ? h("label", { class: "field" }, h("span", {}, "Group"), groupSelect) : h("div", { class: "notice plain" }, icon("info"), h("span", {}, "You have no group on a relay this person shares. Create one first."))) : null,
    invitee ? null : h("div", { class: "search" }, icon("search"), query), results,
    h("p", { class: "fine", style: "margin-top:10px" }, "They see messages from when they join, not earlier ones.")],
  foot: [h("button", { type: "button", onclick: closeOverlay }, "Cancel"), h("button", { type: "button", class: "primary", onclick: send }, "Send invitation")] });
  if (chosen) render(); else search();
}

function receivedCard(invitation) {
  const relay = chip(relayName(invitation.relayNodeId));
  if (invitation.state !== "pending") return h("article", { class: `card${invitation.state === "accepted" ? " done" : ""}` }, h("div", { class: "card-top" }, h("strong", {}, invitation.groupName), chip(invitation.state[0].toUpperCase() + invitation.state.slice(1), invitation.state === "accepted" ? "ok" : "")), invitation.result ? h("p", { class: "muted" }, invitation.result) : null);
  const problem = h("div", { class: "notice hidden", style: "margin:10px 0 0" }, icon("alert"), h("span"));
  const respond = async accept => {
    try {
      const answer = await post(`/api/social/invitations/${invitation.id}/${accept ? "accept" : "decline"}`);
      notify(answer.result);
      await loadGroups();
      if (answer.groupId) await navigate({ group: answer.groupId }); else await showInvitations();
    } catch (error) {
      if (error.status === 409 || error.status === 410) { problem.classList.remove("hidden"); problem.querySelector("span").textContent = error.message; return; }
      fail(error);
    }
  };
  const assistant = invitation.inviteeKind === "assistant" ? app.assistants.find(entry => entry.id === invitation.inviteeId) : null;
  const companion = app.assistants.find(entry => entry.id === app.me?.profile.defaultAssistantId);
  const bullets = assistant
    ? ["You won't join the group, and you can't read it directly.", `${assistant.name} will read new messages and report to you.`, "Members will see you as its owner."]
    : [companion ? `${companion.name} joins with you, and everyone can see it.` : "You join alone because you have no default assistant.", "You'll see messages from when you join, not earlier ones."];
  return h("article", { class: "card", "data-testid": "assistant-invitation" }, h("div", { class: "card-top" }, h("div", { class: "chips" }, relay, assistant ? chip("For your assistant", "amber") : null), h("small", {}, `Expires ${new Date(invitation.expiresAt).toLocaleDateString()}`)),
    h("h3", {}, assistant ? `${invitation.fromName} invited ${assistant.name} to ${invitation.groupName}` : `${invitation.fromName} invited you to ${invitation.groupName}`),
    h("ul", { class: "bullets" }, bullets.map(text => h("li", {}, icon("dot"), text))), problem,
    h("div", { class: "actions" }, h("button", { type: "button", onclick: () => respond(false) }, "Decline"), h("button", { type: "button", class: "primary grow", onclick: () => respond(true) }, assistant ? `Approve for ${assistant.name}` : "Accept")));
}

export async function showInvitations() {
  await loadGroups();
  const target = document.querySelector("#social-view");
  const { received, sent } = app.invitations;
  const stateKind = { pending: "amber" };
  target.replaceChildren(head("Invitations", "Nobody joins a group or sees its messages until they accept"), h("div", { class: "scroll" }, h("div", { class: "narrow" },
    h("div", { class: "sec", style: "margin:0 0 8px" }, "Received"), received.length ? received.map(receivedCard) : h("p", { class: "fine" }, "No invitations yet."),
    h("div", { class: "sec", style: "margin:18px 0 4px" }, "Sent"),
    sent.length ? sent.map(item => h("div", { class: "work", style: "align-items:center" }, h("div", {}, h("strong", {}, item.inviteeName), h("small", {}, item.groupName)), chip(item.state[0].toUpperCase() + item.state.slice(1), stateKind[item.state] ?? ""),
      item.state === "pending" ? h("button", { type: "button", style: "min-height:30px;padding:2px 10px", onclick: async () => { try { await post(`/api/social/invitations/${item.id}/revoke`); await showInvitations(); } catch (error) { fail(error); } } }, "Revoke") : null)) : h("p", { class: "fine" }, "You haven't invited anyone yet."))));
}
