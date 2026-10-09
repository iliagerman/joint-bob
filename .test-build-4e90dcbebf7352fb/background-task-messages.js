const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const exactMarker = new RegExp(`^\\[Joint Bob internal task completion ${UUID}\\]\\n`, "i");
function internalTaskPrompt(id, text) {
  if (!new RegExp(`^${UUID}$`, "i").test(id)) throw new Error("Internal task completion id must be a UUID");
  return `[Joint Bob internal task completion ${id}]
${text}`;
}
function isInternalTaskPrompt(text) {
  return exactMarker.test(text);
}
function visibleTaskMessages(messages) {
  const visible = [];
  let hidden = false;
  for (const message of messages) {
    if (message.role === "user") hidden = isInternalTaskPrompt(message.text);
    if (!hidden) visible.push(message);
  }
  return visible;
}
export {
  internalTaskPrompt,
  isInternalTaskPrompt,
  visibleTaskMessages
};
