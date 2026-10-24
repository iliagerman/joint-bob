import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildCreatorInstructions } from "../src/dashboards/creator-prompt.js";

const catalog = JSON.parse(await readFile(new URL("../public/dashboard-kit/catalog.json", import.meta.url), "utf8")) as { components: Array<{ name: string }> };

const input = {
  level: "project" as const,
  context: "Project Contigos at /work/contigos. Secret variables available: PROD_DB_URL.",
  draftDirectory: "/data/dashboards/1/draft",
  stateDirectory: "/data/dashboards/1/state",
  workingDirectory: "/work/contigos",
};

test("the creator instructions teach the kit, the refresh contract and the style rules", () => {
  const text = buildCreatorInstructions(input);
  for (const component of catalog.components) assert.match(text, new RegExp(`\\b${component.name}\\b`), `names the ${component.name} component`);
  assert.match(text, /no outside URLs/i);
  assert.match(text, /manifest\.json/);
  assert.match(text, /index\.html/);
  assert.match(text, /generatedAt/);
  assert.match(text, /JOINT_BOB_DASHBOARD_STATE/);
  assert.match(text, /prefer a script/i);
});

test("the creator instructions carry the level context and where to work", () => {
  const text = buildCreatorInstructions(input);
  assert.match(text, /project dashboard/i);
  assert.ok(text.includes(input.context));
  assert.ok(text.includes(input.draftDirectory), "names the draft folder to edit");
  assert.ok(text.includes(`JOINT_BOB_DASHBOARD_DIR=${input.draftDirectory}`), "shows how to test the refresh like the runner does");
  assert.ok(text.includes(input.workingDirectory));
  assert.match(buildCreatorInstructions({ ...input, level: "workspace" }), /workspace dashboard/i);
  assert.match(buildCreatorInstructions({ ...input, level: "conversation" }), /conversation dashboard/i);
});
