import { request } from "./api.js";
import { app, fail, notify } from "./context.js";
import { h } from "./dom.js";

// Saved items: links, notes and screenshots, private to the owner. Also the share target.

const PAGE_SIZE = 6;
let page = 0;
let sharedImages = [];
let shareDatabase;
const params = () => new URLSearchParams(location.search);

async function pendingShare() {
  shareDatabase = await new Promise((resolve, reject) => {
    const open = indexedDB.open("joint-bob-assistant-shares", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("pending");
    open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error);
  });
  return new Promise((resolve, reject) => {
    const get = shareDatabase.transaction("pending", "readonly").objectStore("pending").get(params().get("share"));
    get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error);
  });
}

async function clearShare() {
  if (!shareDatabase || !params().has("share")) return;
  await new Promise((resolve, reject) => {
    const transaction = shareDatabase.transaction("pending", "readwrite");
    transaction.objectStore("pending").delete(params().get("share"));
    transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error);
  });
  const url = new URL(location.href); url.searchParams.delete("share"); history.replaceState(history.state, "", url);
  sharedImages = [];
}

export const arrivesWithShare = () => ["share", "url", "title", "text"].some(key => params().has(key));

/** Content shared from another app or a bookmarklet fills the capture form. */
export async function prefillShare() {
  const current = params();
  if (current.get("url")) document.querySelector("#url").value = current.get("url");
  if (current.get("title") || current.get("text")) document.querySelector("#title").value = current.get("title") || current.get("text").slice(0, 300);
  if (!current.has("share")) return;
  const shared = await pendingShare();
  if (shared && Date.now() - shared.createdAt < 24 * 60 * 60 * 1000) {
    document.querySelector("#title").value = shared.title.slice(0, 300) || document.querySelector("#title").value;
    document.querySelector("#url").value = shared.url || "";
    document.querySelector("#note").value = shared.text;
    sharedImages = shared.images;
    notify(`${sharedImages.length} shared screenshot(s) ready. Review and save.`);
  } else notify("Shared content expired. Share it again.", true);
}

function confirmDeletion(title) {
  const dialog = document.querySelector("#delete-item-dialog");
  dialog.querySelector("p").textContent = `Delete ${title}? This cannot be undone.`;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener("close", () => resolve(dialog.returnValue === "delete"), { once: true }));
}

function itemCard(entry) {
  const remove = h("button", { type: "button", "data-testid": "assistant-delete-item" }, "Delete item");
  remove.addEventListener("click", async () => {
    remove.disabled = true;
    try {
      if (!await confirmDeletion(entry.title)) return;
      await request(`/api/personal-assistants/${app.assistant.id}/items/${entry.id}`, { method: "DELETE" });
      await showItems();
    } catch (error) { fail(error); }
    finally { remove.disabled = false; }
  });
  return h("article", {},
    h("small", {}, `${entry.collection} · ${new Date(entry.createdAt).toLocaleDateString()}`),
    h("h3", {}, entry.title),
    entry.url ? h("a", { href: entry.url, target: "_blank", rel: "noopener noreferrer" }, entry.url) : h("small", {}, "No source link saved"),
    entry.note ? h("p", {}, entry.note) : null,
    h("div", { class: "images" }, entry.imageNames.map(name => h("img", { loading: "lazy", alt: `Screenshot for ${entry.title}`, src: `/api/personal-assistants/${app.assistant.id}/items/${entry.id}/images/${encodeURIComponent(name)}` }))),
    remove);
}

export async function showItems() {
  const target = document.querySelector("#items");
  const pager = document.querySelector("#items-pager");
  const { items } = await request(`/api/personal-assistants/${app.assistant.id}/items`);
  pager.replaceChildren();
  if (!items.length) { target.replaceChildren(h("p", {}, "Nothing saved yet.")); return; }
  const pages = Math.ceil(items.length / PAGE_SIZE);
  page = Math.min(page, pages - 1);
  target.replaceChildren(...items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(itemCard));
  if (pages > 1) {
    pager.className = "pager";
    pager.append(h("span", {}, `${page * PAGE_SIZE + 1}–${Math.min(items.length, (page + 1) * PAGE_SIZE)} of ${items.length}`),
      h("span", {}, h("button", { type: "button", disabled: page === 0, onclick: () => { page -= 1; showItems().catch(fail); } }, "Previous"),
        h("button", { type: "button", disabled: page >= pages - 1, onclick: () => { page += 1; showItems().catch(fail); } }, "Next")));
  }
}

const fileData = file => new Promise((resolve, reject) => {
  const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1]); reader.onerror = reject; reader.readAsDataURL(file);
});

async function saveItem(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const files = [...sharedImages, ...document.querySelector("#images").files];
  if (files.length > 4 || files.reduce((sum, file) => sum + file.size, 0) > 20 * 1024 * 1024) { notify("Select up to four images, at most 20 MiB total", true); return; }
  button.disabled = true;
  try {
    const images = await Promise.all(files.map(async file => ({ name: file.name, mimeType: file.type, data: await fileData(file) })));
    await request(`/api/personal-assistants/${app.assistant.id}/items`, { method: "POST", body: JSON.stringify({ collection: document.querySelector("#collection").value, title: document.querySelector("#title").value, url: document.querySelector("#url").value || null, note: document.querySelector("#note").value, images }) });
    await clearShare();
    form.reset();
    document.querySelector("#collection").value = "Personal";
    notify("Item saved");
    page = 0;
    await showItems();
  } catch (error) { fail(error); }
  finally { button.disabled = false; }
}

export function bindSaved(refreshTranscript) {
  document.querySelector("#capture").addEventListener("submit", saveItem);
  document.querySelector("#refresh").addEventListener("click", () => Promise.all([showItems(), refreshTranscript()]).catch(fail));
}
