function diffCell(className, text) {
  const cell = document.createElement("span");
  cell.className = `git-diff-cell ${className}`;
  cell.textContent = text;
  return cell;
}

function diffRow(left, right) {
  const row = document.createElement("div");
  row.className = "git-diff-row";
  row.dataset.testid = "git-diff-row";
  const leftKind = left ? (left.kind === "del" ? " is-del" : "") : " is-empty";
  const rightKind = right ? (right.kind === "add" ? " is-add" : "") : " is-empty";
  row.append(
    diffCell(`is-number${leftKind}`, left ? String(left.number) : ""),
    diffCell(`is-code${leftKind}`, left?.text ?? ""),
    diffCell(`is-number${rightKind}`, right ? String(right.number) : ""),
    diffCell(`is-code${rightKind}`, right?.text ?? ""),
  );
  return row;
}

function diffNote(className, text) {
  const note = document.createElement("div");
  note.className = `git-diff-note ${className}`;
  note.textContent = text;
  return note;
}

// Unified patch → side-by-side rows. Removed and added runs pair up line by line;
// the longer run leaves blank cells on the other side.
export function renderSideBySideDiff(container, diff) {
  container.textContent = "";
  if (diff.binary) { container.append(diffNote("is-meta", "Binary file — no textual diff.")); return; }
  if (!diff.patch) { container.append(diffNote("is-meta", "No changes.")); return; }
  let oldLine = 0;
  let newLine = 0;
  let removed = [];
  let added = [];
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index += 1) container.append(diffRow(removed[index], added[index]));
    removed = [];
    added = [];
  };
  for (const line of diff.patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      flush();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      container.append(diffNote("is-hunk", line));
    } else if (!oldLine && !newLine) {
      if (line) container.append(diffNote("is-meta", line));
    } else if (line.startsWith("-")) removed.push({ kind: "del", number: oldLine++, text: line.slice(1) });
    else if (line.startsWith("+")) added.push({ kind: "add", number: newLine++, text: line.slice(1) });
    else if (!line || line.startsWith("\\")) continue;
    else {
      flush();
      if (line.startsWith("diff --git")) { oldLine = 0; newLine = 0; container.append(diffNote("is-meta", line)); continue; }
      const text = line.slice(1);
      container.append(diffRow({ kind: "context", number: oldLine++, text }, { kind: "context", number: newLine++, text }));
    }
  }
  flush();
  if (diff.truncated) container.append(diffNote("is-hunk", "… diff truncated"));
}

let diffDialog;

function ensureDiffDialog() {
  if (diffDialog) return diffDialog;
  diffDialog = document.querySelector("#gitDiffDialog");
  diffDialog.querySelector("#gitDiffCloseButton").addEventListener("click", () => diffDialog.close());
  return diffDialog;
}

/**
 * Opens a side-by-side diff over the Git view. Each section is one source of the change,
 * such as a commit or the pending working tree, shown in the order it happened.
 */
export function openDiffDialog({ title, meta = "", sections }) {
  const dialog = ensureDiffDialog();
  dialog.querySelector("#gitDiffTitle").textContent = title;
  dialog.querySelector("#gitDiffMeta").textContent = meta;
  const body = dialog.querySelector("#gitDiffBody");
  body.replaceChildren();
  if (!sections.length) {
    body.append(diffNote("is-meta", "This story holds no diff for this file."));
  }
  for (const section of sections) {
    const heading = document.createElement("p");
    heading.className = "git-diff-section-title";
    heading.textContent = section.label;
    const grid = document.createElement("div");
    grid.className = "git-review-diff git-diff-section";
    grid.dataset.testid = "git-diff-section";
    renderSideBySideDiff(grid, { patch: section.patch, binary: false, truncated: false });
    body.append(heading, grid);
  }
  if (!dialog.open) dialog.showModal();
  body.scrollTop = 0;
}
