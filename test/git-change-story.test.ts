import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { buildTurns, commitHashesIn } from "../src/server/conversation-turns.js";
import { checkStory, fileArea, lineCounts, sourcesFromTurns, turnDigest, type ChangeStory } from "../src/server/git-change-story.js";

const git = promisify(execFile);

function story(overrides: Partial<ChangeStory> = {}): ChangeStory {
  return {
    kind: "Feature",
    title: "Greeting",
    overview: { what: "Adds a greeting.", why: "Users asked for one.", notice: ["The page says hello."], unchanged: "" },
    diagram: {
      lanes: [{ id: "user", label: "User" }, { id: "server", label: "Server" }],
      nodes: [
        { id: "open", lane: "user", kind: "action", label: "Open page", sub: "", text: "The user opens the page.", files: ["app.ts"] },
        { id: "greet", lane: "server", kind: "process", label: "Greet", sub: "", text: "The server answers hello.", files: [] },
      ],
      edges: [{ from: "open", to: "greet", label: "", style: "solid" }],
    },
    timeline: [{ turns: [1, 2], title: "Built it", did: ["Added the greeting."], decided: [], pivot: "", quiet: false }],
    examples: [{ kind: "Happy path", title: "Say hello", start: "A fresh page.", steps: [{ you: "Open it.", app: "Shows hello.", says: "Hello", nodes: ["open", "greet"], edges: ["open>greet"] }], result: "Hello appears." }],
    implementation: { what: { "app.ts": "Says hello." }, decisions: [{ title: "Plain text", why: "Simple.", instead: "HTML.", turn: 2 }], checks: [], tests: [] },
    ...overrides,
  };
}

test("turns split at user messages and collect commit hashes from git output only", () => {
  const turns = buildTurns([
    { id: "0", role: "assistant", text: "Before any question" },
    { id: "1", role: "user", text: "Add a greeting", timestamp: "2026-10-05T10:00:00.000Z" },
    { id: "2", role: "toolResult", toolName: "Bash", text: "[main 3b4f445e] feat: greet\n 1 file changed" },
    { id: "3", role: "assistant", text: "Committed app.ts" },
    { id: "4", role: "user", text: "Thanks" },
    { id: "5", role: "toolResult", toolName: "Bash", text: "3b4f445e feat: greet (git log output)" },
  ]);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns.map((turn) => turn.commits), [["3b4f445e"], []]);
  assert.equal(turns[0].at, "2026-10-05T10:00:00.000Z");
  assert.match(turns[0].assistant, /Committed app.ts/);
  assert.deepEqual(commitHashesIn("[detached HEAD (root-commit) abcdef1] x"), ["abcdef1"]);
});

test("a valid story passes and every unknown reference is rejected by name", () => {
  const facts = { paths: ["app.ts"], turns: 2 };
  assert.doesNotThrow(() => checkStory(story(), facts));
  const base = story();
  assert.throws(() => checkStory(story({ implementation: { ...base.implementation, what: { "src/server/realtime.ts": "x" } } }), facts), /src\/server\/realtime\.ts in Implementation, Components, which is not part of these changes/);
  assert.throws(() => checkStory(story({ timeline: [{ ...base.timeline[0], turns: [3] }] }), facts), /cites turn 3, but the conversation has 2 turns/);
  assert.throws(() => checkStory(story({ examples: [{ ...base.examples[0], steps: [{ ...base.examples[0].steps[0], nodes: ["missing"] }] }] }), facts), /diagram step that does not exist \(missing\)/);
  assert.throws(() => checkStory(story({ examples: [{ ...base.examples[0], steps: [{ ...base.examples[0].steps[0], edges: ["greet>open"] }] }] }), facts), /diagram arrow that does not exist/);
  assert.throws(() => checkStory(story({ diagram: { ...base.diagram, edges: [...base.diagram.edges, { from: "greet", to: "open", label: "", style: "solid" }] } }), facts), /loop/);
  assert.throws(() => checkStory(story(), { paths: ["app.ts"], turns: 0 }), /no conversation/);
  assert.throws(() => checkStory(story({ diagram: { ...base.diagram, nodes: base.diagram.nodes.map((node) => ({ ...node, lane: "elsewhere" })) } }), facts), /lane that does not exist/);
});

test("line counts and areas come from the patch and the path", () => {
  assert.deepEqual(lineCounts("--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n-old\n+new\n+more"), { add: 2, del: 1 });
  assert.equal(fileArea("src/server/routes/git.ts"), "src/server");
  assert.equal(fileArea("public/app.js"), "public");
  assert.equal(fileArea("README.md"), "root");
});

test("sources include conversation commits and pending files, and the fingerprint follows new turns and edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-story-"));
  const commit = async (message: string) => {
    const { stdout } = await git("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", message]);
    return stdout;
  };
  try {
    await git("git", ["init", "-q", root]);
    await writeFile(path.join(root, "base.txt"), "base\n");
    await git("git", ["-C", root, "add", "."]);
    await commit("initial");
    await writeFile(path.join(root, "app.ts"), "export const hello = 1;\n");
    await git("git", ["-C", root, "add", "app.ts"]);
    const output = await commit("feat: add app");
    await writeFile(path.join(root, "pending.ts"), "export const later = 2;\n");
    await writeFile(path.join(root, "other.ts"), "not claimed\n");
    const messages = [
      { id: "1", role: "user", text: "Add app.ts" },
      { id: "2", role: "toolResult", toolName: "Bash", text: output },
      { id: "3", role: "user", text: "Now add pending.ts" },
      { id: "4", role: "toolResult", toolName: "Write", text: "File created successfully at: pending.ts" },
      { id: "5", role: "toolResult", toolName: "Bash", text: "[main 0000000] a commit that does not exist" },
    ];
    const sources = { scope: "conversation" as const, pendingPaths: ["pending.ts"], includeCommits: true };
    const first = await sourcesFromTurns(root, buildTurns(messages), true, sources);
    assert.deepEqual(first.facts.files.map((file) => [file.path, file.kind, file.add, file.del]), [["app.ts", "added", 1, 0], ["pending.ts", "added", 1, 0]]);
    assert.deepEqual(first.facts.files.map((file) => file.where), [[first.facts.commits[0].shortHash], ["pending"]]);
    assert.equal(first.facts.commits.length, 1, "unknown hashes are skipped");
    assert.equal(first.facts.commits[0].turn, 1);
    assert.deepEqual(first.facts.turns.map((turn) => turn.paths), [["app.ts"], ["pending.ts"]]);
    assert.ok(!first.patches.some((patch) => patch.path === "other.ts"), "unclaimed files stay out");
    assert.match(turnDigest(first.turns, first.facts), /Turn 1, commits [0-9a-f]+, touched app\.ts/);

    const withoutCommits = await sourcesFromTurns(root, buildTurns(messages), true, { ...sources, includeCommits: false });
    assert.deepEqual(withoutCommits.facts.files.map((file) => file.path), ["pending.ts"]);

    const moreTurns = await sourcesFromTurns(root, buildTurns([...messages, { id: "6", role: "user", text: "One more thing" }]), true, sources);
    assert.notEqual(moreTurns.fingerprint, first.fingerprint, "a new turn outdates the story");
    await writeFile(path.join(root, "pending.ts"), "export const later = 3;\n");
    const edited = await sourcesFromTurns(root, buildTurns(messages), true, sources);
    assert.notEqual(edited.fingerprint, first.fingerprint, "an edit outdates the story");
    await assert.rejects(sourcesFromTurns(root, [], false, { scope: "all", pendingPaths: [], includeCommits: false }), /Nothing to explain/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
