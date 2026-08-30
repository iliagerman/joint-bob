import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { orderSessionFamilies } from "../src/harnesses.js";
import type { SessionSummary } from "../src/types.js";

function session(id: string, parentSessionPath?: string): SessionSummary {
  return {
    id,
    path: `/sessions/2026-01-01_${id}.jsonl`,
    harnessId: "pi",
    agentLabel: "Pi",
    title: id,
    updatedAt: `2026-01-01T00:00:0${id.length}.000Z`,
    ...(parentSessionPath ? { parentSessionPath } : {}),
  };
}

test("child conversations stay directly below their parent", () => {
  const parent = session("parent");
  const firstChild = session("child-a", parent.path);
  const secondChild = session("child-b", parent.path);
  const unrelated = session("other");

  assert.deepEqual(
    orderSessionFamilies([secondChild, unrelated, firstChild, parent]).map((entry) => entry.id),
    ["parent", "child-b", "child-a", "other"],
  );
});

test("a child can find a parent transcript moved to another node", () => {
  const parent = session("parent");
  const child = session("child", `/remote/node/2026-01-01_parent.jsonl`);

  assert.deepEqual(orderSessionFamilies([child, parent]).map((entry) => entry.id), ["parent", "child"]);
});

test("the conversation list renders child lineage", async () => {
  const [app, styles, serviceWorker] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("public/sw.js", "utf8"),
  ]);

  assert.match(app, /function nestedSessionRows\(sessions\)/);
  assert.match(app, /row\.dataset\.sessionDepth = String\(depth\)/);
  assert.match(app, /for \(const \{ session, depth \} of nestedSessionRows\(sessions\)\)/);
  assert.match(styles, /\.list-row\[data-session-depth="1"\]/);
  assert.match(styles, /\.list-row\[data-session-depth="1"\] \.session-card/);
  assert.match(serviceWorker, /joint-bob-v63/);
});
