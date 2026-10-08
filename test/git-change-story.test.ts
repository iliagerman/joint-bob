import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gitPushHistory } from "../src/git-review.js";
import { buildTurns, commitHashesIn } from "../src/server/conversation-turns.js";
import { checkStory, fileArea, fitPatches, lineCounts, sourcesFromPull, sourcesFromTurns, turnDigest, type ChangeStory } from "../src/server/git-change-story.js";
import { createTopLevelFieldScanner } from "../src/server/story-json-scanner.js";

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

test("the scanner reports each top-level field once, as soon as the model finishes writing it", () => {
  const written = { ...story(), overview: { what: 'Braces { and ] and "quotes" stay text.', why: "Back\\slash \\\" escapes.", notice: ["a,b"], unchanged: "" }, count: 3, flag: true };
  const text = `\`\`\`json\n${JSON.stringify(written, null, 2)}\n\`\`\``;
  const seen: Array<[string, unknown]> = [];
  const scan = createTopLevelFieldScanner((key, value) => seen.push([key, value]));
  const overviewEnds = text.indexOf('"diagram"');
  for (let end = 1; end <= text.length; end += 7) {
    scan(text.slice(0, end));
    if (end < overviewEnds) assert.ok(!seen.some(([key]) => key === "diagram"), "the diagram is not reported before it is written");
  }
  scan(text);
  assert.deepEqual(seen.map(([key]) => key), ["kind", "title", "overview", "diagram", "timeline", "examples", "implementation", "count", "flag"]);
  assert.deepEqual(Object.fromEntries(seen), written);
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

test("pending changes past the review limit still make a story, with the largest diffs left out", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-story-"));
  try {
    await git("git", ["init", "-q", root]);
    await writeFile(path.join(root, "huge.ts"), Array.from({ length: 4000 }, (_, line) => `export const value${line} = "${"x".repeat(20)}";`).join("\n") + "\n");
    await writeFile(path.join(root, "small.ts"), "export const small = 1;\n");
    const sources = { scope: "all" as const, pendingPaths: ["huge.ts", "small.ts"], includeCommits: false };
    const first = await sourcesFromTurns(root, [], false, sources);
    assert.deepEqual(first.facts.omitted, ["huge.ts"]);
    assert.deepEqual(first.facts.files.map((file) => [file.path, file.add]), [["huge.ts", 4000], ["small.ts", 1]], "counts come from the full diff");
    assert.match(first.patches.find((patch) => patch.path === "huge.ts")!.patch, /too large: \+4000 −0 lines/);
    assert.match(first.patches.find((patch) => patch.path === "small.ts")!.patch, /export const small/);
    const again = await sourcesFromTurns(root, [], false, sources);
    assert.deepEqual(again.patches, first.patches, "fitting is stable, so freshness sees no change");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fitting leaves small changes untouched and refuses only when even line counts do not fit", () => {
  const patches = [{ path: "a.ts", source: "pending", patch: "+a\n" }, { path: "b.ts", source: "pending", patch: "+b\n" }];
  assert.deepEqual(fitPatches(patches, 1000), { patches, omitted: [] });
  assert.throws(() => fitPatches(patches, 4), /too many files for one story/);
});

test("picked commits are explained oldest first without the conversation, and bad picks are refused", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-story-pick-"));
  const run = (...args: string[]) => git("git", ["-C", root, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args]);
  try {
    await git("git", ["init", "-q", root]);
    const hashes: string[] = [];
    for (const [index, name] of ["one.ts", "two.ts", "three.ts"].entries()) {
      await writeFile(path.join(root, name), `export const n = ${index};\n`);
      await run("add", name);
      await run("commit", "-q", "-m", `add ${name}`, "-m", `Because ${name} is needed.`, `--date=2026-10-0${index + 1}T10:00:00Z`);
      hashes.push((await run("rev-parse", "HEAD")).stdout.trim());
    }
    const sources = { kind: "commits" as const, scope: "all" as const, pendingPaths: [], includeCommits: false, commits: [hashes[2], hashes[0]] };
    const picked = await sourcesFromTurns(root, [], false, sources);
    assert.deepEqual(picked.facts.commits.map((commit) => [commit.subject, commit.turn]), [["add one.ts", 0], ["add three.ts", 0]]);
    assert.equal(picked.facts.commits[0].body, "Because one.ts is needed.");
    assert.deepEqual(picked.facts.files.map((file) => file.path), ["one.ts", "three.ts"]);
    assert.equal(picked.facts.conversation, false);
    assert.deepEqual(picked.facts.turns, []);
    await assert.rejects(sourcesFromTurns(root, [], false, { ...sources, commits: ["0000000"] }), /no longer in this repository/);
    for (let index = 0; index < 18; index += 1) {
      await run("commit", "-q", "--allow-empty", "-m", `empty ${index}`);
      hashes.push((await run("rev-parse", "HEAD")).stdout.trim());
    }
    assert.equal(new Set(hashes).size, 21);
    await assert.rejects(sourcesFromTurns(root, [], false, { ...sources, commits: hashes }), /at most 20 commits/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("PR source uses GitHub patches and detects head or description updates", () => {
  const input = { pull: { number: 42, title: "Add widget", body: "Needed for the dashboard", html_url: "https://github.com/acme/widget/pull/42", head: { sha: "a".repeat(40) }, base: { ref: "main" }, changed_files: 2 }, files: [
    { filename: "src/widget.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+widget" },
    { filename: "image.png", status: "modified", additions: 0, deletions: 0 },
  ] };
  const source = sourcesFromPull(input);
  assert.equal(source.facts.conversation, false);
  assert.deepEqual(source.facts.files.map((file) => file.path), ["src/widget.ts", "image.png"]);
  assert.deepEqual(source.facts.omitted, ["image.png"]);
  assert.match(source.patches[0].patch, /widget/);
  assert.notEqual(sourcesFromPull({ ...input, pull: { ...input.pull, head: { sha: "b".repeat(40) } } }).fingerprint, source.fingerprint);
  assert.notEqual(sourcesFromPull({ ...input, pull: { ...input.pull, body: "Updated" } }).fingerprint, source.fingerprint);
  assert.throws(() => sourcesFromPull({ ...input, files: [] }), /no changed files/);
});

test("push history lists each push with its own commits and skips fetches", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-pushes-"));
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  const remote = path.join(root, "remote.git");
  const run = (cwd: string, ...args: string[]) => git("git", ["-C", cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args]);
  const commit = async (cwd: string, name: string) => { await writeFile(path.join(cwd, name), `${name}\n`); await run(cwd, "add", name); await run(cwd, "commit", "-q", "-m", `add ${name}`); };
  try {
    await git("git", ["init", "-q", "--bare", "-b", "main", remote]);
    await git("git", ["clone", "-q", remote, work]);
    await run(work, "checkout", "-q", "-b", "main");
    await commit(work, "a.txt");
    await run(work, "push", "-q", "-u", "origin", "main");
    await commit(work, "b.txt");
    await commit(work, "c.txt");
    await run(work, "push", "-q");
    // Someone else pushes; our fetch must not count as our push.
    await git("git", ["clone", "-q", remote, other]);
    await commit(other, "d.txt");
    await run(other, "push", "-q");
    await run(work, "pull", "-q", "--ff-only");
    await commit(work, "e.txt");
    await run(work, "push", "-q");
    const pushes = await gitPushHistory(work);
    assert.deepEqual(pushes.map((push) => [push.ref, push.commits.map((item) => item.subject)]), [
      ["origin/main", ["add e.txt"]],
      ["origin/main", ["add c.txt", "add b.txt"]],
      ["origin/main", ["add a.txt"]],
    ]);
    assert.equal(pushes[0].more, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
