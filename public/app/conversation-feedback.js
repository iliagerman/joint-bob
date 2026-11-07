/** Ask only when closing out. Cancelling leaves the conversation unchanged. */
export function chooseConversationFeedback(session) {
  const dialog = document.createElement("dialog");
  dialog.dataset.testid = "conversation-feedback-dialog";
  const form = document.createElement("form");
  form.className = "dialog-card confirm-card";
  const heading = document.createElement("h2");
  heading.textContent = "Mark conversation done";
  const title = document.createElement("p");
  title.textContent = session.title;
  const choices = document.createElement("fieldset");
  const legend = document.createElement("legend");
  legend.textContent = "Anything worth learning?";
  choices.append(legend);
  for (const [rating, text] of [["good", "👍 Good"], ["bad", "👎 Bad"], ["unimportant", "Nothing — not important"]]) {
    const label = document.createElement("label");
    label.className = "checkbox-row";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "feedback-rating";
    input.value = rating;
    input.checked = rating === "unimportant";
    input.dataset.testid = `conversation-feedback-${rating}`;
    label.append(input, document.createTextNode(` ${text}`));
    choices.append(label);
  }
  const detail = document.createElement("label");
  const prompt = document.createElement("span");
  const description = document.createElement("textarea");
  description.rows = 3;
  description.maxLength = 1000;
  description.dataset.testid = "conversation-feedback-description";
  description.placeholder = "Optional, in one or two sentences";
  detail.append(prompt, description);
  const hint = document.createElement("p");
  const rating = () => form.querySelector("input:checked").value;
  const sync = () => {
    detail.hidden = rating() === "unimportant";
    prompt.textContent = rating() === "bad" ? "What went badly?" : "What went well?";
    hint.textContent = rating() === "unimportant"
      ? "Mark done without learning anything from this conversation."
      : "Leave blank and the agent will describe the outcome. The decision model reviews lessons to propose in Project knowledge.";
  };
  choices.addEventListener("change", sync);
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => dialog.close());
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.className = "primary";
  submit.textContent = "Mark done";
  submit.dataset.testid = "conversation-feedback-submit";
  actions.append(cancel, submit);
  form.append(heading, title, choices, detail, hint, actions);
  dialog.append(form);
  document.body.append(dialog);
  sync();
  return new Promise((resolve) => {
    let result = null;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      result = { rating: rating(), description: rating() === "unimportant" ? "" : description.value.trim() };
      dialog.close();
    });
    dialog.addEventListener("close", () => { dialog.remove(); resolve(result); }, { once: true });
    dialog.showModal();
  });
}
