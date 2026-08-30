export const LOCAL_COMMANDS = [
  { name: "help", description: "Show available commands", invocation: "/help ", kind: "web" },
  { name: "skills", description: "Browse installed skills", invocation: "/skills ", kind: "web" },
  { name: "model", description: "Choose the session model", invocation: "/model ", kind: "web" },
  { name: "tools", description: "Configure available tools", invocation: "/tools ", kind: "web" },
  { name: "compact", description: "Compact conversation context", invocation: "/compact ", kind: "web" },
];

const COMMAND_ALIASES = new Map([
  ["help", "help"],
  ["skill", "skills"],
  ["skils", "skills"],
  ["skills", "skills"],
  ["model", "model"],
  ["tools", "tools"],
  ["compact", "compact"],
]);

export function executeComposerCommand(message, handlers) {
  const match = /^\/(\S+)(?:\s+(.*))?$/.exec(message.trim());
  if (!match) return false;
  const action = COMMAND_ALIASES.get(match[1].toLowerCase());
  if (!action) return false;
  handlers[action]((match[2] || "").trim());
  return true;
}

export function dispatchComposerInput(message, hasAttachments, handlers, sendPrompt) {
  if (!hasAttachments && executeComposerCommand(message, handlers)) return "command";
  sendPrompt(message);
  return "prompt";
}
