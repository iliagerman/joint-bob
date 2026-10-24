import { api } from "./api.js";
import { isNodeAdmin } from "./node-admin.js";

function node(tag, text, testid) {
  const item = document.createElement(tag);
  if (text !== undefined) item.textContent = text;
  if (testid) item.dataset.testid = testid;
  return item;
}

function button(text, testid, action) {
  const item = node("button", text, testid);
  item.type = "button";
  item.className = "ghost";
  item.addEventListener("click", action);
  return item;
}

function field(label, tag, testid, value, maxLength) {
  const wrapper = node("label", label);
  const input = node(tag, undefined, testid);
  input.value = value;
  input.required = true;
  input.maxLength = maxLength;
  wrapper.append(input);
  return { wrapper, input };
}

/** Captured IDs keep a draft attached to its source even if the underlying conversation changes. */
export async function openActivitySkillDraft({ projectId, conversationId, suggestion }) {
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/skill-draft`;
  const dialog = node("dialog", undefined, "activity-skill-draft");
  dialog.className = "activity-skill-draft";
  const card = node("form");
  card.className = "dialog-card";
  const heading = node("h2", "Generate skill");
  heading.id = "activitySkillDraftHeading";
  dialog.setAttribute("aria-labelledby", heading.id);
  const status = node("p", "Loading conversation context…", "skill-draft-status");
  status.setAttribute("role", "status");
  const preview = node("section");
  preview.append(node("h3", suggestion.skill), node("p", suggestion.reason),
    node("p", "1. Review the source. 2. Generate a draft. 3. Edit it. 4. Choose a destination and save. Nothing is saved until you click Save skill."));
  const source = node("details");
  const context = node("pre", "", "skill-draft-context");
  source.append(node("summary", "Conversation context sent to the generator"), context);
  source.open = true;
  preview.append(source);
  const editor = node("section");
  editor.hidden = true;
  const name = field("Name", "input", "skill-draft-name", "", 60);
  name.input.pattern = "[a-z][a-z0-9\\-]{1,59}";
  const description = field("Description — when to use this skill", "textarea", "skill-draft-description", "", 1000);
  const instructions = field("Instructions", "textarea", "skill-draft-instructions", "", 20000);
  instructions.input.minLength = 20;
  instructions.input.rows = 12;
  editor.append(node("h3", "Review and edit your draft"), name.wrapper, description.wrapper, instructions.wrapper);
  const destination = node("section");
  destination.hidden = true;
  const scope = node("select", undefined, "skill-draft-scope");
  scope.append(new Option("This project (.agents/skills)", "project"));
  if (isNodeAdmin()) scope.append(new Option("This machine (managed skills)", "machine"));
  const scopeLabel = node("label", "Save to");
  scopeLabel.append(scope);
  destination.append(scopeLabel, node("p", "Project skills follow the project's existing file-sync/access rules. Machine skills are available to other projects on this machine and may sync with trusted twins. This does not create new sharing grants. Existing skills are never overwritten."));
  const actions = node("div");
  actions.className = "dialog-actions";
  const cancel = button("Cancel", "skill-draft-cancel", () => dialog.close());
  const start = button("Generate draft", "skill-draft-start", () => void generate());
  start.disabled = true;
  const regenerate = button("Regenerate", "skill-draft-regenerate", () => void generate());
  regenerate.hidden = true;
  const save = node("button", "Save skill", "skill-draft-save");
  save.type = "submit";
  save.hidden = true;
  actions.append(cancel, start, regenerate, save);
  card.append(heading, preview, editor, destination, status, actions);
  dialog.append(card);
  document.body.append(dialog);
  const controller = new AbortController();
  let saving = false;
  dialog.addEventListener("cancel", (event) => { if (saving) event.preventDefault(); });
  dialog.addEventListener("close", () => { controller.abort(); dialog.remove(); }, { once: true });
  dialog.showModal();

  function busy(value) {
    for (const input of [name.input, description.input, instructions.input, scope, start, regenerate, save]) input.disabled = value;
  }

  async function generate() {
    busy(true);
    save.hidden = true;
    status.textContent = "Generating draft from the suggestion and conversation… Nothing is saved.";
    try {
      const draft = await api(endpoint, { method: "POST", signal: controller.signal,
        body: JSON.stringify({ name: suggestion.skill, reason: suggestion.reason, context: context.textContent }) });
      name.input.value = draft.name;
      description.input.value = draft.description;
      instructions.input.value = draft.instructions;
      editor.hidden = false;
      destination.hidden = false;
      source.open = false;
      start.hidden = true;
      regenerate.hidden = false;
      save.hidden = false;
      status.textContent = "Draft ready. Review or change every field before saving. Nothing is saved yet.";
      name.input.focus();
    } catch (error) {
      if (!controller.signal.aborted) status.textContent = `Generation failed: ${error.message}. Nothing was saved.`;
      save.hidden = editor.hidden;
    } finally { busy(false); }
  }

  card.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!card.reportValidity()) return;
    saving = true;
    cancel.disabled = true;
    busy(true);
    status.textContent = "Saving your reviewed skill…";
    try {
      const result = await api(`${endpoint}/save`, { method: "POST", signal: controller.signal, body: JSON.stringify({
        approved: true, scope: scope.value, name: name.input.value, description: description.input.value, instructions: instructions.input.value,
      }) });
      status.textContent = `Saved: ${result.path}. Start a new conversation to use the skill.`;
      save.hidden = true;
      regenerate.hidden = true;
      cancel.textContent = "Close";
    } catch (error) {
      if (!controller.signal.aborted) status.textContent = `Could not save skill: ${error.message}`;
      busy(false);
    } finally {
      saving = false;
      cancel.disabled = false;
    }
  });

  try {
    const result = await api(endpoint, { signal: controller.signal });
    context.textContent = result.context;
    start.disabled = !result.context.trim();
    status.textContent = result.context.trim() ? "Review the source above, then generate a draft. Nothing is saved." : "This conversation has no text to generate a skill from.";
  } catch (error) {
    if (!controller.signal.aborted) status.textContent = `Could not load context: ${error.message}. Close and try again.`;
  }
}
