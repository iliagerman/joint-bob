// Keep the shared card's chrome outside its scrollport. Custom dialogs with
// their own bounded body already hide card overflow and keep their layout.
function prepareDialog(dialog) {
  const cards = dialog.matches(".budget-dialog") ? [dialog] : dialog.querySelectorAll(".dialog-card");
  for (const card of cards) {
    if (card.querySelector(":scope > .dialog-body")) continue;
    if (!card.matches(".budget-dialog, .dialog-scroll-layout") && getComputedStyle(card).overflowY !== "auto") continue;
    const heading = card.firstElementChild;
    if (!heading) continue;
    const children = [...card.children];
    const footer = children.find(child => child.matches(".dialog-actions, .budget-dialog-actions"))
      ?? (card.lastElementChild.matches("button, footer") ? card.lastElementChild : null);
    const body = document.createElement("div");
    body.className = "dialog-body";
    for (const child of children.slice(1)) {
      if (child === footer) break;
      body.append(child);
    }
    card.insertBefore(body, footer);
    if (card === dialog && !card.classList.contains("dialog-scroll-layout")) {
      // Sharing replaces its loading state after the dialog is already open.
      new MutationObserver(() => prepareDialog(dialog)).observe(card, { childList: true });
    }
    card.classList.add("dialog-scroll-layout");
  }
}

// beforetoggle also covers dialogs created by feature modules after startup,
// and runs before showModal() focuses a field or scrolls it into view.
document.addEventListener("beforetoggle", event => {
  if (event.target instanceof HTMLDialogElement && event.newState === "open") {
    prepareDialog(event.target);
  }
}, true);
