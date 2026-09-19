import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadClaudeMessages } from "../src/claude-service.js";
import { listDiscoveredHarnesses } from "../src/harnesses/registry.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { addProject } from "../src/store.js";

const sessionId = "22222222-2222-4222-8222-222222222222";

/** Emits the stream a real Claude turn produces: prose, a tool, more prose, a failed tool. */
function fixtureLines(): string[] {
  const line = (value: unknown) => `echo ${JSON.stringify(JSON.stringify(value))}`;
  return [
    line({ type: "system", subtype: "init", session_id: sessionId, tools: ["Read", "Bash"] }),
    line({ type: "assistant", message: { role: "assistant", content: [
      { type: "text", text: "Reading the plan." },
      { type: "tool_use", id: "tool-1", name: "Read", input: { path: "plan.md" } },
    ] } }),
    line({ type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "tool-1", content: "plan body" },
    ] } }),
    line({ type: "assistant", message: { role: "assistant", content: [
      { type: "text", text: "The plan is parked." },
      { type: "tool_use", id: "tool-2", name: "Bash", input: { command: "false" } },
    ] } }),
    line({ type: "user", message: { role: "user", content: [
      { type: "tool_result", tool_use_id: "tool-2", content: "exit 1", is_error: true },
    ] } }),
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Done." }] } }),
    line({ type: "result", subtype: "success" }),
  ];
}

test("a Claude turn keeps every spoken block and tool result as its own message", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-transcript-"));
  const previous = getSettings();
  try {
    const executable = path.join(root, "claude-fixture");
    await writeFile(executable, ["#!/bin/sh", "cat >/dev/null", ...fixtureLines(), ""].join("\n"), "utf8");
    await chmod(executable, 0o755);
    updateSettings({
      runtimes: { ...previous.runtimes, claude: { ...previous.runtimes.claude, executable } },
      syncthing: { endpoint: "" },
    });
    const project = await addProject("Claude fixture", root, { writeInstructions: false });
    const adapter = listDiscoveredHarnesses().find(({ id }) => id === "claude")!;
    const runtime = await adapter.runtime!();
    const session = await runtime.open({ projectId: project.id, cwd: root, sessionId });
    try {
      await session.prompt({ text: "check the plan" });
      assert.deepEqual(session.messages.map(({ role, text }) => [role, text]), [
        ["user", "check the plan"],
        ["assistant", "Reading the plan."],
        ["toolResult", "plan body"],
        ["assistant", "The plan is parked."],
        ["toolResult", "exit 1"],
        ["assistant", "Done."],
      ], "each spoken block and tool result stays a separate message");
      assert.deepEqual(session.messages.map(({ toolName }) => toolName), [
        undefined, undefined, "Read", undefined, "Bash", undefined,
      ], "a saved tool bubble keeps the name the live bubble showed");
      assert.deepEqual(session.messages.map(({ isError }) => isError), [
        undefined, undefined, undefined, undefined, true, undefined,
      ], "a failed tool stays marked failed");
    } finally {
      session.dispose();
    }
  } finally {
    updateSettings({ runtimes: previous.runtimes, syncthing: { endpoint: previous.syncthing.endpoint } });
    await rm(root, { recursive: true, force: true });
  }
});

test("a reloaded Claude transcript keeps the tool bubbles between the spoken blocks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-reload-"));
  const previous = getSettings();
  try {
    const sessions = path.join(root, "claude-projects");
    updateSettings({
      runtimes: { ...previous.runtimes, claude: { ...previous.runtimes.claude, sessionPath: sessions } },
      syncthing: { endpoint: "" },
    });
    const transcript = path.join(sessions, "project", "session.jsonl");
    await mkdir(path.dirname(transcript), { recursive: true });
    await writeFile(transcript, [
      JSON.stringify({ type: "user", message: { role: "user", content: "check the plan" } }),
      // Compaction writes its summary as a user record; nobody typed it, so the chat never shows it.
      JSON.stringify({ type: "system", subtype: "compact_boundary", content: "Conversation compacted" }),
      JSON.stringify({ type: "user", isCompactSummary: true, message: { role: "user", content: "This session is being continued from a previous conversation that ran out of context. Summary: …" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [
        { type: "text", text: "Reading the plan." },
        { type: "tool_use", id: "tool-1", name: "Read", input: { path: "plan.md" } },
      ] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "tool-1", content: "plan body" },
      ] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "The plan is parked." }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: [
        { type: "tool_result", tool_use_id: "missing", content: "exit 1", is_error: true },
      ] } }),
    ].join("\n") + "\n");
    const messages = await loadClaudeMessages(`claude:${transcript}`);
    assert.deepEqual(messages.map(({ role, text, toolName }) => ({ role, text, toolName })), [
      { role: "user", text: "check the plan", toolName: undefined },
      { role: "assistant", text: "Reading the plan.", toolName: undefined },
      { role: "toolResult", text: "plan body", toolName: "Read" },
      { role: "assistant", text: "The plan is parked.", toolName: undefined },
      { role: "toolResult", text: "exit 1", toolName: "tool" },
    ], "a reload shows the same pieces the turn streamed");
    assert.deepEqual(messages.map(({ isError }) => isError), [undefined, undefined, undefined, undefined, true]);
    assert.equal(new Set(messages.map(({ id }) => id)).size, messages.length, "every reloaded message keeps its own id");
  } finally {
    updateSettings({ runtimes: previous.runtimes, syncthing: { endpoint: previous.syncthing.endpoint } });
    await rm(root, { recursive: true, force: true });
  }
});
