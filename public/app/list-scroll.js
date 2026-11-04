/**
 * Emptying a scroll box resets it to the top, and a running agent rebuilds these
 * lists about once a second, so the list you were reading kept jumping back up.
 * The position is restored after the rebuild rather than at each early return,
 * and before the row menu is re-placed against rows that have not moved yet.
 *
 * Safari moves the position while a list is rebuilt, and one click can rebuild a list
 * several times before the restore runs: selecting a project redraws the projects, then
 * the conversations, which redraw the projects again. Only the first reading is kept
 * until it is restored, so a later rebuild cannot save the position Safari moved to.
 */
const pendingRestores = new Map();

export function keepListScroll(container) {
  if (pendingRestores.has(container)) return;
  const top = container.scrollTop;
  if (!top) return;
  pendingRestores.set(container, top);
  queueMicrotask(() => {
    pendingRestores.delete(container);
    container.scrollTop = top;
  });
}
