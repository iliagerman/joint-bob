// Settings → Relay. Joined relays (the relays this machine uses, in relay-memberships.js) and
// this machine as a relay: a serving form, the machines admitted to it, the tokens that admit
// new ones, and an audit log. Every action applies at once and none of them needs Save
// settings. The lists page to the height they are given instead of scrolling.
import { api } from "./api.js";
import { loadRelayMemberships } from "./relay-memberships.js";
import { copyText, createFittedList, formatBytes, formatWhen, makeBadge, makeButton, makeNode, makeTwoStepButton, shortFingerprint, showStatus } from "./relay-ui.js";

const byId = (id) => document.getElementById(id);
const field = {
  enabled: byId("relayEnabled"), origin: byId("relayOrigin"), environment: byId("relayEnvironment"), requests: byId("relayRequestsEnabled"), ownOnly: byId("relayOwnMachinesOnly"),
  maxMachines: byId("relayMaxMachines"), capGb: byId("relayMonthlyCapGb"), alertTopic: byId("relayAlertTopic"),
};
const loadStatus = byId("relayStatus");
const servingStatus = byId("relayServingStatus");
const machinesStatus = byId("relayMachinesStatus");
const tokensStatus = byId("relayTokensStatus");
const auditStatus = byId("relayAuditStatus");
const tabs = byId("relayTabs");
const checkButton = byId("relayCheckButton");
const checkResults = byId("relayCheckResults");
const checkHint = byId("relayCheckHint");
const tokenReveal = byId("relayTokenReveal");
const tokenLink = byId("relayTokenLink");

const STATUS_LABEL = { pending: "Waiting for approval", admitted: "Admitted", suspended: "Suspended" };
let serving = null;
/** Most machines join relays; few serve one, so the joined relays open first. */
let activeTab = "joined";
let machineFilter = "all";

// ---- summary and serving form ----

function fillForm(settings) {
  field.enabled.checked = settings.enabled;
  field.origin.value = settings.origin;
  field.environment.value = settings.environment;
  field.requests.checked = settings.requestsEnabled;
  field.ownOnly.checked = settings.ownMachinesOnly === true;
  field.maxMachines.value = settings.maxMachines;
  field.capGb.value = settings.monthlyCapGb;
  field.alertTopic.value = settings.alertTopic;
}

function renderSummary() {
  const { settings, fingerprint, connected, pending, admitted } = serving;
  const state = byId("relaySummaryState");
  state.textContent = settings.enabled ? "Serving" : "Off";
  state.className = `cluster-badge ${settings.enabled ? "ok" : ""}`.trim();
  byId("relayFingerprint").textContent = fingerprint || "Not available until serving is on";
  byId("relayFingerprintCopy").disabled = !fingerprint;
  byId("relayCounts").textContent = settings.enabled
    ? `${connected} connected · ${admitted} admitted · ${pending} waiting for approval`
    : "Turn serving on and save to admit machines.";
  const count = tabs.querySelector('[data-relay-tab="machines"] .cluster-tab-count');
  count.textContent = pending ? `${pending} waiting` : admitted ? String(admitted) : "";
  checkButton.disabled = !settings.enabled;
  checkHint.hidden = settings.enabled;
  byId("relayTokenCreate").disabled = !settings.enabled;
}

async function loadSummary() {
  serving = await api("/api/relay/serving");
  fillForm(serving.settings);
  renderSummary();
}

async function saveServing() {
  const maxMachines = Number(field.maxMachines.value);
  const capGb = field.capGb.value.trim() === "" ? 0 : Number(field.capGb.value);
  if (!Number.isInteger(maxMachines) || maxMachines < 1 || maxMachines > 10000) throw new Error("Max machines is a whole number from 1 to 10000");
  if (!Number.isFinite(capGb) || capGb < 0) throw new Error("The monthly allowance is 0 GB or more. 0 means no cap");
  await api("/api/relay/serving", {
    method: "PUT",
    body: JSON.stringify({
      enabled: field.enabled.checked, origin: field.origin.value.trim(), environment: field.environment.value.trim(),
      requestsEnabled: field.requests.checked, ownMachinesOnly: field.ownOnly.checked, maxMachines, monthlyCapGb: capGb, alertTopic: field.alertTopic.value.trim(),
    }),
  });
  checkResults.replaceChildren();
  await refresh();
}

