import { api } from "./api.js";
import { confirmAction } from "./shell.js";

let root, data, busy = false, loading = false, shown = false, message = "", context = "", request = 0, target = "", changed = () => {};
function control(text, id, action) {
  const button = document.createElement("button"); button.type = "button"; button.className = "ghost compact";
  button.textContent = text; button.dataset.testid = id; button.disabled = busy;
  button.addEventListener("click", () => void run(action)); return button;
}
async function load() {
  const id = ++request;
  loading = true;
  try { const body = await api("/api/resources/skills/twin-sync"); if (id === request) { data = body; message = ""; } }
  catch (error) { if (id === request) { data = null; message = error.message; } }
  finally { if (id === request) { loading = false; render(); } }
}
async function run(action) {
  if (busy) return;
  const origin = context;
  busy = true; render();
  try { await action(); }
  catch (error) { if (origin === context) { const text = error.message; await load(); if (origin === context) message = text; } }
  finally { busy = false; render(); }
}
function describe(label, names) { return `${label} (${names.length}): ${names.length ? names.slice(0, 30).join(", ") : "none"}${names.length > 30 ? ", …" : ""}`; }
async function initialize() {
  const selected = target, at = context, generation = request;
  const preview = await api("/api/resources/skills/twin-sync/preview", { method: "POST", body: JSON.stringify({ peerNodeId: selected }) });
  if (at !== context || generation !== request) { message = "Node or resource view changed. Generate a new preview."; return; }
  const destination = data.twins.find(t => t.nodeId === selected);
  const p = preview.plan;
  const confirmed = await confirmAction({ title: `Make ${destination?.name || selected} match ${data.localNode.name}?`,
    message: [`Source: ${data.localNode.name} (${preview.sourceNodeId})`, `Destination: ${destination?.name || selected} (${preview.destinationNodeId})`,
      describe("Add", p.add), describe("Replace", p.replace), describe("Remove", p.remove), describe("Protected and excluded", p.protected),
      `Withdraw destination sharing grants: ${p.grantWithdrawals.length ? p.grantWithdrawals.map(s => `${s.name}: ${s.grants.join(", ")}`).join("; ") : "none"}`,
      "Overwritten and removed managed copies are backed up. Relay-imposed skills and independent native copies stay untouched. After initialization, additions, edits and deletions sync automatically in both directions. Activation preferences stay node-local."].join("\n"),
    confirmLabel: "Match and enable two-way sync", destructive: true });
  if (!confirmed) return;
  if (at !== context || generation !== request || selected !== target) { message = "Resource view changed. Generate a new preview."; return; }
  await api("/api/resources/skills/twin-sync/initialize", { method: "POST", body: JSON.stringify({ token: preview.token }) });
  await load(); await changed();
}
function render() {
  if (!root) return;
  root.replaceChildren();
  root.hidden = !shown || !message && !data?.twins?.length && !data?.session;
  if (root.hidden) return;
  const status = document.createElement("p"); status.className = "settings-hint"; status.dataset.testid = "twin-skill-status"; status.setAttribute("role", "status");
  const session = data?.session;
  status.textContent = message || (loading ? "Loading twin skill synchronization…" : session
    ? `${session.paused ? "Skill sync paused" : session.state === "active" ? "Two-way skill sync active" : "Skill sync initialization pending"}. ${data.pending || 0} changes awaiting acknowledgment. Last successful sync: ${session.lastSuccess || "not yet"}.${session.error ? ` ${session.error}` : ""}`
    : `Synchronize managed skills with one direct twin. Initial source: ${data?.localNode?.name || "this node"}.`);
  if (data?.inventoryError) status.textContent += ` Inventory unavailable: ${data.inventoryError}`;
  root.append(status);
  const line = document.createElement("div"); line.className = "resources-share-line";
  if (!data) { line.append(control("Retry sync status", "twin-skill-refresh", load)); root.append(line); return; }
  if (!session) {
    const select = document.createElement("select"); select.dataset.testid = "twin-skill-target"; select.setAttribute("aria-label", "Twin to initialize from this node");
    for (const twin of data.twins) select.append(new Option(twin.name, twin.nodeId));
    if (!data.twins.some(t => t.nodeId === target)) target = data.twins[0]?.nodeId || "";
    select.value = target; select.disabled = busy || loading || Boolean(context.split("/")[0]);
    select.addEventListener("change", () => { target = select.value; render(); });
    const start = control("Preview match to this node…", "twin-skill-initialize", initialize);
    start.disabled ||= !target || loading || Boolean(context.split("/")[0]);
    line.append(select, start);
    if (context.split("/")[0]) { const note = document.createElement("span"); note.textContent = "Select this node as the source before initializing."; line.append(note); }
  } else {
    if (session.state === "initializing" && session.sourceNodeId === data.localNode.id) line.append(control("Cancel pending initialization…", "twin-skill-cancel-initialization", async () => {
      const at = context, generation = request;
      if (!await confirmAction({ title: "Cancel pending initialization?", message: "Keep completed changes and backups. Stop the pending plan so you can generate and confirm a new preview. No files are rolled back or deleted by cancellation.", confirmLabel: "Cancel initialization" })) return;
      if (at !== context || generation !== request) return;
      await api("/api/resources/skills/twin-sync/cancel-initialization", { method: "POST", body: "{}" });
      if (at === context) await load();
    }));
    line.append(control("Refresh sync", "twin-skill-refresh", async () => {
      await api("/api/resources/skills/twin-sync/refresh", { method: "POST", body: "{}" }); await load(); await changed();
    }), control(session.paused ? "Resume sync" : "Pause sync", "twin-skill-pause", async () => {
      await api("/api/resources/skills/twin-sync", { method: "PUT", body: JSON.stringify({ paused: !session.paused }) }); await load();
    }));
  }
  root.append(line);
  if (data.protected?.length) { const note = document.createElement("p"); note.className = "settings-hint"; note.textContent = describe("Protected or excluded from synchronization", data.protected); root.append(note); }
  for (const conflict of data.conflicts || []) {
    const row = document.createElement("div"); row.className = "resources-share-line";
    const label = document.createElement("span"); label.textContent = `Conflict preserved: ${conflict.name}`;
    const resolve = async (digest) => {
      const at = context, generation = request;
      if (!await confirmAction({ title: `Resolve ${conflict.name}?`, message: "Make the selected version a new change and synchronize it to the twin. Preserved copies remain backed up.", confirmLabel: "Resolve conflict" })) return;
      if (at !== context || generation !== request) return;
      await api("/api/resources/skills/twin-sync/resolve", { method: "POST", body: JSON.stringify({ name: conflict.name, digest }) }); await load(); await changed();
    };
    row.append(label, control("Keep active version", "twin-skill-keep-active", () => resolve(conflict.activeDigest)), control("Restore preserved copy", "twin-skill-restore-conflict", () => resolve(conflict.digest))); root.append(row);
  }
}
export function renderTwinSkillSync(panel, key, visible, onChanged) {
  if (!root) {
    root = document.createElement("section"); root.className = "resources-share-bar"; root.dataset.testid = "twin-skill-sync"; root.setAttribute("aria-label", "Twin skill synchronization");
    panel.querySelector(".resources-tabs").before(root);
  }
  if (context !== key) { context = key; ++request; loading = false; data = null; target = ""; message = ""; }
  changed = onChanged;
  shown = visible;
  root.hidden = !visible;
  if (!visible) return;
  if (!data && !loading && !message) void load();
  render();
}
