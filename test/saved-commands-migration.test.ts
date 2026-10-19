import assert from "node:assert/strict";
import test from "node:test";
import { getSettings, personalSettings, seedPersonalSettings, DEFAULT_CONVERSATION_COMMANDS } from "../src/settings.js";
import { save, settingsDatabase } from "../src/settings-store.js";

test("legacy node and personal presets migrate persistently without losing duplicate names or prompts", () => {
  const db = settingsDatabase();
  const legacy = { ...DEFAULT_CONVERSATION_COMMANDS, presets: [{ name: "Same", prompt: "One" }, { name: "Same", prompt: "Two" }] };
  save(db, "conversationCommands", JSON.stringify(legacy));
  const first = getSettings().conversationCommands;
  assert.deepEqual(first.presets.map(({ name, prompt }) => ({ name, prompt })), legacy.presets);
  assert.ok(first.presets.every((p) => p.id));
  assert.notEqual(first.presets[0].id, first.presets[1].id);
  assert.deepEqual(getSettings().conversationCommands, first);
  const persisted = JSON.parse((db.prepare("SELECT value FROM node_settings WHERE key='conversationCommands'").get() as { value: string }).value);
  assert.deepEqual(persisted.presets, first.presets, "IDs are stored, not synthesized per read");
  seedPersonalSettings("member");
  db.prepare("UPDATE account_settings SET payload=? WHERE account_id=?").run(JSON.stringify({ conversationCommands: legacy }), "member");
  const account = { accountId: "member", username: "member", role: "member" as const, homeNodeId: null, isRemoteLogin: false };
  const personal = personalSettings(account).conversationCommands;
  assert.deepEqual(personal.presets.map(({ name, prompt }) => ({ name, prompt })), legacy.presets);
  assert.deepEqual(personalSettings(account).conversationCommands, personal);
  assert.notEqual(personal.presets[0].id, first.presets[0].id);
  const stored = JSON.parse((db.prepare("SELECT payload FROM account_settings WHERE account_id='member'").get() as { payload: string }).payload);
  assert.deepEqual(stored.conversationCommands.presets, personal.presets);
});
