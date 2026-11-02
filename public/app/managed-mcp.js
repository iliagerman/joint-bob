import { api } from "./api.js";
import { confirmAction, toast } from "./shell.js";

let expanded = false, busy = false, flow = null;
let statuses = new Map();
const draft = { name: "", url: "", json: "", callback: "" };
const base = "/api/resources/mcp/managed";
function button(text, id, action) {
  const control = document.createElement("button"); control.type = "button"; control.className = "ghost compact";
  control.textContent = text; control.dataset.testid = id; control.disabled = busy;
  control.addEventListener("click", action); return control;
}
async function perform(action, changed) {
  busy = true;
  try { await action(); }
  catch (error) { toast(error.message); }
  finally { busy = false; await changed(); }
}
function input(label, key, placeholder, multiline = false) {
  const field = document.createElement("label"); field.textContent = label;
  const control = document.createElement(multiline ? "textarea" : "input");
  control.dataset.testid = `managed-mcp-${key}`; control.value = draft[key]; control.placeholder = placeholder;
  control.autocomplete = "off"; control.spellcheck = false;
  if (multiline) control.rows = 3;
  control.addEventListener("input", () => { draft[key] = control.value; }); field.append(control); return field;
}
export function managedMcpSetup(changed) {
  const section = document.createElement("section"); section.className = "resources-add"; section.dataset.testid = "managed-mcp-setup";
  const actions = document.createElement("div"); actions.className = "resources-share-line";
  actions.append(button(expanded ? "Hide MCP setup" : "Add MCP servers", "managed-mcp-add", () => { expanded = !expanded; void changed(); }),
    button("Check shared connections", "managed-mcp-check", () => void perform(async () => {
      const result = await api(`${base}/auth`); statuses = new Map(result.servers.map(server => [server.name, server]));
    }, changed)));
  section.append(actions);
  if (expanded) {
    const hint = document.createElement("p"); hint.textContent = "Add once for Claude, Pi and Kiro. Client included with Joint Bob. Servers and sign-ins belong to you on this machine only. Start a new conversation after installation.";
    const form = document.createElement("form"); form.dataset.testid = "managed-mcp-form";
    form.append(hint, input("Server name", "name", "figma"), input("Remote MCP URL", "url", "https://mcp.figma.com/mcp"),
      input("Or import multiple servers as MCP JSON. Stdio commands run as your account.", "json", '{"mcpServers":{"figma":{"url":"https://mcp.figma.com/mcp"},"local":{"command":"node","args":["/path/server.mjs"]}}}', true));
    const install = button("Install for all three agents", "managed-mcp-install", () => {}); install.type = "submit";
    form.append(install); form.addEventListener("submit", event => {
      event.preventDefault();
      void perform(async () => {
        const config = draft.json.trim() ? JSON.parse(draft.json) : { mcpServers: { [draft.name.trim()]: { url: draft.url.trim() } } };
        if (!await confirmAction({ title: "Install MCP servers?", message: "MCP tools can access external services. Local commands run with your account's permissions. Install only servers you trust.", confirmLabel: "Install servers" })) return;
        const result = await api(base, { method: "POST", body: JSON.stringify(config) });
        draft.name = ""; draft.url = ""; draft.json = ""; expanded = false; toast(`Installed ${result.installed.join(", ")}`);
      }, changed);
    }); section.append(form);
  }
  if (flow) {
    const note = document.createElement("p"); note.textContent = `Signing in to ${flow.serverName}. Finish in the new tab, then choose Done. If the localhost page cannot load, paste its full address below.`;
    section.append(note, input("Redirect address, if needed", "callback", "http://127.0.0.1:…/callback?code=…"),
      button("Done", "managed-mcp-done", () => void perform(async () => {
        const result = await api(`${base}/auth/finish`, { method: "POST", body: JSON.stringify({ flowId: flow.flowId, ...(draft.callback.trim() ? { callbackUrl: draft.callback.trim() } : {}) }) });
        statuses.set(result.server.name, result.server);
        if (result.server.status === "connected") { flow = null; draft.callback = ""; toast("Signed in for Claude, Pi and Kiro on this machine"); }
        else toast("Sign-in is not finished yet");
      }, changed)),
      button("Open sign-in page", "managed-mcp-reopen", () => { const tab = window.open(flow.authUrl, "_blank"); if (tab) tab.opener = null; }),
      button("Cancel", "managed-mcp-cancel", () => void perform(async () => { await api(`${base}/auth/cancel`, { method: "POST", body: JSON.stringify({ flowId: flow.flowId }) }); flow = null; draft.callback = ""; }, changed)));
  }
  return section;
}
export function managedMcpControls(server, changed) {
  const controls = [];
  const state = statuses.get(server.name);
  if (state) { const text = document.createElement("span"); text.textContent = state.status === "needs-auth" ? "Sign in required" : state.status; text.title = state.error ?? ""; text.dataset.testid = "managed-mcp-status"; controls.push(text); }
  if (server.transport !== "stdio") controls.push(button("Sign in", "managed-mcp-sign-in", () => {
    if (flow) { toast("Finish or cancel the open MCP sign-in first"); return; }
    const tab = window.open("about:blank", "_blank");
    void perform(async () => {
      try {
        const result = await api(`${base}/auth/start`, { method: "POST", body: JSON.stringify({ serverName: server.name }) });
        if (!result.authUrl) { tab?.close(); statuses.set(server.name, { status: "connected" }); return; }
        flow = result;
        if (tab) { tab.opener = null; tab.location.href = result.authUrl; }
      } catch (error) { tab?.close(); throw error; }
    }, changed);
  }), button("Sign out", "managed-mcp-sign-out", () => void perform(async () => {
    await api(`${base}/auth/sign-out`, { method: "POST", body: JSON.stringify({ serverName: server.name }) }); statuses.delete(server.name);
  }, changed)));
  controls.push(button("Remove", "managed-mcp-remove", () => void perform(async () => {
    if (!await confirmAction({ title: `Remove ${server.name}?`, message: "Remove this MCP server and its saved sign-in for your account on this machine from all three agents.", confirmLabel: "Remove", destructive: true })) return;
    await api(`${base}/${encodeURIComponent(server.name)}`, { method: "DELETE" }); statuses.delete(server.name);
    if (flow?.serverName === server.name) flow = null;
  }, changed)));
  return controls;
}
