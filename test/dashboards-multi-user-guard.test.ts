import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";

test("on a multi-user node dashboards never run an agent or a script as the service account", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-dashboards-multi-user-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const token = randomUUID();
  const settings = await import(`../src/settings-store.js?mu=${token}`) as typeof import("../src/settings-store.js");
  settings.save(settings.settingsDatabase(), "multiUser.enabled", "true");
  const service = await import(`../src/dashboards/service.js?mu=${token}`) as typeof import("../src/dashboards/service.js");
  const record = { id: randomUUID(), entity: { kind: "project", id: "p1" }, hostProjectId: "p1", origin: "own", approvedDigest: "d", definitionDigest: "d" } as never;
  const context = { entity: { kind: "project", id: "p1" }, project: { id: "p1", path: root, name: "p" }, label: "p" } as never;
  assert.throws(() => service.startRefresh(record, context, "live"), /multi-user/);
  assert.throws(() => service.startCreatorTurn(record, context, "build it"), /multi-user/);
});
