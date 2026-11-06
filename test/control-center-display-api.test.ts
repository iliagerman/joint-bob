import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { BobMessage } from "../src/control-center/bob-store.js";
import { api, seedDevEnvironment, signIn, stopDevNode, waitForDevNode, type DevEnvironment, type SeededNode } from "./dev-nodes.js";
import { serverArgs } from "./server-entry.js";

/** A real node with Joint Bob's display agent stood in: what it "answers" is the display.json the test writes. */
async function startNode(environment: DevEnvironment, node: SeededNode, directory: string): Promise<ChildProcess> {
  const env: NodeJS.ProcessEnv = {
    ...process.env, PORT: String(node.port), NODE_ENV: "test", HOME: environment.home, JOINT_BOB_DATA_DIR: node.dataDir, JOINT_BOB_SESSION_COOKIE: node.cookieName,
    JOINT_BOB_INSECURE_COOKIE: "1", JOINT_BOB_RELEASE: "development", JOINT_BOB_TEST_ENGINE_LOG: path.join(directory, "engine.log"), JOINT_BOB_TEST_AUTOMATION_DIR: directory,
  };
  delete env.TYPESAFE_AI_API_KEY;
  const child = spawn(process.execPath, serverArgs(env, ["./test/stub-harness-bootstrap.ts", "./test/stub-automation-bootstrap.ts"]), { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
  return waitForDevNode(child, node.key, node.url);
}

const appearance = {
  settings: { theme: "dark", global: 1, sections: { chat: 1, projects: 1 } },
  themes: [{ id: "dark", label: "Dark" }, { id: "midnight", label: "Midnight" }],
  sections: [{ id: "chat", label: "Conversation" }, { id: "projects", label: "Projects panel" }],
  scale: { min: 0.8, max: 2, step: 0.05 },
};

interface Reply { action: string; reply: BobMessage; appearance?: unknown }

test("Bob hands a display request to Joint Bob's display agent on a lighter model, and the page gets the change with an Undo", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "control-display-"));
  let child: ChildProcess | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const directory = path.join(root, "stubs");
    await mkdir(directory, { recursive: true });
    child = await startNode(environment, node, directory);
    const auth = await signIn(environment, node);
    // Bob's agent is the stubbed Claude, which needs no model set up; the display agent then runs on Claude's lighter levels.
    assert.equal((await api(node, auth, "PUT", "/control-center/bob/settings", { harnessId: "claude" })).status, 200);
    const send = async (body: Record<string, unknown>) => {
      const response = await api<Reply>(node, auth, "POST", "/control-center/bob/message", body);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      return response.body;
    };

    await writeFile(path.join(directory, "display.json"), JSON.stringify({ intent: "change", theme: "midnight", sections: { chat: 1.13 }, reply: "Switched to Midnight and made the conversation larger." }));
    const changed = await send({ message: "make it darker and the conversation text bigger", appearance });
    assert.deepEqual(changed.appearance, { theme: "midnight", global: 1, sections: { chat: 1.15, projects: 1 } }, "the page gets the whole new settings");
    assert.equal(changed.reply.text, "Switched to Midnight and made the conversation larger.");
    assert.equal(changed.reply.importance, "done");
    assert.deepEqual(changed.reply.actions, [{ id: "display.undo", label: "Undo", data: { appearance: appearance.settings } }]);
    // No decision model key here, so the routing profile's lightest level runs: never one of its strongest models.
    assert.equal(changed.reply.via, "Display agent · haiku · lightest level 1");

    // What the settings cannot do is said, and nothing changes; a theme the page does not have is refused.
    await writeFile(path.join(directory, "display.json"), JSON.stringify({ intent: "cannot", reply: "I can change the theme and sizes, not the font." }));
    const cannot = await send({ message: "use the Comic Sans font", appearance });
    assert.equal(cannot.reply.text, "I can change the theme and sizes, not the font.");
    assert.equal(cannot.appearance, undefined);
    await writeFile(path.join(directory, "display.json"), JSON.stringify({ intent: "change", theme: "neon", reply: "Neon it is." }));
    const unknown = await send({ message: "switch to the neon theme", appearance });
    assert.match(unknown.reply.text, /no "neon" theme\. Nothing was changed\./);
    assert.equal(unknown.appearance, undefined);

    // Not about how the app looks: the display agent says none and Bob answers as usual. Without the page (Telegram) it is not asked.
    await writeFile(path.join(directory, "display.json"), JSON.stringify({ intent: "none" }));
    const other = await send({ message: "is the light build finished?", appearance });
    assert.equal(other.appearance, undefined);
    assert.doesNotMatch(other.reply.via ?? "", /^Display agent/);
    const elsewhere = await send({ message: "switch to the dark theme" });
    assert.equal(elsewhere.appearance, undefined);
    assert.doesNotMatch(elsewhere.reply.via ?? "", /^Display agent/);
  } finally {
    if (child) await stopDevNode(child);
    await rm(root, { recursive: true, force: true });
  }
});
