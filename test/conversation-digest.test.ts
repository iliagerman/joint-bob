import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { digestIsStale, digestMaterial, digestPrompt, parseDigestAnswer, turnsToSummarize, type ConversationDigest } from "../src/conversation-digest.js";
import { claudeProjectDir } from "../src/session-paths.js";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

const turn = (user: string, assistant: string) => ({ user, assistant });

test("a digest is stale when turns were added or the last answer grew", () => {
  const turns = [turn("a", "one"), turn("b", "two")];
  const digest: ConversationDigest = { summary: "s", turns: 2, lastAnswerLength: 3, updatedAt: "" };
  assert.equal(digestIsStale(undefined, []), false, "an empty conversation has nothing to summarize");
  assert.equal(digestIsStale(undefined, turns), true);
  assert.equal(digestIsStale(digest, turns), false);
  assert.equal(digestIsStale(digest, [...turns, turn("c", "")]), true);
  assert.equal(digestIsStale(digest, [turn("a", "one"), turn("b", "two, then more")]), true);
});

test("a refresh rereads only the last covered turn and the new ones", () => {
  const turns = [turn("1", "a"), turn("2", "b"), turn("3", "c"), turn("4", "d")];
  assert.deepEqual(turnsToSummarize(undefined, turns), { from: 0, turns });
  const digest: ConversationDigest = { summary: "s", turns: 2, lastAnswerLength: 1, updatedAt: "" };
  assert.deepEqual(turnsToSummarize(digest, turns), { from: 1, turns: turns.slice(1) });
});

