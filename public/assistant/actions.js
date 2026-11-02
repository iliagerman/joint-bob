import { del, post, put, request } from "./api.js";
import { app, fail, isMobile, navigate, notify } from "./context.js";
import { chip, h, icon } from "./dom.js";

// Public actions: what people may ask this assistant for, and the owner's private rules.

const OPERATIONS = [
  ["calendar.freebusy", "Read free and busy times", "Times only, no titles or guests. Uses the Google account attached under Resources → Secrets."],
  ["calendar.create", "Create an event", "Adds one event to your calendar. Uses the same Google account."],
  ["info.share", "Share a text I write", "Replies with exactly the text you write below."],
];
const STATUS = { published: () => chip("Published", "ok"), disabled: () => chip("Disabled"), draft: () => chip("Draft", "amber") };
const DECISION = { execute: ["Do it", "ok"], ask_owner: ["Ask you first", "amber"], decline: ["Decline", "bad"], clarify: ["Ask for details", "amber"], failed: ["No decision", "bad"] };
const view = { actions: [], selected: null, open: false, test: null };
const base = () => `/api/personal-assistants/${app.assistant.id}/actions`;

export async function showActions() {
  const { actions } = await request(base());
  view.actions = actions;
  if (!actions.some(action => action.id === view.selected)) view.selected = actions[0]?.id ?? null;
  renderActions();
}

const selected = () => view.actions.find(action => action.id === view.selected);

function listedOn() {
  const me = app.me;
  const relays = me ? me.relays.filter(relay => me.discovery.some(item => item.subjectKind === "assistant" && item.subjectId === app.assistant.id && item.relayNodeId === relay.relayNodeId)) : [];
  return relays.length ? `Findable on ${relays.map(relay => relay.name).join(", ")}` : "Not findable yet";
}

function sideList() {
  return h("div", { class: "side-list" },
    view.actions.map(action => h("button", { type: "button", class: "side-item", "aria-current": String(!isMobile() && action.id === view.selected), onclick: () => { view.selected = action.id; view.open = true; view.test = null; renderActions(); } },
      h("strong", {}, action.name), STATUS[action.status]())),
    h("button", { type: "button", style: "width:100%", "data-testid": "assistant-new-action", onclick: newAction }, icon("plus"), "New action"),
    h("p", { class: "fine", style: "margin-top:12px" }, `${listedOn()}. `, h("button", { type: "button", class: "link", onclick: () => navigate({ screen: "you" }) }, "Change")));
}

function field(label, control, hint) { return h("label", { class: "field" }, h("span", {}, label), control, hint ? h("small", {}, hint) : null); }

function editor(action) {
  const form = h("form", { id: "action-form" });
  const value = (name, text, attributes = {}) => h(attributes.multiline ? "textarea" : "input", { name, maxlength: attributes.max, rows: attributes.rows, ...(attributes.multiline ? {} : { value: text }) }, attributes.multiline ? text : null);
  const shareBox = h("div", { class: action.operations.includes("info.share") ? "" : "hidden" }, field("Text to share", value("shareText", action.shareText, { multiline: true, rows: 3, max: 4000 }), "This exact text is the reply."));
  const operations = OPERATIONS.map(([id, title, detail]) => {
    const box = h("input", { type: "checkbox", name: "operations", value: id });
    box.checked = action.operations.includes(id);
    if (id === "info.share") box.addEventListener("change", () => shareBox.classList.toggle("hidden", !box.checked));
    return h("label", { class: "op" }, box, h("span", {}, title, h("small", {}, detail)));
  });
  form.append(
    h("div", { class: "editor-box" }, h("p", { class: "label" }, "What people see"),
      field("Name", value("name", action.name, { max: 80 })), field("Description", value("description", action.description, { multiline: true, rows: 2, max: 500 })),
      field("What people provide", value("inputs", action.inputs, { max: 300 }))),
    h("div", { class: "editor-box" }, h("p", { class: "private-tag" }, icon("lock"), "Only you and the decision model see this"),
      field("Instructions", value("instructions", action.instructions, { multiline: true, rows: 3, max: 8000 }), "Write who it's for and when to ask you first. The decision model decides from this for every request.")),
    h("div", { class: "editor-box" }, h("p", { class: "label" }, "What it's allowed to do"), operations, shareBox,
      h("p", { class: "fine", style: "margin-top:8px" }, "Terminal, full browser and whole MCP servers can't be used for a public action."),
      action.problem ? h("div", { class: "notice", style: "margin:10px 0 0" }, icon("alert"), h("span", {}, action.problem)) : null));
  form.addEventListener("submit", event => { event.preventDefault(); saveAction(form).catch(fail); });
  return form;
}

