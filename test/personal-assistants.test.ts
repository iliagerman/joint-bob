import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureConversationRecord } from "../src/conversation-records.js";
import { addPersonalAssistantTopic, beginPersonalAssistantTurn, deleteItem, deletePersonalAssistant, filterPersonalAssistantTools, finishPersonalAssistantTurn, getPersonalAssistant, getPersonalAssistantSourceHistory, listPersonalAssistantTopics, listPersonalAssistantTurnSourceIds, listPersonalAssistantTurns, listPersonalAssistants, listSavedItems, personalAssistantContext, personalAssistantSettings, personalAssistantToolBaseline, saveItem, savedImage, savePersonalAssistant, savePersonalAssistantSourceHistory } from "../src/personal-assistants.js";

test("personal assistant stores instructions and paired source images, scoped to its owner", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-assistant-"));
  const previous = process.env.JOINT_BOB_DATA_DIR;
  process.env.JOINT_BOB_DATA_DIR = root;
  try {
    const legacy = new DatabaseSync(path.join(root, "node.db"));
    legacy.exec(`CREATE TABLE personal_assistants (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, project_id TEXT NOT NULL, engine TEXT NOT NULL, session_id TEXT NOT NULL,
      node_id TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '', classifier_id TEXT NOT NULL DEFAULT 'typesafe',
      allow_browser INTEGER NOT NULL DEFAULT 1, allow_terminal INTEGER NOT NULL DEFAULT 1, mcp_server_names TEXT,
      baseline_tools TEXT, source_history TEXT, created_at TEXT NOT NULL, UNIQUE(account_id,project_id,engine,session_id));`);
    legacy.prepare("INSERT INTO personal_assistants (id,account_id,project_id,engine,session_id,node_id,name,instructions,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("legacy", "legacy-owner", "legacy-project", "pi", "legacy-session", "legacy-node", "Legacy assistant", "Keep helping", "2026-01-01T00:00:00.000Z");
    legacy.close();
    assert.equal((await listPersonalAssistants("legacy-owner"))[0].executionSettings, null, "existing rows migrate without changing their saved settings");
    const profile = await savePersonalAssistant("owner", { projectId: "project", engine: "pi", sessionId: "session", name: "Phones", instructions: "Compare prices" });
    assert.equal(profile.classifierId, "typesafe");
    assert.equal(profile.executionSettings, null, "existing assistants start without a separate execution preference");
    assert.equal(await getPersonalAssistantSourceHistory("owner", profile.id), null);
    const originalHistory = [{ id: "before", role: "user" as const, text: "Original question" }];
    await savePersonalAssistantSourceHistory("owner", profile.id, originalHistory);
    await savePersonalAssistantSourceHistory("owner", profile.id, []);
    assert.deepEqual(await getPersonalAssistantSourceHistory("owner", profile.id), originalHistory);
    assert.deepEqual(await listPersonalAssistantTopics("owner", profile.id), [{ projectId: "project", engine: "pi", sessionId: "session", source: true }]);
    const executionSettings = { harnessId: "claude", provider: "anthropic", modelId: "sonnet", reasoning: "high" };
    const updated = await savePersonalAssistant("owner", { projectId: "project", engine: "pi", sessionId: "session", name: "Phones", instructions: "Compare prices", allowBrowser: false, allowTerminal: false, mcpServerNames: ["calendar"], executionSettings }, profile.id);
    assert.deepEqual(updated.executionSettings, executionSettings);
    assert.equal(updated.engine, "pi", "runtime preferences do not replace the source conversation harness");
    assert.equal(updated.sessionId, "session", "runtime preferences do not replace the source conversation");
    await assert.rejects(savePersonalAssistant("owner", { projectId: "project", engine: "claude", sessionId: "other-session", name: "Phones", instructions: "Compare prices", executionSettings }, profile.id), /Assistant not found/);
    assert.deepEqual(await personalAssistantToolBaseline("owner", profile.id, "pi", "session", ["browser", "shell"]), ["browser", "shell"]);
    assert.deepEqual(await personalAssistantToolBaseline("owner", profile.id, "pi", "session", ["changed"]), ["browser", "shell"]);
    await addPersonalAssistantTopic("owner", profile.id, { projectId: "project", engine: "claude", sessionId: "other-session", source: false });
    assert.deepEqual(await personalAssistantToolBaseline("owner", profile.id, "claude", "other-session", ["mcp__calendar__list"]), ["mcp__calendar__list"]);
    await ensureConversationRecord("project", "pi", "session", "test-node", undefined, { conversationId: "assistant-logical", segmentIndex: 0 });
    await ensureConversationRecord("project", "claude", "claude-session", "test-node", undefined, { conversationId: "assistant-logical", segmentIndex: 1 });
    const switchedSettings = await personalAssistantSettings("owner", "project", "claude", "claude-session");
    assert.equal(switchedSettings?.id, profile.id, "assistant settings follow the original logical topic after a harness switch");
    assert.deepEqual(switchedSettings?.mcpServerNames, ["calendar"], "MCP access remains structured across a harness switch");
    const switchedTools = await personalAssistantToolBaseline("owner", profile.id, "claude", "claude-session", ["browser", "shell", "mcp__calendar__list", "mcp__drive__read"]);
    assert.deepEqual(filterPersonalAssistantTools(switchedTools, switchedSettings!), ["mcp__calendar__list"], "new segment uses current assistant tool restrictions");
    assert.ok((await listPersonalAssistantTopics("owner", profile.id))?.some(topic => topic.engine === "claude" && topic.sessionId === "claude-session" && !topic.source));
    const started = await beginPersonalAssistantTurn("owner", profile.id, "request-a", "pi:session", "Compare phones", "chat");
    assert.equal(started.turn.status, "running");
    assert.equal((await beginPersonalAssistantTurn("owner", profile.id, "request-a", "pi:session", "Compare phones", "chat")).created, false);
    await assert.rejects(beginPersonalAssistantTurn("owner", profile.id, "request-a", "pi:session", "Different message", "chat"), /already used/);
    assert.equal(await finishPersonalAssistantTurn("owner", profile.id, "request-a", "Phone A wins", false, { userId: "source-user", responseId: "source-answer" }), true);
    assert.deepEqual(await listPersonalAssistantTurnSourceIds("owner", profile.id), ["source-user", "source-answer"]);
    assert.deepEqual(await listPersonalAssistantTurns("owner", profile.id), [{ ...started.turn, response: "Phone A wins", status: "completed" }]);
    assert.equal(await listPersonalAssistantTurns("other", profile.id), undefined);
    assert.equal((await getPersonalAssistant("other", profile.id)), undefined);
    const picture = Buffer.from("fake-screenshot");
    const entry = await saveItem("owner", profile.id, { collection: "Phones", title: "Phone offer", url: "https://example.test/listing", note: "Used", images: [{ name: "screen.png", mimeType: "image/png", data: picture.toString("base64") }] });
    assert.ok(entry);
    assert.equal(entry.url, "https://example.test/listing");
    assert.deepEqual((await savedImage("owner", profile.id, entry.id, "0.png"))?.bytes, picture);
    assert.equal(await savedImage("other", profile.id, entry.id, "0.png"), undefined);
    assert.match(await personalAssistantContext("owner", "project", "pi", "session"), /https:\/\/example.test\/listing/);
    assert.equal(await personalAssistantContext("other", "project", "pi", "session"), "");
    assert.equal(await deleteItem("other", profile.id, entry.id), false);
    assert.equal((await listSavedItems("owner", profile.id))?.length, 1);
    assert.equal(await deletePersonalAssistant("owner", profile.id), true);
    assert.equal(await savedImage("owner", profile.id, entry.id, "0.png"), undefined);
  } finally {
    if (previous === undefined) delete process.env.JOINT_BOB_DATA_DIR;
    else process.env.JOINT_BOB_DATA_DIR = previous;
    await rm(root, { recursive: true, force: true });
  }
});
