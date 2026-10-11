// Remembers each conversation's last transcript shape so a reload that shrinks or
// rewrites messages logs exactly which ones changed. Texts are hashed, never kept.
const previousLoads = new Map();
const MAX_CONVERSATIONS = 20;
const MAX_LISTED = 10;

function hash(text) {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

function shape(message, index) {
  const text = String(message.text || "");
  const digest = hash(text);
  return { index, id: message.id, role: message.role, ...(message.toolName ? { toolName: message.toolName } : {}), length: text.length, hash: digest, key: `${message.role}:${digest}` };
}

const listed = ({ hash: _hash, key: _key, ...entry }) => entry;

// Message ids are positional in some harnesses, so a removal mid-transcript would
// renumber everything after it. Align on role and text instead (LCS edit script).
function align(before, after) {
  const operations = [];
  if (before.length * after.length > 400_000) {
    let start = 0;
    while (start < before.length && start < after.length && before[start].key === after[start].key) start += 1;
    let end = 0;
    while (end < before.length - start && end < after.length - start && before[before.length - 1 - end].key === after[after.length - 1 - end].key) end += 1;
    for (const entry of before.slice(start, before.length - end)) operations.push({ type: "removed", entry });
    for (const entry of after.slice(start, after.length - end)) operations.push({ type: "added", entry });
    return operations;
  }
  const table = Array.from({ length: before.length + 1 }, () => new Uint16Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i][j] = before[i].key === after[j].key ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i].key === after[j].key) { operations.push({ type: "same" }); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) operations.push({ type: "removed", entry: before[i++] });
    else operations.push({ type: "added", entry: after[j++] });
  }
  while (i < before.length) operations.push({ type: "removed", entry: before[i++] });
  while (j < after.length) operations.push({ type: "added", entry: after[j++] });
  return operations;
}

/** Splits an edit script into removals, additions, and in-place rewrites (a removal and addition at the same spot). */
function classify(operations) {
  const removed = [];
  const added = [];
  const changed = [];
  let run = { removed: [], added: [] };
  const flush = () => {
    const paired = Math.min(run.removed.length, run.added.length);
    for (let index = 0; index < paired; index += 1) {
      const was = run.removed[index];
      changed.push({ ...listed(run.added[index]), indexBefore: was.index, roleBefore: was.role, lengthBefore: was.length });
    }
    removed.push(...run.removed.slice(paired).map(listed));
    added.push(...run.added.slice(paired).map(listed));
    run = { removed: [], added: [] };
  };
  for (const operation of operations) {
    if (operation.type === "same") flush();
    else run[operation.type].push(operation.entry);
  }
  flush();
  return { removed, added, changed };
}

/** Logs how this load of a conversation differs from the previous one; the first load only records. */
export function logTranscriptChanges(conversationKey, messages, source) {
  if (!conversationKey) return;
  const current = (messages || []).map(shape);
  const previous = previousLoads.get(conversationKey);
  previousLoads.delete(conversationKey);
  previousLoads.set(conversationKey, current);
  if (previousLoads.size > MAX_CONVERSATIONS) previousLoads.delete(previousLoads.keys().next().value);
  if (!previous) return;
  const { removed, added, changed } = classify(align(previous, current));
  if (!removed.length && !added.length && !changed.length) return;
  console.info("Conversation transcript differs from its previous load", {
    conversation: conversationKey,
    source,
    messagesBefore: previous.length,
    messagesAfter: current.length,
    removed: removed.slice(0, MAX_LISTED),
    added: added.slice(0, MAX_LISTED),
    changed: changed.slice(0, MAX_LISTED),
    ...(removed.length > MAX_LISTED || added.length > MAX_LISTED || changed.length > MAX_LISTED
      ? { totals: { removed: removed.length, added: added.length, changed: changed.length } }
      : {}),
  });
}
