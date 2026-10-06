import { api } from "./api.js";
import { state } from "./state.js";

const list = document.querySelector("#nodeBlockList");
const select = document.querySelector("#nodeBlockSelect");
const button = document.querySelector("#nodeBlockButton");
const status = document.querySelector("#nodeBlockStatus");

export function isNodeAdmin() {
  return state.role === "admin";
}

/** Admin features don't exist for anyone else: their entries are removed from view, not greyed out. */
export function applyAdminVisibility() {
  const admin = isNodeAdmin();
  for (const element of document.querySelectorAll("[data-admin-only]")) {
    element.hidden = !admin;
    if (element instanceof HTMLOptionElement) element.disabled = !admin;
  }
}

function blockRow(block) {
  const item = document.createElement("li");
  item.className = "node-block-row";
  item.dataset.testid = "node-block-row";
  const name = document.createElement("span");
  name.textContent = block.nodeName;
  const unblock = document.createElement("button");
  unblock.type = "button";
  unblock.className = "ghost compact";
  unblock.textContent = "Unblock";
  unblock.dataset.testid = "node-unblock-button";
  unblock.addEventListener("click", () => void changeBlock(block.nodeId, false));
  item.append(name, unblock);
  return item;
}

export async function loadNodeBlocks() {
  if (!isNodeAdmin()) return;
  status.textContent = "";
  const { blocks, candidates } = await api("/api/node-blocks");
  list.replaceChildren(...blocks.map(blockRow));
  if (!blocks.length) {
    const empty = document.createElement("li");
    empty.className = "settings-hint";
    empty.textContent = "No node is blocked.";
    list.append(empty);
  }
  select.replaceChildren(...candidates.map((node) => {
    const option = document.createElement("option");
    option.value = node.nodeId;
    option.textContent = node.name;
    return option;
  }));
  select.disabled = button.disabled = candidates.length === 0;
  if (!candidates.length) status.textContent = "No other node to block. Nodes appear here once they share a cluster with this one.";
}

async function changeBlock(nodeId, blocked) {
  button.disabled = true;
  try {
    await api(`/api/node-blocks/${encodeURIComponent(nodeId)}`, { method: "PUT", body: JSON.stringify({ blocked }) });
    await loadNodeBlocks();
    status.textContent = blocked ? "Blocked. Its users are signed out here." : "Unblocked. Sign-ins return within a minute.";
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
}

button?.addEventListener("click", () => { if (select.value) void changeBlock(select.value, true); });
