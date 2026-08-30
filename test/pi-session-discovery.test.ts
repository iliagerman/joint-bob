import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Pi discovery includes flat Joint Bob sessions and standard cwd session directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-pi-sessions-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const sessionRoot = path.join(root, "sessions");
  const projectPath = path.join(root, "project");
  const safeCwd = `--${path.resolve(projectPath).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;

  try {
    for (const [index, directory] of [sessionRoot, path.join(sessionRoot, safeCwd)].entries()) {
      await mkdir(directory, { recursive: true });
      const parentSession = index === 1 ? path.join(sessionRoot, "session-0.jsonl") : undefined;
      const records = [
        { type: "session", version: 3, id: `session-${index}`, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectPath, ...(parentSession ? { parentSession } : {}) },
        { type: "message", id: `user-${index}`, parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Test conversation" }], timestamp: 1 } },
        { type: "message", id: `assistant-${index}`, parentId: `user-${index}`, timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "Done" }], timestamp: 2 } },
      ];
      await writeFile(path.join(directory, `session-${index}.jsonl`), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    }
    const { updateSettings } = await import("../src/settings.js");
    updateSettings({
      pi: { executable: "", configPath: path.join(root, "pi"), sessionPath: sessionRoot },
      claude: { executable: "", configPath: path.join(root, "claude"), sessionPath: path.join(root, "claude", "projects") },
      syncthing: { endpoint: "" },
      projects: { homePath: path.join(root, "JointBob") },
    });
    const { listPiSessions } = await import("../src/pi-service.js");

    const sessions = await listPiSessions({ path: projectPath });

    assert.equal(sessions.length, 2);
    assert.equal(new Set(sessions.map((session) => session.path)).size, 2);
    assert.ok(sessions.every((session) => session.agentLabel === "Pi"));
    assert.equal(sessions.find((session) => session.id === "session-1")?.parentSessionPath, path.join(sessionRoot, "session-0.jsonl"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function transcript(sessionId: string, cwd: string, events: Array<{ id: string; timestamp: string; text: string }>): string {
  const header = { type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd };
  const records = events.map((event, index) => ({
    type: "message", id: event.id, parentId: index ? events[index - 1].id : null, timestamp: event.timestamp,
    message: { role: index % 2 ? "assistant" : "user", content: [{ type: "text", text: event.text }], timestamp: Date.parse(event.timestamp) },
  }));
  return `${[header, ...records].map((record) => JSON.stringify(record)).join("\n")}\n`;
}

test("Pi conflict recovery selects the newest complete transcript and preserves canonical-only discovery", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-pi-conflict-"));
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  const sessionRoot = path.join(root, "sessions");
  const projectPath = path.join(root, "project");
  const canonicalPath = path.join(sessionRoot, "conflicted.jsonl");
  const firstConflict = path.join(sessionRoot, "conflicted.sync-conflict-20260827-231125-A.jsonl");
  const truncatedConflict = path.join(sessionRoot, "conflicted.sync-conflict-20260828-001419-Z.jsonl");
  try {
    await mkdir(sessionRoot, { recursive: true });
    const baseline = [
      { id: "wolt", timestamp: "2026-01-01T00:00:01.000Z", text: "Wolt analysis" },
      { id: "analysis", timestamp: "2026-01-01T00:00:02.000Z", text: "Analysis complete" },
    ];
    const complete = transcript("conflicted", projectPath, [...baseline,
      { id: "tests", timestamp: "2026-01-01T00:00:03.000Z", text: "Tests passed" },
      { id: "deployment", timestamp: "2026-01-01T00:00:04.000Z", text: "Production deployment complete" },
    ]);
    await writeFile(canonicalPath, transcript("conflicted", projectPath, baseline));
    await writeFile(firstConflict, complete);
    await writeFile(truncatedConflict, transcript("conflicted", projectPath, [{ id: "truncated", timestamp: "2026-01-01T00:00:05.000Z", text: "new but incomplete" }]));

    const { updateSettings } = await import("../src/settings.js");
    updateSettings({
      pi: { executable: "", configPath: path.join(root, "pi"), sessionPath: sessionRoot },
      claude: { executable: "", configPath: path.join(root, "claude"), sessionPath: path.join(root, "claude", "projects") },
      syncthing: { endpoint: "" }, projects: { homePath: path.join(root, "JointBob") },
    });
    const { listPiSessions } = await import("../src/pi-service.js");
    const sessions = await listPiSessions({ path: projectPath });

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].path, canonicalPath);
    assert.notEqual(await readFile(canonicalPath, "utf8"), complete);
    assert.equal((await readdir(sessionRoot)).filter((name) => name.includes("sync-conflict")).length, 2);

    const { capturePiRecoverySnapshot, recoverPiSessionDirectory } = await import("../src/session-paths.js");
    const snapshot = await capturePiRecoverySnapshot(canonicalPath);
    await recoverPiSessionDirectory(sessionRoot, await readdir(sessionRoot), snapshot, projectPath);
    assert.equal(await readFile(canonicalPath, "utf8"), complete);
    assert.deepEqual((await readdir(sessionRoot)).filter((name) => name.includes("sync-conflict")), []);
    assert.match(await readFile(canonicalPath, "utf8"), /Wolt analysis.*Tests passed.*Production deployment complete/s);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi recovery refuses replacement when canonical changes after fencing snapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-pi-revalidate-"));
  const canonicalPath = path.join(root, "moving.jsonl");
  const conflictName = "moving.sync-conflict-20260828-001419-A.jsonl";
  try {
    const baseline = transcript("moving", root, [{ id: "first", timestamp: "2026-01-01T00:00:01.000Z", text: "first" }]);
    await writeFile(canonicalPath, baseline);
    await writeFile(path.join(root, conflictName), transcript("moving", root, [
      { id: "first", timestamp: "2026-01-01T00:00:01.000Z", text: "first" },
      { id: "second", timestamp: "2026-01-01T00:00:02.000Z", text: "second" },
    ]));
    const { capturePiRecoverySnapshot, recoverPiSessionDirectory } = await import("../src/session-paths.js");
    const snapshot = await capturePiRecoverySnapshot(canonicalPath);
    await writeFile(canonicalPath, `${baseline.trim()}\n${JSON.stringify({ type: "custom", id: "writer", parentId: "first", timestamp: "2026-01-01T00:00:03.000Z", customType: "writer", data: {} })}\n`);
    await assert.rejects(
      recoverPiSessionDirectory(root, await readdir(root), snapshot),
      /canonical Pi transcript changed during recovery fencing/,
    );
    assert.ok((await readdir(root)).includes(conflictName));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi recovery leaves malformed groups in place and exposes no conversation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-pi-invalid-conflict-"));
  const sessionRoot = path.join(root, "sessions");
  const canonical = "broken.jsonl";
  const conflict = "broken.sync-conflict-20260828-001419-A.jsonl";
  try {
    await mkdir(sessionRoot, { recursive: true });
    await writeFile(path.join(sessionRoot, canonical), "not json\n");
    await writeFile(path.join(sessionRoot, conflict), transcript("wrong-id", root, []));
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => warnings.push(String(message));
    try {
      const { capturePiRecoverySnapshot, recoverPiSessionDirectory } = await import("../src/session-paths.js");
      const snapshot = await capturePiRecoverySnapshot(path.join(sessionRoot, canonical));
      const available = await recoverPiSessionDirectory(sessionRoot, [canonical, conflict], snapshot);
      assert.equal(available.size, 0);
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(new Set(await readdir(sessionRoot)), new Set([canonical, conflict]));
    assert.ok(warnings.some((warning) => warning.includes("pi_transcript_recovery_failed")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi conflict grouping scales linearly from 500 to 1,000 paths", async () => {
  const { discoverPiSessionDirectory } = await import("../src/session-paths.js");
  const names = (count: number) => Array.from({ length: count }, (_, index) => `session-${index}.jsonl`);
  const fiveHundred = names(500);
  const oneThousand = names(1000);
  const smallSamples: number[] = [];
  const largeSamples: number[] = [];
  await discoverPiSessionDirectory(os.tmpdir(), fiveHundred);
  await discoverPiSessionDirectory(os.tmpdir(), oneThousand);
  for (let sample = 0; sample < 21; sample += 1) {
    const largeStarted = process.cpuUsage();
    for (let run = 0; run < 20; run += 1) await discoverPiSessionDirectory(os.tmpdir(), oneThousand);
    const largeUsage = process.cpuUsage(largeStarted);
    largeSamples.push(largeUsage.user + largeUsage.system);
    const smallStarted = process.cpuUsage();
    for (let run = 0; run < 20; run += 1) await discoverPiSessionDirectory(os.tmpdir(), fiveHundred);
    const smallUsage = process.cpuUsage(smallStarted);
    smallSamples.push(smallUsage.user + smallUsage.system);
  }
  const medianSmall = smallSamples.sort((left, right) => left - right)[10];
  const medianLarge = largeSamples.sort((left, right) => left - right)[10];
  assert.ok(medianLarge <= medianSmall * 2.5, `Expected linear grouping, measured ${(medianLarge / medianSmall).toFixed(2)}x`);
});