function checkRow(label, result) {
  const row = makeNode("li", "relay-check-row");
  row.dataset.testid = "relay-check-row";
  row.dataset.ok = String(result.ok);
  const mark = makeNode("span", "relay-check-mark", result.ok ? "✓" : "✗");
  mark.setAttribute("aria-hidden", "true");
  row.append(mark, makeNode("span", "sr-only", result.ok ? "Passed: " : "Failed: "), makeNode("strong", "", label));
  if (!result.ok && result.error) row.append(makeNode("span", "relay-check-error", result.error));
  return row;
}

async function runCheck() {
  checkResults.replaceChildren();
  showStatus(servingStatus, "Checking…");
  checkButton.disabled = true;
  try {
    const result = await api("/api/relay/serving/check", { method: "POST" });
    const host = new URL(serving.settings.origin).host;
    checkResults.append(checkRow("Relay address", result.address), checkRow(`Machine names (*.${host})`, result.wildcard));
    showStatus(servingStatus, "");
  } finally {
    checkButton.disabled = !serving?.settings.enabled;
  }
}

// ---- machines ----

const stateLabel = (machine) => (machine.status === "pending" ? "Not admitted" : machine.online ? "Online" : "Offline");

function viaLabel(via) {
  if (!via) return "";
  if (via === "self") return "this machine";
  if (via.startsWith("approved:")) return `approved by ${via.slice("approved:".length)}`;
  return via.startsWith("token:") ? "a token link" : via;
}

function formatCode(code) {
  const digits = String(code || "");
  return digits.length === 6 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
}

async function changeMachine(machine, body, done) {
  showStatus(machinesStatus, "");
  try {
    await api(`/api/relay/serving/machines/${encodeURIComponent(machine.nodeId)}`, { method: "PATCH", body: JSON.stringify(body) });
    await refresh();
    showStatus(machinesStatus, done, "ok");
  } catch (error) { showStatus(machinesStatus, error.message, "error"); }
}

function startRename(row, machine) {
  const title = row.querySelector(".relay-row-title");
  const form = makeNode("div", "relay-rename");
  const input = makeNode("input");
  input.value = machine.name; input.maxLength = 63; input.autocomplete = "off"; input.spellcheck = false;
  input.setAttribute("aria-label", `New name for ${machine.name}`);
  input.dataset.testid = "relay-machine-rename-input";
  const save = makeButton("Save", "relay-machine-rename-save", () => void apply());
  const cancel = makeButton("Cancel", "relay-machine-rename-cancel", () => { void refreshMachines(); });
  async function apply() {
    const name = input.value.trim().toLowerCase();
    if (name === machine.name) { await refreshMachines(); return; }
    await changeMachine(machine, { name }, `Renamed to ${name}`);
  }
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") { event.preventDefault(); void apply(); }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); void refreshMachines(); }
  });
  form.append(input, save, cancel);
  title.replaceChildren(form);
  input.focus(); input.select();
}

function machineActions(row, machine) {
  const actions = makeNode("div", "relay-row-actions");
  if (machine.status === "pending") {
    actions.append(
      makeButton("Approve", "relay-machine-approve", async () => {
        showStatus(machinesStatus, "");
        try {
          const approved = await api(`/api/relay/serving/machines/${encodeURIComponent(machine.nodeId)}/approve`, { method: "POST" });
          await refresh();
          showStatus(machinesStatus, `Approved as ${approved?.name ?? machine.name}.`, "ok");
        } catch (error) { showStatus(machinesStatus, error.message, "error"); }
      }, "primary compact"),
      makeTwoStepButton({
        label: "Decline", armedLabel: "Confirm decline", testid: "relay-machine-decline",
        onConfirm: async () => {
          showStatus(machinesStatus, "");
          try {
            await api(`/api/relay/serving/machines/${encodeURIComponent(machine.nodeId)}/decline`, { method: "POST" });
            await refresh();
            showStatus(machinesStatus, "Request declined.", "ok");
          } catch (error) { showStatus(machinesStatus, error.message, "error"); }
        },
      }),
    );
    return actions;
  }
  actions.append(makeButton("Rename", "relay-machine-rename", () => startRename(row, machine)));
  if (machine.self) return actions;
  actions.append(
    machine.status === "suspended"
      ? makeButton("Resume", "relay-machine-resume", () => void changeMachine(machine, { status: "admitted" }, `${machine.name} resumed.`))
      : makeButton("Suspend", "relay-machine-suspend", () => void changeMachine(machine, { status: "suspended" }, `${machine.name} suspended.`)),
    makeTwoStepButton({
      label: "Remove", armedLabel: "Confirm remove", testid: "relay-machine-remove",
      onConfirm: async () => {
        showStatus(machinesStatus, "");
        try {
          await api(`/api/relay/serving/machines/${encodeURIComponent(machine.nodeId)}`, { method: "DELETE" });
          await refresh();
          showStatus(machinesStatus, `${machine.name} removed. Its key can no longer connect.`, "ok");
        } catch (error) { showStatus(machinesStatus, error.message, "error"); }
      },
    }),
  );
  return actions;
}

