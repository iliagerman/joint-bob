export const TASK_STATUSES = [
  { id: "backlog", label: "Backlog" },
  { id: "planning", label: "Planning" },
  { id: "in_progress", label: "In progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

/** Card icons, in the same stroked 24px style as the nav bar and the row menus. */
const cardIconPaths = {
  chat: ["M21 14.5a2 2 0 0 1-2 2H8.5L4 20.5V5.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z"],
  ticket: [
    "M4 6.5h16a1 1 0 0 1 1 1V10a2 2 0 0 0 0 4v2.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V14a2 2 0 0 0 0-4V7.5a1 1 0 0 1 1-1z",
    "M14.5 6.5v2",
    "M14.5 11v2",
    "M14.5 15.5v2",
  ],
  // Drawn as three small closed circles so the dots stay solid at 17px.
  more: [
    "M12 4.7a1.35 1.35 0 1 0 0 2.7 1.35 1.35 0 1 0 0-2.7z",
    "M12 10.65a1.35 1.35 0 1 0 0 2.7 1.35 1.35 0 1 0 0-2.7z",
    "M12 16.6a1.35 1.35 0 1 0 0 2.7 1.35 1.35 0 1 0 0-2.7z",
  ],
  left: ["M14 7.5 9.5 12l4.5 4.5"],
  right: ["M10 7.5l4.5 4.5-4.5 4.5"],
  play: ["M9.8 6.9 17 12l-7.2 5.1z"],
};

function cardIcon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "task-card-icon");
  for (const d of cardIconPaths[name]) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", "path");
    node.setAttribute("d", d);
    if (name === "more" || name === "play") node.setAttribute("fill", "currentColor");
    svg.append(node);
  }
  return svg;
}

/** The ticket glyph outside the board too, so a conversation row and its card read as one object. */
export function ticketGlyph(className) {
  const svg = cardIcon("ticket");
  svg.setAttribute("class", className);
  return svg;
}

function statusIndex(status) {
  return TASK_STATUSES.findIndex((candidate) => candidate.id === status);
}

