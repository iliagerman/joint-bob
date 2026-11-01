import { api } from "./api.js";
import { isNodeAdmin } from "./node-admin.js";
import { createSearchableSelect } from "./searchable-select.js";
import { toast } from "./shell.js";

// Settings → Guardian: one switch and a short list of rules in plain words. Thresholds, the unsure
// answer and fixes stay folded under "More options". Settings → Classifiers holds the model.
const CHECKS = [
  { value: "commands", label: "Before commands", detail: "Shell commands the agent runs" },
  { value: "file-changes", label: "Before file changes", detail: "Writes, edits, moves and deletes" },
  { value: "outgoing", label: "Before anything is sent to the AI", detail: "Your messages and what tools return" },
  { value: "all", label: "Before every action", detail: "Every tool call and everything sent to the AI" },
];
const IF_YES = [
  { value: "ask", label: "Ask me" },
  { value: "block", label: "Block" },
  { value: "fix", label: "Fix it, then continue", detail: "The fixed version is checked again" },
];
const UNSURE = [
  { value: "", label: "As the care level says" },
  { value: "ask", label: "Ask me" },
  { value: "block", label: "Block" },
  { value: "continue", label: "Continue" },
];
const FIXES = [
  { value: "remove-secrets", label: "Remove secrets (built in)", detail: "The project's secret values and common key formats" },
  { value: "script", label: "Run a script", detail: "Gets the content on stdin and prints the replacement" },
  { value: "agent", label: "Ask a helper agent", detail: "The conversation's agent with every tool off" },
];
const CARE = {
  relaxed: { label: "Relaxed", hint: "Acts only when the model is very sure. When it isn't sure, the action goes ahead." },
  balanced: { label: "Balanced", hint: "Acts when the model is fairly sure. When it isn't sure, it asks you." },
  cautious: { label: "Cautious", hint: "Acts on any doubt. Expect more questions." },
};
const PAGE_SIZE = 6;

let view = null;
/** The ID of the rule open in the editor; `draft` is a new rule not saved yet. */
let editing = null;
let draft = null;
let page = 0;

function closeEditor() { editing = null; draft = null; render(); }

const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
const labelOf = (list, value) => list.find((item) => item.value === value)?.label ?? value;
const labeled = (text, control) => { const label = el("label"); label.append(text, control); return label; };

function button(text, className, testid, onClick) {
  const node = el("button", className, text);
  node.type = "button"; node.dataset.testid = testid;
  node.addEventListener("click", onClick);
  return node;
}