function machineRow(machine) {
  const row = makeNode("div", "relay-row");
  row.dataset.testid = "relay-machine-row";
  row.dataset.nodeId = machine.nodeId;
  row.dataset.status = machine.status;
  row.dataset.self = String(machine.self);
  const main = makeNode("div", "relay-row-main");
  const title = makeNode("div", "relay-row-title");
  const dot = makeNode("span", "relay-dot");
  dot.dataset.online = String(machine.online);
  dot.dataset.testid = "relay-machine-online";
  dot.setAttribute("role", "img");
  dot.setAttribute("aria-label", stateLabel(machine));
  const name = makeNode("strong", "relay-row-name", machine.name);
  name.dataset.testid = "relay-machine-name";
  const badges = makeNode("span", "cluster-badges");
  const status = makeBadge(STATUS_LABEL[machine.status] ?? machine.status, machine.status === "admitted" ? "ok" : machine.status === "suspended" ? "error" : "twin");
  status.dataset.testid = "relay-machine-status";
  badges.append(status);
  if (machine.self) badges.append(makeBadge("This machine", "you"));
  title.append(dot, name, badges);
  main.append(title);

  if (machine.status === "pending") {
    const code = makeNode("div", "relay-code", formatCode(machine.pairingCode));
    code.dataset.testid = "relay-machine-code";
    code.setAttribute("aria-label", `Pairing code ${String(machine.pairingCode || "").split("").join(" ")}`);
    main.append(code, makeNode("p", "relay-row-meta", "Approve only if this code matches the one shown on the machine."));
  }

  const facts = [stateLabel(machine)];
  if (machine.status !== "pending") facts.push(`${formatBytes(machine.usageBytes)} this month`);
  facts.push(machine.lastSeenAt ? `last seen ${formatWhen(machine.lastSeenAt)}` : "never seen");
  if (machine.admittedVia) facts.push(`admitted via ${viaLabel(machine.admittedVia)}`);
  facts.push(machine.phoneSignIn ? "phone sign-in on" : "phone sign-in off");
  main.append(makeNode("p", "relay-row-meta", facts.join(" · ")));

  const identity = makeNode("p", "relay-row-meta");
  if (machine.phoneAddress) {
    const address = makeNode("code", "relay-address", machine.phoneAddress);
    address.dataset.testid = "relay-machine-address";
    identity.append("Phone address ", address, " ", makeButton("Copy", "relay-machine-address-copy", () => void copyText(machine.phoneAddress, "Phone address copied")));
  }
  if (machine.fingerprint) {
    const fingerprint = makeNode("code", "relay-address", shortFingerprint(machine.fingerprint));
    fingerprint.title = machine.fingerprint;
    fingerprint.dataset.testid = "relay-machine-fingerprint";
    identity.append(machine.phoneAddress ? " · key " : "Key ", fingerprint);
  }
  if (identity.childNodes.length) main.append(identity);

  row.append(main, machineActions(row, machine));
  return row;
}

const machines = createFittedList({
  list: byId("relayMachinesList"), pager: byId("relayMachinesPager"), testPrefix: "relay-machines",
  emptyText: "No machines here yet. Create a token, or wait for a request.",
  fetchPage: async (page, size) => {
    const body = await api(`/api/relay/serving/machines?status=${machineFilter}&page=${page}&pageSize=${size}`);
    return { total: body.total, items: body.machines };
  },
  renderItem: machineRow,
});

