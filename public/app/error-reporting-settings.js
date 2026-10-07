// Settings → Notifications → Send errors to ntfy. Saved on its own button, node-local.
import { api } from "./api.js";
import { toast } from "./shell.js";

const field = (id) => document.getElementById(id);
const enabledInput = field("errorReportingEnabled");
const options = field("errorReportingOptions");
const channels = {
  client: { enabled: field("errorReportingClientEnabled"), destination: field("errorReportingClientDestination"), service: field("errorReportingClientService"), topic: field("errorReportingClientTopic") },
  backend: { enabled: field("errorReportingBackendEnabled"), destination: field("errorReportingBackendDestination"), service: field("errorReportingBackendService"), topic: field("errorReportingBackendTopic") },
};
const sameRow = field("errorReportingSameRow");
const sameInput = field("errorReportingSameDestination");
const saveButton = field("errorReportingSaveButton");

let services = [];
let saved = null;

function syncVisibility() {
  options.hidden = !enabledInput.checked;
  const client = channels.client.enabled.checked;
  const backend = channels.backend.enabled.checked;
  channels.client.destination.hidden = !client;
  sameRow.hidden = !(client && backend);
  channels.backend.destination.hidden = !backend || (client && sameInput.checked);
}

function renderServices(select, preferredId) {
  const choices = services.map((service) => new Option(`${service.name} — ${service.url}`, service.id));
  if (preferredId && !services.some((service) => service.id === preferredId)) choices.unshift(new Option("Removed server; choose another", preferredId));
  if (!choices.length) choices.push(new Option("Add an ntfy service above first", ""));
  select.replaceChildren(...choices);
  select.value = preferredId || services.find((service) => service.isDefault)?.id || services[0]?.id || "";
}

function render() {
  for (const [name, channel] of Object.entries(channels)) renderServices(channel.service, channel.service.value || saved?.[name].serviceId);
}

function fill(settings) {
  saved = settings;
  enabledInput.checked = settings.enabled;
  sameInput.checked = settings.sameDestination;
  for (const [name, channel] of Object.entries(channels)) {
    channel.enabled.checked = settings[name].enabled;
    channel.topic.value = settings[name].topic;
    renderServices(channel.service, settings[name].serviceId);
  }
  syncVisibility();
}

/** Keeps the server pickers in step with the ntfy services list above. */
export function syncErrorReportingServices(list) {
  services = list;
  render();
}

export async function loadErrorReportingSettings() {
  try { fill(await api("/api/error-reporting")); } catch (error) { toast(error.message, 8000); }
}

for (const input of [enabledInput, sameInput, channels.client.enabled, channels.backend.enabled]) input.addEventListener("change", syncVisibility);

saveButton.addEventListener("click", async () => {
  const destination = (channel) => ({ enabled: channel.enabled.checked, serviceId: channel.service.value || null, topic: channel.topic.value.trim() });
  saveButton.disabled = true;
  try {
    fill(await api("/api/error-reporting", {
      method: "PUT",
      body: JSON.stringify({ enabled: enabledInput.checked, sameDestination: sameInput.checked, client: destination(channels.client), backend: destination(channels.backend) }),
    }));
    toast(enabledInput.checked ? "Errors will be sent to ntfy" : "Error reporting is off");
  } catch (error) {
    toast(error.message, 8000);
  } finally {
    saveButton.disabled = false;
  }
});
