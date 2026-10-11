import { createSearchableSelect } from "./searchable-select.js";
import { shared, state } from "./state.js";

let dialog;
let picker;
let message;
let modeInputs;
let submit;

function workspaceLabel(project) {
  const id = project.type || "personal";
  return shared.workspaces.find((workspace) => workspace.id === id)?.label ?? id;
}

function modeRow(value, text, testid, checked) {
  const row = document.createElement("label");
  row.className = "checkbox-row";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = "sessionTransferMode";
  input.value = value;
  input.checked = checked;
  input.dataset.testid = testid;
  row.append(input, document.createTextNode(` ${text}`));
  return row;
}

function build() {
  dialog = document.createElement("dialog");
  dialog.dataset.testid = "session-transfer-dialog";
  const form = document.createElement("form");
  form.method = "dialog";
  form.className = "dialog-card confirm-card";

  const heading = document.createElement("div");
  heading.className = "dialog-heading";
  heading.tabIndex = -1;
  const eyebrow = document.createElement("span");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Conversation";
  const title = document.createElement("h2");
  title.textContent = "Move or copy to another project";
  message = document.createElement("p");
  heading.append(eyebrow, title, message);

  picker = createSearchableSelect({ id: "sessionTransferProject", testid: "session-transfer-project-select", label: "Destination project", prompt: "Choose a project", placeholder: "Search projects", emptyText: "No projects found" });
  modeInputs = [
    modeRow("move", "Move — remove it from this project", "session-transfer-move", true),
    modeRow("copy", "Copy — keep the original here", "session-transfer-copy", false),
  ];

  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const cancel = document.createElement("button");
  cancel.className = "ghost";
  cancel.type = "button";
  cancel.dataset.testid = "session-transfer-cancel";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => dialog.close("cancel"));
  submit = document.createElement("button");
  submit.className = "primary";
  submit.type = "submit";
  submit.value = "confirm";
  submit.dataset.testid = "session-transfer-submit";
  actions.append(cancel, submit);

  form.append(heading, picker.root, ...modeInputs.map((row) => row), actions);
  dialog.append(form);
  document.body.append(dialog);

  const sync = () => {
    const mode = selectedMode();
    submit.textContent = mode === "move" ? "Move" : "Copy";
    submit.disabled = !picker.value;
  };
  picker.onChange(sync);
  for (const input of form.querySelectorAll("input[name='sessionTransferMode']")) input.addEventListener("change", sync);
  dialog.sync = sync;
}

function selectedMode() {
  return dialog.querySelector("input[name='sessionTransferMode']:checked").value;
}

/** Resolves to `{ projectId, mode }`, or null when cancelled. */
export function chooseTransferDestination(session, sourceProjectId) {
  if (!dialog) build();
  message.textContent = `"${session.title}" gets a new conversation id in the destination; its history, title, label and settings come along.`;
  picker.setOptions(state.projects
    .filter((project) => project.id !== sourceProjectId)
    .map((project) => ({ value: project.id, label: project.name, detail: workspaceLabel(project), keywords: workspaceLabel(project) })));
  picker.setValue("");
  dialog.querySelector("input[value='move']").checked = true;
  dialog.sync();
  if (dialog.open) dialog.close("cancel");
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "confirm" && picker.value ? { projectId: picker.value, mode: selectedMode() } : null);
    }, { once: true });
  });
}
