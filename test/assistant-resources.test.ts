import assert from "node:assert/strict";
import test from "node:test";
import { assistantDisabledResources, assistantIdForConversation, sameAssistantTopics } from "../src/assistant-resources.js";
import { addPersonalAssistantTopic, personalAssistantDatabase, savePersonalAssistant } from "../src/personal-assistants.js";
import { unavailableSkillNames } from "../src/scoped-skills.js";

test("an assistant's disabled skills and plugins apply only to its own topics", async () => {
  const assistant = await savePersonalAssistant("owner", { projectId: "project", engine: "pi", sessionId: "source", name: "Helper", instructions: "" });
  await addPersonalAssistantTopic("owner", assistant.id, { projectId: "project", engine: "claude", sessionId: "topic-2", source: false });
  const other = await savePersonalAssistant("owner", { projectId: "project", engine: "pi", sessionId: "other-source", name: "Other", instructions: "" });
  const db = await personalAssistantDatabase();
  db.prepare("INSERT INTO personal_assistant_resources (assistant_id, disabled_skills, disabled_plugins) VALUES (?,?,?)")
    .run(assistant.id, JSON.stringify(["pdf", "docx"]), JSON.stringify(["figma"]));

  assert.equal(assistantIdForConversation("project", "topic-2"), assistant.id);
  assert.equal(assistantIdForConversation("project", "unrelated"), null, "an ordinary conversation is no assistant's topic");
  assert.deepEqual(assistantDisabledResources("project", "source"), { skills: ["pdf", "docx"], plugins: ["figma"] });
  assert.deepEqual(assistantDisabledResources("project", "topic-2"), { skills: ["pdf", "docx"], plugins: ["figma"] }, "every topic inherits the assistant's choices");
  assert.deepEqual(assistantDisabledResources("project", "other-source"), { skills: [], plugins: [] }, "another assistant keeps its own choices");
  assert.deepEqual(assistantDisabledResources("other-project", "topic-2"), { skills: [], plugins: [] }, "the topic must be in the same project");

  const blocked = unavailableSkillNames({ projectId: "project", conversationId: "topic-2" });
  assert.ok(blocked.includes("pdf") && blocked.includes("docx"), "skill loading treats disabled skills as unavailable");
  assert.equal(unavailableSkillNames({ projectId: "project", conversationId: "topic-2", ignoreAssistantPreferences: true }).includes("pdf"), false,
    "the Resources tab can list every skill to show its switch");
  assert.equal(unavailableSkillNames({ projectId: "project", conversationId: "other-source" }).includes("pdf"), false);

  assert.equal(sameAssistantTopics("project", "source", "topic-2"), true, "topics of one assistant take turns with its logins");
  assert.equal(sameAssistantTopics("project", "source", "other-source"), false);
  assert.equal(sameAssistantTopics("project", "unrelated", "also-unrelated"), false, "ordinary conversations are never siblings");

  db.prepare("DELETE FROM personal_assistants WHERE id=?").run(assistant.id);
  assert.deepEqual(assistantDisabledResources("project", "topic-2"), { skills: [], plugins: [] }, "deleting the assistant removes its choices");
});
