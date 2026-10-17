import assert from "node:assert/strict";
import test from "node:test";
import { filterPersonalAssistantTools } from "../src/personal-assistants.js";

test("personal assistant tool policy removes browser, terminal and unselected MCP tools", () => {
  const tools = ["read", "browser", "Bash", "mcp__weather__search", "mcp__calendar__list"];
  assert.deepEqual(filterPersonalAssistantTools(tools, { allowBrowser: false, allowTerminal: false, mcpServerNames: ["calendar"] }), ["read", "mcp__calendar__list"]);
  assert.deepEqual(filterPersonalAssistantTools(tools, { allowBrowser: true, allowTerminal: true, mcpServerNames: null }), tools);
});