function iconButton({ icon, label, testid, className = "", disabled = false, title, onClick }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `ghost icon-button task-action ${className}`.trim();
  button.setAttribute("aria-label", label);
  button.title = title ?? label;
  button.dataset.testid = testid;
  button.disabled = disabled;
  button.append(cardIcon(icon));
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

/**
 * Everything that is not "read the conversation", "edit the ticket", or "move the
 * ticket" lives here, so the card keeps one short row of controls at any width.
 */
function taskMenuItems(task, handlers) {
  const items = [];
  if (!task.worktreeBranch && (task.worktreePath || task.mergeState !== "none")) {
    const conflicts = task.conflictCount ?? 0;
    if (task.mergeState === "conflicts" || task.mergeState === "resolved") {
      items.push({
        label: `Resolve conflicts (${conflicts})`,
        icon: "merge",
        testid: "board-task-merge-conflicts-button",
        disabled: task.executionState === "running",
        title: "Pick sides for binary conflicts and open staged text files",
        onSelect: () => handlers.onMergeConflicts(task),
      });
      items.push({
        label: "Resume merge agent",
        icon: "merge",
        testid: "board-task-merge-resume-button",
        disabled: task.executionState === "running",
        title: "Send the ticket agent to resolve the staged merge conflicts",
        onSelect: () => handlers.onMergeResume(task),
      });
      items.push({
        label: "Restart merge",
        icon: "merge",
        testid: "board-task-merge-restart-button",
        disabled: task.executionState === "running",
        title: "Recompute the merge from scratch, discarding partial resolutions",
        onSelect: () => handlers.onMergeRestart(task),
      });
      items.push({
        label: "Discard ticket changes",
        icon: "trash",
        testid: "board-task-discard-button",
        danger: true,
        title: "Drop the workspace without merging; the project keeps its current state",
        onSelect: () => handlers.onDiscard(task),
      });
    } else if (!task.mergedAt) {
      items.push({
        label: "Merge back to project",
        icon: "merge",
        testid: "board-task-merge-button",
        disabled: task.status !== "done" || task.executionState === "running",
        title: task.status !== "done" ? "Move ticket to Done before merging" : "Merge the ticket workspace back into the project folder",
        onSelect: () => handlers.onMerge(task),
      });
    }
  }
  if (task.worktreeBranch) {
    items.push({
      label: task.mergedAt ? "Merged into main" : "Merge to main",
      icon: "merge",
      testid: "board-task-merge-button",
      disabled: task.status !== "done" || !task.worktreePath || Boolean(task.mergedAt),
      title: task.mergedAt
        ? "Ticket merged into main"
        : task.status !== "done"
          ? "Move ticket to Done before merging"
          : "Merge committed ticket changes into main",
      onSelect: () => handlers.onMerge(task),
    });
  }
  items.push({
    label: "Hand off to another node",
    icon: "transfer",
    testid: "board-task-handoff-button",
    disabled: task.executionState === "running" || task.executionState === "handoff_pending",
    onSelect: () => handlers.onHandoff(task),
  });
  items.push({
    label: "Models and phases",
    icon: "sliders",
    testid: "board-task-models-button",
    onSelect: () => handlers.onSettings(task),
  });
  const fsCopWorkspace = !task.worktreeBranch && Boolean(task.worktreePath || task.mergeState !== "none");
  const archiveBlockedByMerge = fsCopWorkspace && task.status === "done" && task.mergeState !== "merged";
  if (task.status !== "done" || fsCopWorkspace) {
    items.push({
      label: "Archive",
      icon: "archive",
      testid: "board-task-archive-button",
      disabled: task.executionState === "running" || task.executionState === "handoff_pending" || archiveBlockedByMerge,
      title: archiveBlockedByMerge ? "Merge the ticket workspace (or discard it) before archiving" : undefined,
      onSelect: () => handlers.onArchive(task),
    });
  }
  items.push({
    label: "Delete",
    icon: "trash",
    testid: "board-task-delete-button",
    danger: true,
    onSelect: () => handlers.onDelete(task),
  });
  return items;
}

function taskCardActions(task, handlers) {
  const actions = document.createElement("footer");
  actions.className = "task-card-actions";

  const index = statusIndex(task.status);
  const previousStatus = task.status === "in_progress" && !task.planMode ? "backlog" : TASK_STATUSES[index - 1]?.id;
  const nextStatus = task.status === "backlog" && !task.planMode ? "in_progress" : TASK_STATUSES[index + 1]?.id;
  const startsAgent = (task.status === "backlog" && !task.planMode) || task.status === "planning";

  actions.append(iconButton({
    icon: "left",
    label: `Move ${task.title} left`,
    testid: "board-task-move-left-button",
    className: "task-move",
    disabled: !previousStatus,
    onClick: () => handlers.onMove(task, previousStatus),
  }));

  const main = document.createElement("div");
  main.className = "task-card-actions-main";
  if (task.sessionPath) {
    main.append(iconButton({
      icon: "chat",
      label: `Open chat for ${task.title}`,
      testid: "board-task-open-chat-button",
      className: "task-open-chat",
      onClick: () => handlers.onOpenChat(task),
    }));
  }
  main.append(iconButton({
    icon: "ticket",
    label: `Open ticket ${task.title}`,
    testid: "board-task-open-ticket-button",
    onClick: () => handlers.onEdit(task),
  }));
  const menuButton = iconButton({
    icon: "more",
    label: `Actions for ${task.title}`,
    title: "Ticket actions",
    testid: "board-task-menu-button",
    onClick: () => handlers.onMenu(menuButton, taskMenuItems(task, handlers), task),
  });
  menuButton.setAttribute("aria-haspopup", "true");
  main.append(menuButton);
  actions.append(main);

  actions.append(iconButton({
    icon: startsAgent ? "play" : "right",
    label: startsAgent ? `Start ${task.title}` : `Move ${task.title} right`,
    testid: "board-task-move-right-button",
    className: startsAgent ? "task-move task-start" : "task-move",
    disabled: !nextStatus,
    onClick: () => handlers.onMove(task, nextStatus),
  }));

  return actions;
}

function taskCard(task, handlers) {
  const card = document.createElement("article");
  card.className = "task-card";
  card.dataset.testid = "board-task-card";
  card.dataset.taskId = task.id;
  card.draggable = true;
  card.addEventListener("dragstart", (event) => {
    event.dataTransfer.setData("text/plain", task.id);
    event.dataTransfer.effectAllowed = "move";
    card.classList.add("dragging");
  });
  card.addEventListener("dragend", () => card.classList.remove("dragging"));

  const body = document.createElement("button");
  body.type = "button";
  body.className = "task-card-body";
  body.setAttribute("data-testid", "board-task-edit-button");

  const titleRow = document.createElement("div");
  titleRow.className = "task-card-title";
  const title = document.createElement("strong");
  title.textContent = task.title;
  const engine = document.createElement("span");
  engine.className = `task-engine engine-${task.engine || "pi"}`;
  engine.textContent = task.engine === "claude" ? "Claude" : "Pi";
  titleRow.append(title, engine);
  if (task.planMode) {
    const plan = document.createElement("span");
    plan.className = "task-engine task-plan";
    plan.textContent = "Plan";
    titleRow.append(plan);
  }
  body.append(titleRow);

  if (task.description) {
    const description = document.createElement("span");
    description.className = "task-card-description";
    description.textContent = task.description;
    body.append(description);
  }

  const meta = document.createElement("span");
  meta.className = "task-card-meta";
  const node = document.createElement("code");
  node.className = "task-node";
  node.textContent = task.currentNodeId.slice(0, 8);
  meta.append(node);
  if (task.executionState !== "idle") {
    const state = document.createElement("b");
    state.className = `task-state task-state-${task.executionState}`;
    const dot = document.createElement("i");
    dot.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = task.executionState === "running" ? "Running" : task.executionState.replace(/_/g, " ");
    state.append(dot, label);
    meta.append(state);
  }
  if (!task.worktreeBranch && (task.worktreePath || task.mergeState !== "none") && task.status === "done") {
    const merge = document.createElement("b");
    const conflicts = task.conflictCount ?? 0;
    if (task.mergeState === "merged") {
      merge.className = "task-state task-merge-state task-merge-merged";
      merge.dataset.testid = "board-task-merge-chip";
      merge.textContent = "Merged";
    } else if (task.mergeState === "conflicts" || task.mergeState === "resolved") {
      merge.className = "task-state task-merge-state task-merge-conflicts";
      merge.dataset.testid = "board-task-merge-chip";
      merge.textContent = `Merge: ${conflicts} conflict${conflicts === 1 ? "" : "s"}`;
    } else {
      merge.className = "task-state task-merge-state task-merge-pending";
      merge.dataset.testid = "board-task-merge-chip";
      merge.textContent = "Merge pending";
    }
    if (task.mergeWarning) merge.title = task.mergeWarning;
    meta.append(merge);
  }
  body.append(meta);
  body.addEventListener("click", () => handlers.onEdit(task));

  card.append(body, taskCardActions(task, handlers));
  return card;
}

/**
 * Renders the kanban board into `container`.
 * handlers: { onEdit(task), onMove(task, nextStatus), onAdd(statusId), onOpenChat(task),
 *   onMerge(task), onHandoff(task), onArchive(task), onDelete(task), onSettings(task),
 *   onMenu(anchor, items, task) }
 */
export function renderBoard(container, tasks, handlers) {
  container.replaceChildren();
  for (const status of TASK_STATUSES) {
    const column = document.createElement("section");
    column.className = `board-column status-${status.id}`;

    const columnTasks = tasks
      .filter((task) => task.status === status.id && (status.id !== "planning" || task.planMode))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

    const header = document.createElement("header");
    header.className = "board-column-header";
    const label = document.createElement("strong");
    label.textContent = status.label;
    const count = document.createElement("span");
    count.className = "board-count";
    count.textContent = `${columnTasks.length}`;
    const add = document.createElement("button");
    add.type = "button";
    add.className = "ghost icon-button board-add";
    add.textContent = "+";
    add.setAttribute("aria-label", `Add task to ${status.label}`);
    add.setAttribute("data-testid", `board-add-${status.id}-button`);
    add.addEventListener("click", () => handlers.onAdd(status.id));
    header.append(label, count, add);
    column.append(header);

    const list = document.createElement("div");
    list.className = "board-column-list";
    for (const task of columnTasks) list.append(taskCard(task, handlers));
    if (!columnTasks.length) {
      const empty = document.createElement("p");
      empty.className = "muted board-empty";
      empty.textContent = status.id === "backlog" ? "Add a task to queue work" : "No tasks";
      list.append(empty);
    }
    column.append(list);

    // Drag & drop target (desktop); the arrow buttons cover touch devices.
    column.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      column.classList.add("drop-target");
    });
    column.addEventListener("dragleave", () => column.classList.remove("drop-target"));
    column.addEventListener("drop", (event) => {
      event.preventDefault();
      column.classList.remove("drop-target");
      const taskId = event.dataTransfer.getData("text/plain");
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (task && task.status !== status.id) handlers.onMove(task, status.id);
    });

    container.append(column);
  }
}