function select(id, label, options, value) {
  const control = createSearchableSelect({ id, testid: id.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`), label, placeholder: "Search", emptyText: "No matches" });
  control.setOptions(options);
  control.setValue(value);
  return control;
}

/** "Before commands · ask me". */
const summary = (rule) => `${labelOf(CHECKS, rule.check)} · ${labelOf(IF_YES, rule.ifYes).toLocaleLowerCase()}`;

async function save(settings) {
  try {
    view = await api("/api/guardian", { method: "PUT", body: JSON.stringify({ settings }) });
    return true;
  } catch (error) {
    toast(`Could not save Guardian: ${error.message}`, 6000);
    return false;
  } finally {
    render();
  }
}

const withRules = (rules) => ({ ...view.settings, rules });
const replaceRule = (rule) => view.settings.rules.some(({ id }) => id === rule.id) ? view.settings.rules.map((item) => item.id === rule.id ? rule : item) : [...view.settings.rules, rule];

function careControl(rule) {
  const group = el("div", "settings-subtabs"); group.role = "radiogroup"; group.setAttribute("aria-label", "How careful");
  const hint = el("p", "settings-hint", CARE[rule.care].hint);
  for (const [value, { label }] of Object.entries(CARE)) {
    const option = el("button", "settings-subtab", label);
    option.type = "button"; option.role = "radio"; option.dataset.care = value; option.dataset.testid = `guardian-care-${value}`;
    const mark = () => { for (const item of group.children) { const on = item.dataset.care === group.dataset.value; item.setAttribute("aria-checked", String(on)); item.setAttribute("aria-selected", String(on)); } hint.textContent = CARE[group.dataset.value].hint; };
    option.addEventListener("click", () => { group.dataset.value = value; mark(); });
    group.append(option);
  }
  group.dataset.value = rule.care;
  for (const item of group.children) { const on = item.dataset.care === rule.care; item.setAttribute("aria-checked", String(on)); item.setAttribute("aria-selected", String(on)); }
  return { group, hint, get value() { return group.dataset.value; } };
}

function percentInput(id, value, fallback) {
  const input = el("input"); input.type = "number"; input.min = "0"; input.max = "100"; input.step = "1"; input.id = id; input.dataset.testid = id;
  input.placeholder = `${fallback}`;
  input.value = value === null ? "" : String(Math.round(value * 100));
  return input;
}

function moreOptions(rule) {
  const details = el("details", "subscription-more");
  details.append(el("summary", "", "More options"));
  const yesAt = percentInput("guardianYesAt", rule.yesAt, "Care level decides");
  const noAt = percentInput("guardianNoAt", rule.noAt, "Care level decides");
  const unsure = select("guardianWhenUnsure", "When unsure", UNSURE, rule.whenUnsure ?? "");
  const fix = select("guardianFixKind", "Fix with", FIXES, rule.fix.kind);
  const command = el("input"); command.id = "guardianFixScript"; command.dataset.testid = "guardian-fix-script"; command.spellcheck = false; command.placeholder = "~/bin/redact.sh";
  command.value = rule.fix.kind === "script" ? rule.fix.command : "";
  const instructions = el("textarea"); instructions.rows = 3; instructions.dataset.testid = "guardian-fix-agent";
  instructions.placeholder = "Rewrite the content without any personal information.";
  instructions.value = rule.fix.kind === "agent" ? rule.fix.instructions : "";
  const scriptLabel = labeled("Script", command);
  const agentLabel = labeled("Helper agent instructions", instructions);
  const showFix = () => { scriptLabel.hidden = fix.value !== "script"; agentLabel.hidden = fix.value !== "agent"; };
  fix.onChange(showFix); showFix();
  details.append(labeled("Yes at or above (%)", yesAt), labeled("No at or below (%)", noAt), labeled("When unsure", unsure.root), labeled("Fix with", fix.root), scriptLabel, agentLabel);
  if (rule.ifYes === "fix" || rule.yesAt !== null || rule.noAt !== null || rule.whenUnsure || rule.fix.kind !== "remove-secrets") details.open = true;
  const percent = (input) => input.value === "" ? null : Number(input.value) / 100;
  return {
    details,
    read: () => ({
      yesAt: percent(yesAt), noAt: percent(noAt), whenUnsure: unsure.value || null,
      fix: fix.value === "script" ? { kind: "script", command: command.value.trim() } : fix.value === "agent" ? { kind: "agent", instructions: instructions.value.trim() } : { kind: "remove-secrets" },
    }),
  };
}

function editor(rule) {
  const box = el("div", "guardian-editor"); box.dataset.testid = "guardian-rule-editor";
  const name = el("input"); name.value = rule.name; name.maxLength = 80; name.dataset.testid = "guardian-rule-name";
  const question = el("textarea"); question.rows = 2; question.maxLength = 1000; question.value = rule.question; question.dataset.testid = "guardian-rule-question";
  const check = select("guardianCheck", "Check", CHECKS, rule.check);
  const ifYes = select("guardianIfYes", "If yes", IF_YES, rule.ifYes);
  const care = careControl(rule);
  const more = moreOptions(rule);
  const saveRule = async () => {
    const next = { ...rule, name: name.value.trim(), question: question.value.trim(), check: check.value, ifYes: ifYes.value, care: care.value, ...more.read() };
    if (await save(withRules(replaceRule(next)))) closeEditor();
  };
  const actions = el("div", "github-group-actions");
  actions.append(button("Save", "primary", "guardian-rule-save", saveRule), button("Cancel", "ghost", "guardian-rule-cancel", closeEditor));
  if (view.settings.rules.some(({ id }) => id === rule.id)) actions.append(button("Delete", "ghost danger", "guardian-rule-delete", () => save(withRules(view.settings.rules.filter(({ id }) => id !== rule.id))).then((saved) => { if (saved) closeEditor(); })));
  box.append(labeled("Name", name), labeled("Question", question), labeled("Check", check.root), labeled("If yes", ifYes.root), el("label", "", "How careful"), care.group, care.hint, more.details, actions);
  return box;
}

function ruleRow(rule, relaySource) {
  const row = el("div", "cluster-node guardian-rule"); row.dataset.testid = "guardian-rule"; row.dataset.ruleId = rule.id;
  if (rule === draft) { row.append(editor(rule)); return row; }
  const toggle = el("label", "checkbox-row");
  const box = el("input"); box.type = "checkbox"; box.checked = rule.enabled; box.disabled = Boolean(relaySource); box.dataset.testid = "guardian-rule-enabled";
  box.setAttribute("aria-label", `${rule.name} rule`);
  box.addEventListener("change", () => save(withRules(replaceRule({ ...rule, enabled: box.checked }))));
  const copy = el("span", "guardian-rule-copy");
  copy.append(el("strong", "", rule.name), el("span", "", summary(rule)));
  toggle.append(box, copy);
  row.append(toggle);
  if (relaySource) row.append(el("span", "cluster-badge", `🔒 ${relaySource}`));
  else row.append(button(editing === rule.id ? "Editing" : "Edit", "ghost compact", "guardian-rule-edit", () => { editing = editing === rule.id ? null : rule.id; render(); }));
  if (editing === rule.id) row.append(editor(rule));
  return row;
}

function pager(total) {
  const pages = Math.ceil(total / PAGE_SIZE);
  const nav = el("div", "relay-pager"); nav.dataset.testid = "guardian-rules-pager";
  if (pages <= 1) { nav.hidden = true; return nav; }
  const previous = button("‹", "ghost compact", "guardian-rules-previous", () => { page -= 1; render(); });
  const next = button("›", "ghost compact", "guardian-rules-next", () => { page += 1; render(); });
  previous.disabled = page === 0; next.disabled = page >= pages - 1;
  nav.append(previous, el("span", "", `${page + 1} of ${pages}`), next);
  return nav;
}

function newRule() {
  return { id: `rule-${Date.now().toString(36)}`, name: "New rule", question: "", enabled: true, check: "commands", ifYes: "ask", care: "balanced", yesAt: null, noAt: null, whenUnsure: null, fix: { kind: "remove-secrets" } };
}

function rulesFieldset() {
  const fieldset = el("fieldset", "phase-settings");
  fieldset.append(el("legend", "", "Rules"));
  const rows = [
    ...view.relays.flatMap(({ source, rules }) => rules.map((rule) => ({ rule, source }))),
    ...view.settings.rules.map((rule) => ({ rule })),
    ...(draft ? [{ rule: draft }] : []),
  ];
  page = Math.min(page, Math.max(0, Math.ceil(rows.length / PAGE_SIZE) - 1));
  const list = el("div", "cluster-inventory"); list.dataset.testid = "guardian-rules";
  for (const { rule, source } of rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) list.append(ruleRow(rule, source));
  const actions = el("div", "github-group-actions");
  const add = button("Add a rule", "ghost", "guardian-rule-add", () => { draft = newRule(); editing = draft.id; page = Math.ceil((rows.length + 1) / PAGE_SIZE) - 1; render(); });
  add.disabled = view.settings.rules.length >= 50 || Boolean(draft);
  actions.append(add);
  fieldset.append(list, pager(rows.length), actions);
  return fieldset;
}

function relayControl() {
  if (!view.relay.serving) return [];
  const label = el("label", "checkbox-row");
  const box = el("input"); box.type = "checkbox"; box.checked = view.relay.enforced; box.dataset.testid = "guardian-relay-enforce";
  box.addEventListener("change", async () => {
    try { view = await api("/api/guardian/relay-policy", { method: "PUT", body: JSON.stringify({ enforce: box.checked }) }); }
    catch (error) { toast(`Could not change the relay's Guardian rules: ${error.message}`, 6000); }
    render();
  });
  label.append(box, " Enforce these rules on every machine of the relay this machine serves");
  return [label, el("p", "settings-hint", "Members cannot turn them off. A rule that asks lets the member review; Block blocks. Relay rules fix only with the built-in secret removal.")];
}