async function refreshMachines() {
  try { await machines.reload(); } catch (error) { showStatus(machinesStatus, `Could not load machines: ${error.message}`, "error"); }
}

// ---- tokens ----

function tokenState(token) {
  if (token.revokedAt) return ["Revoked", "error"];
  if (token.usesLeft <= 0) return ["Used up", ""];
  if (Date.parse(token.expiresAt) <= Date.now()) return ["Expired", ""];
  return ["Active", "ok"];
}

function tokenRow(token) {
  const [stateText, kind] = tokenState(token);
  const row = makeNode("div", "relay-row");
  row.dataset.testid = "relay-token-row";
  row.dataset.tokenId = token.id;
  row.dataset.state = stateText.toLowerCase();
  const main = makeNode("div", "relay-row-main");
  const title = makeNode("div", "relay-row-title");
  const label = makeNode("strong", "relay-row-name", token.label);
  label.dataset.testid = "relay-token-label";
  const state = makeBadge(stateText, kind);
  state.dataset.testid = "relay-token-state";
  title.append(label, state);
  const facts = [`${token.usesLeft} use${token.usesLeft === 1 ? "" : "s"} left`, `${token.usedCount} used`, `expires ${formatWhen(token.expiresAt)}`];
  if (token.suggestedName) facts.push(`suggested name ${token.suggestedName}`);
  main.append(title, makeNode("p", "relay-row-meta", facts.join(" · ")));
  row.append(main);
  if (stateText === "Active") {
    const actions = makeNode("div", "relay-row-actions");
    actions.append(makeTwoStepButton({
      label: "Revoke", armedLabel: "Confirm revoke", testid: "relay-token-revoke",
      onConfirm: async () => {
        showStatus(tokensStatus, "");
        try {
          await api(`/api/relay/serving/tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" });
          await tokens.reload();
          showStatus(tokensStatus, `${token.label} revoked.`, "ok");
        } catch (error) { showStatus(tokensStatus, error.message, "error"); }
      },
    }));
    row.append(actions);
  }
  return row;
}

const tokens = createFittedList({
  list: byId("relayTokensList"), pager: byId("relayTokensPager"), testPrefix: "relay-tokens",
  emptyText: "No tokens yet.",
  fetchPage: async (page, size) => {
    const body = await api("/api/relay/serving/tokens");
    return { total: body.tokens.length, items: body.tokens.slice((page - 1) * size, page * size) };
  },
  renderItem: tokenRow,
});

/** The link is a secret shown once: it lives in this input only, never in storage. */
function clearTokenLink() {
  tokenLink.value = "";
  tokenReveal.hidden = true;
}

async function createToken() {
  const label = byId("relayTokenLabel").value.trim();
  const uses = Number(byId("relayTokenUses").value);
  const ttlHours = Number(byId("relayTokenHours").value);
  const suggestedName = byId("relayTokenName").value.trim().toLowerCase();
  if (!label) throw new Error("Give the token a label, so you can tell it apart later");
  if (!Number.isInteger(uses) || uses < 1 || uses > 1000) throw new Error("Uses is a whole number from 1 to 1000");
  if (!Number.isFinite(ttlHours) || ttlHours < 0.25 || ttlHours > 2160) throw new Error("Expires in is between 0.25 and 2160 hours");
  const created = await api("/api/relay/serving/tokens", {
    method: "POST",
    body: JSON.stringify({ label, uses, ttlHours, ...(suggestedName ? { suggestedName } : {}) }),
  });
  tokenLink.value = created.link;
  tokenReveal.hidden = false;
  byId("relayTokenLabel").value = "";
  byId("relayTokenName").value = "";
  tokenLink.focus(); tokenLink.select();
  await tokens.first();
}

// ---- audit ----

const audit = createFittedList({
  list: byId("relayAuditList"), pager: byId("relayAuditPager"), testPrefix: "relay-audit",
  emptyText: "Nothing has happened on this relay yet.",
  fetchPage: async (page, size) => {
    const body = await api(`/api/relay/serving/audit?page=${page}&pageSize=${size}`);
    return { total: body.total, items: body.entries };
  },
  renderItem: (entry) => {
    const row = makeNode("div", "relay-row relay-row-compact");
    row.dataset.testid = "relay-audit-row";
    row.dataset.action = entry.action;
    const main = makeNode("div", "relay-row-main");
    const head = makeNode("div", "relay-row-title");
    const action = makeBadge(entry.action.replaceAll("-", " "));
    action.dataset.testid = "relay-audit-action";
    head.append(action, makeNode("span", "relay-row-meta", formatWhen(entry.at)));
    const detail = makeNode("p", "relay-row-meta", entry.detail || "");
    detail.dataset.testid = "relay-audit-detail";
    main.append(head);
    if (entry.detail) main.append(detail);
    row.append(main);
    return row;
  },
});

// ---- tabs and loading ----

const sections = {
  joined: { section: byId("relayJoinedSection"), load: loadRelayMemberships },
  serving: { section: byId("relayServingSection"), load: async () => {} },
  machines: { section: byId("relayMachinesSection"), load: refreshMachines },
  tokens: { section: byId("relayTokensSection"), load: async () => { try { await tokens.reload(); } catch (error) { showStatus(tokensStatus, `Could not load tokens: ${error.message}`, "error"); } } },
  audit: { section: byId("relayAuditSection"), load: async () => { try { await audit.reload(); } catch (error) { showStatus(auditStatus, `Could not load the audit log: ${error.message}`, "error"); } } },
};

function showRelayTab(name) {
  activeTab = name;
  for (const tab of tabs.querySelectorAll("[data-relay-tab]")) tab.setAttribute("aria-selected", String(tab.dataset.relayTab === name));
  for (const [key, { section }] of Object.entries(sections)) section.hidden = key !== name;
  // The summary describes this machine as a relay, so it belongs to the serving sections only.
  byId("relaySummary").hidden = name === "joined";
  void sections[name].load();
}

async function refresh() {
  await loadSummary();
  await sections[activeTab].load();
}

/** Called when the Relay tab opens and by its Refresh button. Errors stay on the screen. */
export async function loadRelayServing() {
  showStatus(loadStatus, "Loading…");
  try {
    await refresh();
    showStatus(loadStatus, "");
  } catch (error) { showStatus(loadStatus, `Could not load relay settings: ${error.message}`, "error"); }
}

function act(status, action) {
  return async () => {
    showStatus(status, "");
    try { await action(); } catch (error) { showStatus(status, error.message, "error"); }
  };
}

byId("relayServingSave").addEventListener("click", act(servingStatus, async () => { await saveServing(); showStatus(servingStatus, "Saved.", "ok"); }));
checkButton.addEventListener("click", act(servingStatus, runCheck));
byId("relayTokenCreate").addEventListener("click", act(tokensStatus, createToken));
byId("relayRefreshButton").addEventListener("click", () => void loadRelayServing());
byId("relayFingerprintCopy").addEventListener("click", () => { if (serving?.fingerprint) void copyText(serving.fingerprint, "Relay fingerprint copied"); });
byId("relayTokenCopy").addEventListener("click", () => void copyText(tokenLink.value, "Relay link copied"));
byId("relayTokenDismiss").addEventListener("click", clearTokenLink);
byId("settingsDialog").addEventListener("close", clearTokenLink);

tabs.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-relay-tab]");
  if (tab) showRelayTab(tab.dataset.relayTab);
});
byId("relayMachineFilter").addEventListener("click", (event) => {
  const choice = event.target.closest("[data-machine-filter]");
  if (!choice) return;
  machineFilter = choice.dataset.machineFilter;
  for (const item of byId("relayMachineFilter").querySelectorAll("[data-machine-filter]")) item.setAttribute("aria-pressed", String(item === choice));
  showStatus(machinesStatus, "");
  void machines.first().catch((error) => showStatus(machinesStatus, `Could not load machines: ${error.message}`, "error"));
});

// Enter in a Settings field would submit the whole Settings form, so it acts on this panel instead.
byId("settingsPanel-relay").addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !event.target.matches("input, select")) return;
  event.preventDefault();
  if (event.target.closest("#relayServingSection")) byId("relayServingSave").click();
  else if (event.target.closest("#relayTokenForm")) byId("relayTokenCreate").click();
});
