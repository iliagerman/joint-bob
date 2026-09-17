const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const exactMarker = new RegExp(`^\\[Joint Bob internal task completion ${UUID}\\]\\n`, "i");

export function internalTaskPrompt(id: string, text: string): string {
  if (!new RegExp(`^${UUID}$`, "i").test(id)) throw new Error("Internal task completion id must be a UUID");
  return `[Joint Bob internal task completion ${id}]\n${text}`;
}

export function isInternalTaskPrompt(text: string): boolean {
  return exactMarker.test(text);
}

export function visibleTaskMessages<T extends { role: string; text: string }>(messages: T[]): T[] {
  const visible: T[] = [];
  let hidden = false;
  for (const message of messages) {
    if (message.role === "user") hidden = isInternalTaskPrompt(message.text);
    if (!hidden) visible.push(message);
  }
  return visible;
}
