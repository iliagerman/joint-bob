import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseCompletedJsonl, parseJsonlSkippingDamage } from "../src/jsonl.js";

// 2026-10-26: the homeserver's disk filled mid-write, the cut record later got its newline, and every
// list holding that Pi transcript failed (/api/running among them), so the Mac app could not open.

test("lists skip a damaged complete line and say so once; forks still refuse it", () => {
  const good = JSON.stringify({ type: "message", id: "a" });
  const cut = `{"type":"message","id":"b","message":{"content":[{"type":"text","text":"No currency conver`;
  const after = JSON.stringify({ type: "message", id: "c" });
  const contents = `${good}\n${cut}\n${after}\n{"type":"mess`;
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
  try {
    assert.deepEqual(parseJsonlSkippingDamage(contents, "/sessions/damaged.jsonl"), [{ type: "message", id: "a" }, { type: "message", id: "c" }]);
    parseJsonlSkippingDamage(contents, "/sessions/damaged.jsonl");
  } finally { console.warn = warn; }
  assert.deepEqual(warned, ["Transcript /sessions/damaged.jsonl has 1 damaged line; it is skipped"]);
  assert.throws(() => parseCompletedJsonl(contents), SyntaxError);
});

test("a Pi transcript with a damaged line still lists, and so do the others", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-pi-damage-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = path.join(root, "data");
  try {
    const sessionRoot = path.join(root, "sessions");
    const projectCwd = path.join(root, "project");
    await mkdir(projectCwd, { recursive: true });
    const sessionDir = path.join(sessionRoot, `--${path.resolve(projectCwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
    await mkdir(sessionDir, { recursive: true });
    const records = (id: string, text: string) => [
      { type: "session", version: 3, id, timestamp: "2026-10-26T12:00:00.000Z", cwd: projectCwd },
      { type: "message", id: `${id}-user`, parentId: null, timestamp: "2026-10-26T12:00:01.000Z", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse("2026-10-26T12:00:01.000Z") } },
    ].map((record) => JSON.stringify(record));
    await writeFile(path.join(sessionDir, "healthy.jsonl"), `${records("healthy", "Healthy one").join("\n")}\n`);
    const cut = JSON.stringify({ type: "message", id: "damaged-assistant", parentId: "damaged-user", message: { role: "assistant", content: [{ type: "text", text: "A long answer" }] } }).slice(0, 60);
    await writeFile(path.join(sessionDir, "damaged.jsonl"), `${records("damaged", "Damaged one").join("\n")}\n${cut}\n`);

    const settings = await import(`../src/settings.js?damage=${Date.now()}-${Math.random()}`);
    settings.updateSettings({
      pi: { executable: "", configPath: path.join(root, "pi"), sessionPath: sessionRoot },
      claude: { executable: "", configPath: path.join(root, "claude"), sessionPath: path.join(root, "claude", "projects") },
      syncthing: { endpoint: "" },
      projects: { homePath: path.join(root, "JointBob") },
    });
    const pi = await import(`../src/pi-service.js?damage=${Date.now()}-${Math.random()}`);
    const warn = console.warn;
    console.warn = () => {};
    let sessions;
    try { sessions = await pi.listPiSessions({ path: projectCwd }); } finally { console.warn = warn; }
    assert.deepEqual(sessions.map((session: { id: string; title: string }) => [session.id, session.title]).sort(), [["damaged", "Damaged one"], ["healthy", "Healthy one"]]);
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR; else process.env.PI_WEB_DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});
