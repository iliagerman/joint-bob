const params = new URLSearchParams(location.search);
const message = document.querySelector("#message");
const detail = document.querySelector("#detail");
let assistant;
let csrf;
let sharedImages = [];
let shareDatabase;
async function pendingShare() {
  if (!params.has("share")) return null;
  shareDatabase = await new Promise((resolve, reject) => {
    const open = indexedDB.open("joint-bob-assistant-shares", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("pending");
    open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
  });
  return new Promise((resolve, reject) => {
    const transaction = shareDatabase.transaction("pending", "readonly");
    const get = transaction.objectStore("pending").get(params.get("share"));
    get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error);
  });
}
async function clearShare() {
  if (!shareDatabase || !params.has("share")) return;
  await new Promise((resolve, reject) => {
    const transaction = shareDatabase.transaction("pending", "readwrite");
    transaction.objectStore("pending").delete(params.get("share"));
    transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
  });
  const url = new URL(location.href); url.searchParams.delete("share"); history.replaceState({}, "", url);
  sharedImages = [];
}
function notify(text, error = false) { message.textContent = text; message.classList.toggle("danger", error); }
async function request(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options,
    headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}), ...options.headers } });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `Request failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}
const link = () => {
  const target = new URL("/", location.origin);
  target.searchParams.set("projectId", assistant.projectId);
  target.searchParams.set("sessionId", assistant.sessionId);
  if (assistant.nodeId) target.searchParams.set("nodeId", assistant.nodeId);
  return target;
};
function text(parent, tag, value) { const element = document.createElement(tag); element.textContent = value; parent.append(element); return element; }
function confirmItemDeletion(title) {
  const dialog = document.querySelector("#delete-item-dialog");
  dialog.querySelector("p").textContent = `Delete ${title}? This cannot be undone.`;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue === "delete"), { once: true }));
}
async function showItems() {
  const target = document.querySelector("#items"); target.replaceChildren();
  const { items } = await request(`/api/personal-assistants/${assistant.id}/items`);
  if (!items.length) { text(target, "p", "Nothing saved yet."); return; }
  for (const entry of items) {
    const card = document.createElement("article");
    text(card, "small", `${entry.collection} · ${new Date(entry.createdAt).toLocaleDateString()}`);
    text(card, "h3", entry.title);
    if (entry.url) { const anchor = text(card, "a", entry.url); anchor.href = entry.url; anchor.target = "_blank"; anchor.rel = "noopener noreferrer"; }
    else text(card, "small", "No source link saved");
    if (entry.note) text(card, "p", entry.note);
    const images = document.createElement("div"); images.className = "images";
    for (const name of entry.imageNames) {
      const image = document.createElement("img"); image.loading = "lazy"; image.alt = `Screenshot for ${entry.title}`;
      image.src = `/api/personal-assistants/${assistant.id}/items/${entry.id}/images/${encodeURIComponent(name)}`; images.append(image);
    }
    card.append(images);
    const remove = text(card, "button", "Delete item"); remove.type = "button"; remove.dataset.testid = "assistant-delete-item";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        if (!await confirmItemDeletion(entry.title)) return;
        await request(`/api/personal-assistants/${assistant.id}/items/${entry.id}`, { method: "DELETE" });
        await showItems();
      } catch (error) { notify(error.message, true); }
      finally { remove.disabled = false; }
    });
    target.append(card);
  }
}
async function showMcp() {
  const target = document.querySelector("#mcp-options"); target.replaceChildren();
  const response = await request(`/api/resources/inventory?${new URLSearchParams({ projectId: assistant.projectId, conversationId: assistant.sessionId })}`);
  const servers = [...new Map((response.nodes[0]?.inventory?.mcpServers ?? []).map(server => [server.name, server])).values()];
  if (!servers.length) { text(target, "p", "No MCP servers installed for this project or node. Add one in Joint Bob Resources first."); return; }
  for (const server of servers) {
    const label = document.createElement("label");
    const box = document.createElement("input"); box.type = "checkbox"; box.value = server.name; box.checked = assistant.mcpServerNames === null || assistant.mcpServerNames.includes(server.name); box.style.width = "auto"; box.style.marginRight = "8px";
    label.append(box, document.createTextNode(`${server.name} · ${server.source}`)); target.append(label);
  }
}
async function showSecrets() {
  const target = document.querySelector("#secret-options"); target.replaceChildren();
  const save = document.querySelector("#secrets button"); save.disabled = true;
  const scope = encodeURIComponent(`${assistant.engine}:${assistant.sessionId}`);
  try {
    const [{ accounts }, { accountIds }] = await Promise.all([
      request("/api/secrets"), request(`/api/secrets/scopes/conversation/${scope}`),
    ]);
    if (!accounts.length) text(target, "p", "Create a secret account in Settings → Secrets first.");
    for (const account of accounts) {
      const label = document.createElement("label");
      const box = document.createElement("input"); box.type = "checkbox"; box.value = account.id; box.checked = accountIds.includes(account.id);
      box.style.width = "auto"; box.style.marginRight = "8px";
      label.append(box, document.createTextNode(account.label)); target.append(label);
    }
    save.disabled = false;
  } catch (error) { text(target, "p", `Secret management unavailable: ${error.message}`); }
}
async function open(entry) {
  assistant = entry; document.querySelector("#heading").textContent = entry.name;
  detail.classList.remove("hidden"); document.querySelector("#chooser").classList.add("hidden");
  document.querySelector("#name").value = entry.name;
  document.querySelector("#instructions").value = entry.instructions;
  document.querySelector("#allow-browser").checked = entry.allowBrowser;
  document.querySelector("#allow-terminal").checked = entry.allowTerminal;
  document.querySelector("#chat").href = link();
  document.querySelector("#resources").href = link();
  if (params.get("url")) document.querySelector("#url").value = params.get("url");
  if (params.get("title") || params.get("text")) document.querySelector("#title").value = params.get("title") || params.get("text").slice(0, 300);
  if (params.has("share")) {
    const shared = await pendingShare();
    if (shared && Date.now() - shared.createdAt < 24 * 60 * 60 * 1000) {
      document.querySelector("#title").value = shared.title.slice(0, 300) || document.querySelector("#title").value;
      document.querySelector("#url").value = shared.url || "";
      document.querySelector("#note").value = shared.text;
      sharedImages = shared.images;
      notify(`${sharedImages.length} shared screenshot(s) ready. Review and save.`);
    } else notify("Shared content expired. Share it again.", true);
  }
  await Promise.all([showItems(), showSecrets(), showMcp()]);
}
document.querySelector("#secrets").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const accountIds = [...document.querySelectorAll("#secret-options input:checked")].map(box => box.value);
    await request(`/api/secrets/scopes/conversation/${encodeURIComponent(`${assistant.engine}:${assistant.sessionId}`)}`, { method: "PUT", body: JSON.stringify({ accountIds }) });
    notify("Secret accounts saved. Changes take effect on the next turn.");
  } catch (error) { notify(error.message, true); }
});
const fileData = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = reject; reader.readAsDataURL(file);
});
document.querySelector("#settings").addEventListener("submit", async event => {
  event.preventDefault();
  try {
    const { assistant: updated } = await request(`/api/personal-assistants/${assistant.id}`, { method: "PUT", body: JSON.stringify({ projectId: assistant.projectId, engine: assistant.engine, sessionId: assistant.sessionId, name: document.querySelector("#name").value, instructions: document.querySelector("#instructions").value, allowBrowser: document.querySelector("#allow-browser").checked, allowTerminal: document.querySelector("#allow-terminal").checked }) });
    assistant = updated; document.querySelector("#heading").textContent = updated.name; notify("Instructions saved");
  } catch (error) { notify(error.message, true); }
});
document.querySelector("#capture").addEventListener("submit", async event => {
  event.preventDefault(); const form = event.currentTarget; const button = form.querySelector("button[type=submit], button.primary");
  const files = [...sharedImages, ...document.querySelector("#images").files];
  if (files.length > 4 || files.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) { notify("Select up to four images, at most 20 MiB total", true); return; }
  button.disabled = true;
  try {
    const images = await Promise.all(files.map(async file => ({ name: file.name, mimeType: file.type, data: await fileData(file) })));
    await request(`/api/personal-assistants/${assistant.id}/items`, { method: "POST", body: JSON.stringify({ collection: document.querySelector("#collection").value, title: document.querySelector("#title").value, url: document.querySelector("#url").value || null, note: document.querySelector("#note").value, images }) });
    await clearShare();
    form.reset(); document.querySelector("#collection").value = "Shopping"; notify("Item saved"); await showItems();
  } catch (error) { notify(error.message, true); } finally { button.disabled = false; }
});
document.querySelector("#save-mcp").addEventListener("click", async () => {
  try {
    const { assistant: updated } = await request(`/api/personal-assistants/${assistant.id}`, { method: "PUT", body: JSON.stringify({ projectId: assistant.projectId, engine: assistant.engine, sessionId: assistant.sessionId, name: document.querySelector("#name").value, instructions: document.querySelector("#instructions").value, allowBrowser: document.querySelector("#allow-browser").checked, allowTerminal: document.querySelector("#allow-terminal").checked, mcpServerNames: [...document.querySelectorAll("#mcp-options input:checked")].map(box => box.value) }) });
    assistant = updated; await showMcp(); notify("MCP access saved. Changes take effect on the next turn.");
  } catch (error) { notify(error.message, true); }
});
document.querySelector("#refresh").addEventListener("click", () => showItems().catch(error => notify(error.message, true)));
document.querySelector("#copy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(location.origin + `/assistant.html?id=${encodeURIComponent(assistant.id)}`); notify("Assistant link copied"); }
  catch (error) { notify(error.message, true); }
});
try {
  const status = await (await fetch("/api/auth/status", { credentials: "same-origin" })).json();
  if (!status.authenticated) {
    notify("Sign in to Joint Bob, then reopen this link.", true);
    const anchor = text(document.querySelector("#chooser"), "a", "Sign in"); anchor.href = "/";
  } else {
    csrf = status.csrfToken;
    const { assistants } = await request("/api/personal-assistants");
    const selected = assistants.find(entry => entry.id === params.get("id"));
    if (selected) await open(selected);
    else {
      const target = document.querySelector("#assistants");
      if (!assistants.length) text(target, "p", "No assistant yet. Open a conversation, then choose Personal assistant in its More menu.");
      for (const entry of assistants) {
        const button = text(target, "button", entry.name); button.type = "button";
        button.addEventListener("click", () => { const url = new URL(location.href); url.searchParams.set("id", entry.id); history.replaceState({}, "", url); open(entry).catch(error => notify(error.message, true)); });
      }
      if (params.has("id")) notify("Assistant not found or unavailable on this machine", true);
    }
  }
} catch (error) { notify(error.message, true); }