function formValue(form) {
  const data = new FormData(form);
  return { name: String(data.get("name")).trim() || "New action", description: String(data.get("description") ?? "").trim(), inputs: String(data.get("inputs") ?? "").trim(),
    instructions: String(data.get("instructions") ?? "").trim(), operations: data.getAll("operations").map(String), shareText: String(data.get("shareText") ?? "").trim() };
}

function testBox(action) {
  const form = h("form", { "data-testid": "assistant-action-test" },
    h("div", { class: "pair" }, field("Ask as", h("input", { name: "callerName", value: view.test?.callerName ?? "Someone new", maxlength: 100 })),
      field("Request", h("input", { name: "text", value: view.test?.text ?? "30 minutes on Thursday at 15:00", maxlength: 4000 }))),
    h("button", { type: "submit" }, "Run test"));
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const data = new FormData(form);
    const input = { callerName: String(data.get("callerName")).trim(), text: String(data.get("text")).trim() };
    try { view.test = { ...input, result: await post(`${base()}/${action.id}/test`, input) }; renderActions(); }
    catch (error) { fail(error); }
  });
  const result = view.test?.result;
  return h("div", { class: "editor-box" }, h("p", { class: "label" }, "Test this action"), form,
    result ? h("div", { class: "exact", "data-testid": "assistant-action-test-result" }, h("p", { class: "label" }, "Decision"), chip(...DECISION[result.decision]), h("p", { style: "margin-top:7px" }, result.detail), h("p", { class: "fine", style: "margin-top:7px" }, "Test only. Nothing was read, created or sent."))
      : h("p", { class: "fine", style: "margin-top:8px" }, "A test never touches your calendar or sends anything."));
}

function detail(action) {
  const form = editor(action);
  const buttons = action.status === "published"
    ? [h("button", { type: "button", onclick: () => setStatus(action, "disabled") }, "Disable"), h("button", { type: "submit", form: "action-form", class: "primary grow" }, "Save changes")]
    : [h("button", { type: "button", class: "ghost", onclick: () => removeAction(action) }, "Delete"), h("button", { type: "submit", form: "action-form" }, "Save draft"),
      h("button", { type: "button", class: "primary grow", "data-testid": "assistant-publish-action", onclick: () => publish(action, form) }, action.status === "disabled" ? "Publish again" : "Publish")];
  return h("div", { class: "scroll" }, h("div", { class: "narrow" },
    isMobile() ? h("button", { type: "button", class: "link", style: "margin-bottom:12px", onclick: () => { view.open = false; renderActions(); } }, "Back to actions") : null,
    h("div", { class: "card-top" }, STATUS[action.status]()), form, testBox(action), h("div", { class: "actions", style: "margin-top:0" }, buttons)));
}

export function renderActions() {
  const target = document.querySelector("#actions-view");
  const action = selected();
  const empty = h("div", { class: "scroll" }, h("div", { class: "narrow" }, h("div", { class: "empty" }, "No public actions yet. Add one so people can ask this assistant for something, like your free times.")));
  const main = action ? detail(action) : empty;
  target.replaceChildren(h("div", { class: "list-layout" }, isMobile() && view.open && action ? null : sideList(), isMobile() && !(view.open && action) ? null : main));
}

async function newAction() {
  try {
    const { action } = await post(base(), { name: "New action", description: "", inputs: "", instructions: "", operations: [], shareText: "" });
    view.selected = action.id; view.open = true; view.test = null;
    await showActions();
  } catch (error) { fail(error); }
}

async function saveAction(form) {
  const action = selected();
  await put(`${base()}/${action.id}`, formValue(form));
  notify(action.status === "published" ? "Saved. Open proposals made with the old version are cancelled." : "Draft saved.");
  await showActions();
}

async function publish(action, form) {
  try {
    await put(`${base()}/${action.id}`, formValue(form));
    await post(`${base()}/${action.id}/status`, { status: "published" });
    notify("Published. People who can find this assistant can now request it.");
  } catch (error) { fail(error); }
  await showActions().catch(fail);
}

async function setStatus(action, status) {
  try { await post(`${base()}/${action.id}/status`, { status }); notify("Disabled. New and open requests for this action stop now."); await showActions(); }
  catch (error) { fail(error); }
}

async function removeAction(action) {
  if (!confirm(`Delete ${action.name}? Open requests for it stop.`)) return;
  try { await del(`${base()}/${action.id}`); view.selected = null; view.open = false; notify(`Deleted ${action.name}.`); await showActions(); }
  catch (error) { fail(error); }
}
