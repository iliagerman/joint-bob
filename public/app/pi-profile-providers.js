import { api } from "./api.js";
import { createSearchableSelect } from "./searchable-select.js";
import { confirmAction, toast } from "./shell.js";

function element(tag, testid, text) {
  const node = document.createElement(tag);
  if (testid) node.dataset.testid = testid;
  if (text) node.textContent = text;
  return node;
}
function button(text, testid, work) {
  const node = element("button", testid, text); node.type = "button"; node.className = "ghost profile-action";
  node.addEventListener("click", async () => {
    node.disabled = true;
    try { await work(); } catch (error) { toast.error(error.message); } finally { node.disabled = false; }
  });
  return node;
}

/**
 * Credential inputs stay in the existing write-only login prompt, never in status. The prompt sits
 * under the provider list, outside the fold so a sign-in in progress shows even when it is closed.
 */
export function createPiProfileProviderEditor(profile, loginBox, showLogin, changed) {
  const details = element("details", "pi-profile-providers");
  details.append(element("summary", "pi-profile-providers-toggle", "Manage providers"));
  const content = element("div", "pi-profile-provider-content"); details.append(content);
  const root = element("div"); root.className = "pi-profile-editor"; root.append(details, loginBox);
  const signingIn = () => Boolean(loginBox.querySelector('[data-testid="provider-profile-login-cancel"]'));
  let page = 0, providers = [], selected = "";
  async function refresh() {
    const body = await api(`/api/provider-profiles/${profile.id}/providers`);
    providers = body.providers;
    render();
  }
  function render() {
    const configured = providers.filter((provider) => provider.configured);
    page = Math.min(page, Math.max(0, Math.ceil(configured.length / 4) - 1));
    const list = element("div"); list.className = "pi-profile-provider-list";
    for (const provider of configured.slice(page * 4, page * 4 + 4)) {
      const row = element("div", "pi-profile-connected-provider"); row.className = "profile-actions";
      row.append(element("strong", null, provider.name), button("Disconnect", "pi-profile-provider-disconnect", async () => {
        if (!await confirmAction({ title: `Disconnect ${provider.name}?`, message: `Removes this provider from ${profile.label} on this node only. Other providers and profiles stay configured.`, destructive: true, confirmLabel: "Disconnect" })) return;
        await api(`/api/provider-profiles/${profile.id}/providers/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
        await refresh(); await changed();
      }));
      list.append(row);
    }
    if (!configured.length) list.append(element("p", null, "No providers configured on this node."));
    if (configured.length > 4) {
      const previous = button("Previous", "pi-profile-providers-prev", () => { page--; render(); }); previous.disabled = page === 0;
      const next = button("Next", "pi-profile-providers-next", () => { page++; render(); }); next.disabled = (page + 1) * 4 >= configured.length;
      list.append(previous, element("span", null, `Page ${page + 1} of ${Math.ceil(configured.length / 4)}`), next);
    }
    const picker = createSearchableSelect({ id: `piProfileProvider${profile.id}`, testid: "pi-profile-provider-picker", label: "Pi provider", prompt: "Choose a provider", placeholder: "Search providers", emptyText: "No providers found" });
    picker.setOptions(providers.filter((provider) => provider.methods.length).map((provider) => ({ value: provider.id, label: provider.name, detail: `${provider.id}${provider.configured ? " · configured" : ""}` })));
    picker.setValue(selected);
    const method = element("select", "pi-profile-provider-method"); method.setAttribute("aria-label", "Authentication method");
    const connect = button("Connect provider", "pi-profile-provider-connect", async () => {
      const { login } = await api(`/api/provider-profiles/${profile.id}/providers/${encodeURIComponent(selected)}/login`, { method: "POST", body: JSON.stringify({ methodId: method.value }) });
      showLogin(login, async () => { await refresh(); await changed(); });
      // One way forward at a time: the prompt's Continue, not a second Connect.
      form.hidden = signingIn();
    });
    function updateMethods() {
      method.replaceChildren(...(providers.find((provider) => provider.id === selected)?.methods ?? []).map((item) => new Option(item.label, item.id)));
      connect.disabled = !method.options.length;
    }
    picker.onChange((value) => { selected = value; updateMethods(); }); updateMethods();
    const form = element("div"); form.className = "profile-actions"; form.append(picker.root, method, connect);
    form.hidden = signingIn();
    content.replaceChildren(list, form);
  }
  details.addEventListener("toggle", () => { if (details.open) void refresh().catch((error) => toast.error(error.message)); });
  return { root, refresh };
}
