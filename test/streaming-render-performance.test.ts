import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("streamed assistant text paints cheaply before the final markdown render", async () => {
  const app = await readFile("public/app.js", "utf8");

  assert.match(app, /function renderBubbleContent\(bubble, text, flush = false\)/);
  assert.match(app, /bubble\._renderFinal = bubble\._renderFinal \|\| flush;/);
  assert.match(app, /role === "assistant" && !bubble\._renderFinal/);
  assert.match(app, /!bubble\._hasRenderedText/);
  assert.match(app, /cancelAnimationFrame\(bubble\._renderRaf\)/);
  assert.match(app, /content\.textContent = text;[\s\S]*return;/);
  assert.match(app, /content\.textContent = bubble\._raw/);
  assert.match(app, /renderBubbleContent\(bubble, text, true\)/);
  assert.match(app, /renderBubbleContent\(state\.assistantBubble, payload\.text, true\)/);
  assert.doesNotMatch(app, /LARGE_MESSAGE_RENDER_MS|bubble\._renderTimer/);
});

test("off-screen chat bubbles keep their real height while scrolling", async () => {
  const styles = await readFile("public/styles.css", "utf8");

  assert.doesNotMatch(styles, /^\.message \{[^\n}]*content-visibility:/m);
  assert.doesNotMatch(styles, /^\.message \{[^\n}]*contain-intrinsic-size:/m);
});

test("Claude session listing reads a bounded number of transcripts at a time", async () => {
  const source = await readFile("src/claude-service.ts", "utf8");

  assert.match(source, /const CLAUDE_LIST_CONCURRENCY = 8;/);
  assert.match(source, /mapWithConcurrency\(files, CLAUDE_LIST_CONCURRENCY,/);
  assert.doesNotMatch(source, /await Promise\.all\(files\.map\(/);
});

test("Claude session listing returns every transcript when there are more than the concurrency limit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-claude-concurrency-"));
  const previousDataDir = process.env.PI_WEB_DATA_DIR;
  process.env.PI_WEB_DATA_DIR = root;
  try {
    const sessionRoot = path.join(root, "claude-sessions");
    const projectCwd = path.join(root, "project");
    await mkdir(projectCwd, { recursive: true });

    const settings = await import(`../src/settings.js?cache=${Date.now()}-${Math.random()}`);
    settings.updateSettings({
      pi: { executable: "pi", configPath: path.join(root, "pi-config"), sessionPath: path.join(root, "pi-sessions") },
      claude: { executable: "claude", configPath: path.join(root, "claude-config"), sessionPath: sessionRoot },
      syncthing: { endpoint: "" },
    });

    const sessionPaths = await import(`../src/session-paths.js?cache=${Date.now()}-${Math.random()}`);
    const claude = await import(`../src/claude-service.js?cache=${Date.now()}-${Math.random()}`);
    const projectDir = sessionPaths.claudeProjectDir(projectCwd, sessionRoot);
    await mkdir(projectDir, { recursive: true });

    const total = 25;
    for (let index = 0; index < total; index += 1) {
      const line = JSON.stringify({ type: "user", cwd: projectCwd, message: { role: "user", content: [{ text: `Session ${index}` }] } });
      await writeFile(path.join(projectDir, `session-${index}.jsonl`), `${line}\n`);
    }

    const sessions = await claude.listClaudeSessions({ path: projectCwd });
    assert.equal(sessions.length, total);
    const titles = new Set(sessions.map((session: { title: string }) => session.title));
    assert.equal(titles.size, total);
    assert.ok(titles.has("[Claude] Session 0"));
    assert.ok(titles.has("[Claude] Session 24"));
  } finally {
    if (previousDataDir === undefined) delete process.env.PI_WEB_DATA_DIR;
    else process.env.PI_WEB_DATA_DIR = previousDataDir;
  }
});
