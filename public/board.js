export const TASK_STATUSES = [
  { id: "backlog", label: "Backlog" },
  { id: "planning", label: "Planning" },
  { id: "in_progress", label: "In progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

function statusIndex(status) {
  return TASK_STATUSES.findIndex((candidate) => candidate.id === status);
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
  if (task.planMode) {
    const plan = document.createElement("span");
    plan.className = "task-engine task-plan";
    plan.textContent = "Plan";
    titleRow.append(title, engine, plan);
  } else {
    titleRow.append(title, engine);
  }
  body.append(titleRow);
  const ownership = document.createElement("span");
  ownership.className = "task-node";
  ownership.textContent = `${task.currentNodeId.slice(0, 8)}${task.executionState === "running" ? " · Running" : task.executionState !== "idle" ? ` · ${task.executionState}` : ""}`;
  body.append(ownership);
  if (task.description) {
    const description = document.createElement("span");
    description.className = "task-card-description";
    description.textContent = task.description;
    body.append(description);
  }
  body.addEventListener("click", () => handlers.onEdit(task));

  const actions = document.createElement("div");
  actions.className = "task-card-actions";
  if (task.sessionPath) {
    const openChat = document.createElement("button");
    openChat.type = "button";
    openChat.className = "ghost compact task-open-chat";
    openChat.textContent = "Open chat";
    openChat.setAttribute("data-testid", "board-task-open-chat-button");
    openChat.addEventListener("click", () => handlers.onOpenChat(task));
    actions.append(openChat);
  }
  if (task.worktreeBranch) {
    const merge = document.createElement("button");
    merge.type = "button";
    merge.className = "ghost compact task-merge";
    merge.textContent = task.mergedAt ? "Merged" : "Merge to main";
    merge.setAttribute("data-testid", "board-task-merge-button");
    merge.disabled = task.status !== "done" || !task.worktreePath || Boolean(task.mergedAt);
    merge.title = task.mergedAt
      ? "Ticket merged into main"
      : task.status !== "done"
        ? "Move ticket to Done before merging"
        : "Merge committed ticket changes into main";
    merge.addEventListener("click", () => handlers.onMerge(task));
    actions.append(merge);
  }

  const handoff = document.createElement("button");
  handoff.type = "button";
  handoff.className = "ghost compact task-handoff";
  handoff.textContent = "Handoff";
  handoff.disabled = task.executionState === "running" || task.executionState === "handoff_pending";
  handoff.addEventListener("click", () => handlers.onHandoff(task));
  actions.append(handoff);

  const settings = document.createElement("button");
  settings.type = "button";
  settings.className = "ghost compact task-models";
  settings.textContent = "Models";
  settings.setAttribute("data-testid", "board-task-models-button");
  settings.addEventListener("click", () => handlers.onSettings(task));
  actions.append(settings);
  if (task.status !== "done") {
    const archive = document.createElement("button");
    archive.type = "button";
    archive.className = "ghost compact task-archive";
    archive.textContent = "Archive";
    archive.setAttribute("data-testid", "board-task-archive-button");
    archive.disabled = task.executionState === "running" || task.executionState === "handoff_pending";
    archive.addEventListener("click", () => handlers.onArchive(task));
    actions.append(archive);
  }
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "ghost compact danger task-delete";
  remove.textContent = "Delete";
  remove.setAttribute("data-testid", "board-task-delete-button");
  remove.addEventListener("click", () => handlers.onDelete(task));
  actions.append(remove);
  const index = statusIndex(task.status);
  const previousStatus = task.status === "in_progress" && !task.planMode ? "backlog" : TASK_STATUSES[index - 1]?.id;
  const nextStatus = task.status === "backlog" && !task.planMode ? "in_progress" : TASK_STATUSES[index + 1]?.id;
  const moveLeft = document.createElement("button");
  moveLeft.type = "button";
  moveLeft.className = "ghost icon-button task-move";
  moveLeft.textContent = "‹";
  moveLeft.setAttribute("aria-label", `Move ${task.title} left`);
  moveLeft.setAttribute("data-testid", "board-task-move-left-button");
  moveLeft.disabled = !previousStatus;
  moveLeft.addEventListener("click", () => handlers.onMove(task, previousStatus));
  const moveRight = document.createElement("button");
  moveRight.type = "button";
  moveRight.className = "ghost icon-button task-move";
  const startsAgent = (task.status === "backlog" && !task.planMode) || task.status === "planning";
  moveRight.textContent = startsAgent ? "▶" : "›";
  moveRight.title = startsAgent ? "Start the agent on this task" : "Move right";
  moveRight.setAttribute("aria-label", startsAgent ? `Start ${task.title}` : `Move ${task.title} right`);
  moveRight.setAttribute("data-testid", "board-task-move-right-button");
  moveRight.disabled = !nextStatus;
  moveRight.addEventListener("click", () => handlers.onMove(task, nextStatus));
  actions.append(moveLeft, moveRight);

  card.append(body, actions);
  return card;
}

/**
 * Renders the kanban board into `container`.
 * handlers: { onEdit(task), onMove(task, nextStatus), onAdd(statusId), onOpenChat(task), onMerge(task), onHandoff(task), onArchive(task), onDelete(task), onSettings(task) }
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