function modelLine() {
  const line = el("p", "settings-hint");
  const name = view.settings.model === "jev" ? "Jev" : view.settings.model === "laya-local" ? "Laya on this machine" : `Laya at ${view.settings.layaUrl}`;
  line.append("Checked by ", el("strong", "", name), ". Change it in Classifiers. If Guardian can't reach it, the action is blocked.");
  return line;
}

function limits() {
  const details = el("details", "subscription-more");
  details.append(el("summary", "", "What Guardian can't see"), el("p", "settings-hint",
    "Claude and Kiro read tool output before Guardian can check it: rules that check what is sent to the AI cover their messages only, and a relay that requires such a rule keeps them from starting. Kiro can only allow or block a call, so a fix asks you instead. Guardian is a guardrail, not a sandbox: a model can be wrong, and a command can hide what it does."));
  return details;
}

function render() {
  const host = document.getElementById("guardianSettings");
  if (!host || !view) return;
  const enabled = el("label", "checkbox-row");
  const box = el("input"); box.type = "checkbox"; box.checked = view.settings.enabled; box.dataset.testid = "guardian-enabled";
  box.addEventListener("change", () => save({ ...view.settings, enabled: box.checked }));
  enabled.append(box, " Turn on Guardian for every conversation");
  host.replaceChildren(
    el("p", "", "Guardian looks at what agents are about to do and stops them, or asks you, when something looks risky. Once on, it covers every conversation and agent on this machine, scheduled runs and webhooks included."),
    enabled, rulesFieldset(), modelLine(), ...relayControl(), limits(),
  );
  renderModels();
}