test("material numbers turns from where the summary left off and drops the oldest when too long", () => {
  const material = digestMaterial(4, [turn("fix the build", "Done."), turn("now ship it", "")]);
  assert.match(material, /### Turn 5\nUser: fix the build\nAssistant: Done\./);
  assert.match(material, /### Turn 6\nUser: now ship it\nAssistant: \(no answer yet\)/);

  const long = Array.from({ length: 40 }, (_, index) => turn(`question ${index + 1}`, "x".repeat(4_000)));
  const bounded = digestMaterial(0, long);
  assert.ok(bounded.length < 70_000, `material stays bounded (${bounded.length})`);
  assert.match(bounded, /earlier new turns omitted for length/);
  assert.match(bounded, /### Turn 40\nUser: question 40/, "the newest turn is always kept");
});

test("the prompt carries the previous summary only when there is one", () => {
  assert.doesNotMatch(digestPrompt(undefined), /Existing summary:/);
  assert.match(digestPrompt("**Goal** — ship it"), /Existing summary:\n\*\*Goal\*\* — ship it$/);
  assert.equal(parseDigestAnswer("```markdown\n**Goal** — x\n```"), "**Goal** — x");
  assert.equal(parseDigestAnswer("  plain  "), "plain");
});

test("the digest route summarizes a conversation incrementally and only for visible conversations", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-digest-"));
  const generator = path.join(root, "digest-generator.mjs");
  const calls = path.join(root, "calls.jsonl");
  await writeFile(generator, `import { appendFile } from "node:fs/promises";\nexport default async (input) => { if (input.material.includes("FAIL please")) throw new Error("model unavailable"); await appendFile(${JSON.stringify(calls)}, JSON.stringify(input) + "\\n"); return "\`\`\`markdown\\n**Goal** — summary " + input.material.split("### Turn").length + "\\n\`\`\`"; };\n`);
  const environment = await seedDevEnvironment(root, 1);
  const node = environment.nodes[0];
  const project = projectNamed(node, "Infra Scripts");
  const conversationId = "6a0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d";
  const transcript = path.join(claudeProjectDir(project.path, path.join(environment.home, ".claude", "projects")), `${conversationId}.jsonl`);
  const record = (role: "user" | "assistant", index: number, content: unknown[]) => JSON.stringify({ type: role, uuid: `${conversationId}-${index}`, cwd: project.path, timestamp: new Date(Date.parse("2026-09-01T10:00:00Z") + index * 1_000).toISOString(), message: { role, content } });
  await writeFile(transcript, [
    record("user", 0, [{ type: "text", text: "Rotate the staging certificates" }]),
    record("assistant", 1, [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls certs" } }]),
    record("user", 2, [{ type: "tool_result", tool_use_id: "t1", content: "staging.pem" }]),
    record("assistant", 3, [{ type: "text", text: "Rotated staging.pem." }]),
  ].join("\n") + "\n");
  const server = await startDevNode(environment, node, { JOINT_BOB_DIGEST_GENERATOR: generator });
  try {
    const auth = await signIn(environment, node);
    const endpoint = `/projects/${project.id}/conversations/${conversationId}/digest`;
    type DigestResponse = { digest: ConversationDigest | null; stale: boolean; turns?: number };

    const before = await api<DigestResponse>(node, auth, "GET", endpoint);
    assert.equal(before.status, 200);
    assert.deepEqual([before.body.digest, before.body.stale, before.body.turns], [null, true, 1]);

    // By default the summary is written by the conversation's own agent and model, as the page reports them.
    const sonnet = { harnessId: "claude", provider: "claude", modelId: "sonnet" };
    const first = await api<DigestResponse>(node, auth, "POST", endpoint, { conversation: sonnet });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(first.body.digest?.model, { ...sonnet, source: "conversation" }, "the summary records who wrote it");
    assert.equal(first.body.digest?.summary, "**Goal** — summary 2", "the answer's code fence is removed");
    assert.equal(first.body.digest?.turns, 1);
    const [firstCall] = (await readFile(calls, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.match(firstCall.material, /### Turn 1\nUser: Rotate the staging certificates\nAssistant: Rotated staging\.pem\./);
    assert.doesNotMatch(firstCall.material, /staging\.pem"|ls certs/, "tool calls and their output stay out of the summary input");
    assert.doesNotMatch(firstCall.instructions, /Existing summary:/);
    assert.deepEqual(firstCall.run, { ...sonnet, thinkingLevel: "", source: "conversation" }, "the conversation's model runs at its agent's default effort");

    assert.equal((await api<DigestResponse>(node, auth, "GET", endpoint)).body.stale, false);
    const again = await api<DigestResponse>(node, auth, "POST", endpoint, {});
    assert.equal(again.body.digest?.updatedAt, first.body.digest?.updatedAt, "an up-to-date summary is not rewritten");
    assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 1);

    await appendFile(transcript, [
      record("user", 4, [{ type: "text", text: "Now production" }]),
      record("assistant", 5, [{ type: "text", text: "Production rotated too." }]),
    ].join("\n") + "\n");
    // The conversation listing is cached briefly; wait until the new turn shows.
    const deadline = Date.now() + 15_000;
    let stale = await api<DigestResponse>(node, auth, "GET", endpoint);
    while (!stale.body.stale && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      stale = await api<DigestResponse>(node, auth, "GET", endpoint);
    }
    assert.deepEqual([stale.body.stale, stale.body.turns], [true, 2]);
    const second = await api<DigestResponse>(node, auth, "POST", endpoint, {});
    assert.equal(second.body.digest?.turns, 2);
    const secondCall = JSON.parse((await readFile(calls, "utf8")).trim().split("\n")[1]);
    assert.match(secondCall.instructions, /Existing summary:\n\*\*Goal\*\* — summary 2$/);
    assert.match(secondCall.material, /^### Turn 1\n[\s\S]*### Turn 2\nUser: Now production/, "the last covered turn is reread with the new one");
    assert.deepEqual(secondCall.run, { harnessId: "claude", provider: "", modelId: "", thinkingLevel: "", source: "conversation" }, "without the page's report, the transcript's agent writes it");

    // A Summary model setting wins over the conversation's own.
    const chosen = { harnessId: "pi", modelId: "gpt-test", thinkingLevel: "low" };
    assert.equal((await api(node, auth, "PUT", "/preferences", { summaryModel: chosen })).status, 200);
    assert.deepEqual((await api<{ summaryModel: unknown }>(node, auth, "GET", "/preferences")).body.summaryModel, chosen);
    await appendFile(transcript, [
      record("user", 6, [{ type: "text", text: "And the CA" }]),
      record("assistant", 7, [{ type: "text", text: "CA rotated." }]),
    ].join("\n") + "\n");
    let third = await api<DigestResponse>(node, auth, "POST", endpoint, { conversation: sonnet });
    for (const until = Date.now() + 15_000; third.body.digest?.turns !== 3 && Date.now() < until;) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      third = await api<DigestResponse>(node, auth, "POST", endpoint, { conversation: sonnet });
    }
    assert.equal(third.body.digest?.turns, 3);
    const thirdCall = JSON.parse((await readFile(calls, "utf8")).trim().split("\n")[2]);
    assert.deepEqual(thirdCall.run, { harnessId: "pi", provider: "", modelId: "gpt-test", thinkingLevel: "low", source: "setting" });
    assert.equal((await api(node, auth, "POST", endpoint, { conversation: { harnessId: "not-a-harness" } })).status, 400, "the reported model is validated");
    assert.equal((await api(node, auth, "PUT", "/preferences", { summaryModel: null })).status, 200);

    const unstarted = await api<DigestResponse>(node, auth, "GET", `/projects/${project.id}/conversations/00000000-0000-4000-8000-000000000000/digest`);
    assert.deepEqual([unstarted.status, unstarted.body.digest, unstarted.body.stale, unstarted.body.turns], [200, null, false, 0], "a conversation with no transcript yet simply has no summary");
    assert.equal((await api(node, auth, "POST", `/projects/${project.id}/conversations/00000000-0000-4000-8000-000000000000/digest`, {})).status, 404);

    // A model that fails leaves the stored summary in place and says why.
    await appendFile(transcript, record("user", 8, [{ type: "text", text: "FAIL please" }]) + "\n");
    let failed = await api<DigestResponse & { error?: string }>(node, auth, "POST", endpoint, {});
    for (const until = Date.now() + 15_000; !failed.body.error && Date.now() < until;) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      failed = await api<DigestResponse & { error?: string }>(node, auth, "POST", endpoint, {});
    }
    assert.equal(failed.status, 200);
    assert.match(failed.body.error ?? "", /model unavailable/);
    assert.equal(failed.body.digest?.turns, 3, "the last good summary is still returned");
    assert.equal((await api(node, auth, "POST", `/projects/not-a-project/conversations/${conversationId}/digest`, {})).status, 404);
  } finally {
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