function layaDetail(laya) {
  if (laya.installing) return "Installing… this takes a few minutes";
  if (laya.installError) return `Install failed: ${laya.installError}`;
  if (laya.installed) return laya.running ? "Installed · running" : "Installed · starts on first use";
  return laya.allowed ? "Free, runs on your machines" : laya.reason;
}

async function installLaya() {
  try { view.laya = await api("/api/guardian/laya/install", { method: "POST" }); }
  catch (error) { toast(`Could not install Laya: ${error.message}`, 6000); }
  renderModels();
  // The install runs in the background; check on it until it ends.
  while (view.laya.installing) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    view.laya = await api("/api/guardian/laya");
    renderModels();
  }
}

/** The model as stored: Laya means the saved server when there is one, this machine otherwise. */
const modelFor = (choice, layaUrl) => choice === "jev" ? "jev" : layaUrl ? "laya-remote" : "laya-local";

function renderModels() {
  const host = document.getElementById("guardianModels");
  if (!host || !view) return;
  const fieldset = el("fieldset", "phase-settings");
  fieldset.append(el("legend", "", "Decision models"));
  const choice = select("guardianModel", "Guardian uses", [
    { value: "jev", label: "Jev", detail: "Hosted by TypeSafe" },
    { value: "laya", label: "Laya", detail: view.settings.layaUrl ? `At ${view.settings.layaUrl}` : "On this machine" },
  ], view.settings.model === "jev" ? "jev" : "laya");
  choice.onChange((value) => save({ ...view.settings, model: modelFor(value, view.settings.layaUrl) }));
  const rows = el("div", "cluster-inventory");
  const jev = el("div", "cluster-node");
  const jevIdentity = el("div", "cluster-node-identity");
  jevIdentity.append(el("strong", "", "Jev"), el("span", "cluster-node-url", "TypeSafe · uses TYPESAFE_AI_API_KEY from a secret account attached to the project or its workspace · content leaves this machine"));
  jev.append(jevIdentity);
  const laya = el("div", "cluster-node"); laya.dataset.testid = "guardian-laya-row";
  const identity = el("div", "cluster-node-identity");
  identity.append(el("strong", "", "Laya"), el("span", "cluster-node-url", layaDetail(view.laya)));
  laya.append(identity);
  if (view.laya.allowed && !view.laya.installed && !view.laya.installing) laya.append(button("Install here", "ghost compact", "guardian-laya-install", installLaya));
  rows.append(jev, laya);
  const address = el("input"); address.type = "url"; address.spellcheck = false; address.placeholder = "http://gpu-box:8000"; address.value = view.settings.layaUrl; address.dataset.testid = "guardian-laya-url";
  const saveAddress = button("Save", "ghost compact", "guardian-laya-url-save", () => {
    const layaUrl = address.value.trim();
    save({ ...view.settings, layaUrl, model: view.settings.model === "jev" ? "jev" : modelFor("laya", layaUrl) });
  });
  const addressRow = el("div", "cluster-create-row");
  addressRow.append(labeled("Laya on another machine", address), el("p", "", "Leave empty to use Laya on this machine. A key, if the server needs one, comes from LAYA_API_KEY on a secret account."), saveAddress);
  fieldset.append(labeled("Guardian uses", choice.root), rows, addressRow, el("p", "settings-hint", "Routing configurations can choose Laya as their classifier too. When the model cannot be reached, Guardian blocks the action; nothing switches to another model."));
  host.replaceChildren(fieldset);
}

export async function loadGuardianSettings() {
  if (!isNodeAdmin()) return;
  view = await api("/api/guardian");
  render();
}
