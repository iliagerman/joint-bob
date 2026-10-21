import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { coveredMessages, digestIsStale, digestMaterial, digestMessages, digestPrompt, parseDigestAnswer, turnCount, type ConversationDigest, type DigestMessage } from "../src/conversation-digest.js";
import { routedSummaryModel } from "../src/server/conversation-digest-runner.js";
import { claudeProjectDir } from "../src/session-paths.js";
import { api, projectNamed, seedDevEnvironment, signIn, startDevNode, stopDevNode } from "./dev-nodes.js";

const user = (text: string): DigestMessage => ({ role: "user", text });
const agent = (text: string): DigestMessage => ({ role: "assistant", text });
const digest = (fields: Partial<ConversationDigest>): ConversationDigest => ({ summary: "s", turns: 1, updatedAt: "", ...fields });

test("the summary reads only what was said, and waits for a prompt's answer", () => {
  const said = digestMessages([
    { role: "user", text: "Rotate the certificates" },
    { role: "assistant", text: "Checking." },
    { role: "toolResult", text: "staging.pem" },
    { role: "assistant", text: "  " },
    { role: "assistant", text: "Rotated." },
    { role: "user", text: "Now production" },
  ]);
  assert.deepEqual(said, [user("Rotate the certificates"), agent("Checking."), agent("Rotated.")], "tool output, blanks and an unanswered prompt are left out");
  assert.equal(turnCount(said), 1);
});

test("a summary covers a count of messages, and one from before counts restarts at its last turn", () => {
  const said = [user("a"), agent("1"), user("b"), agent("2"), agent("3")];
  assert.equal(coveredMessages(undefined, said), 0);
  assert.equal(coveredMessages(digest({ messages: 4 }), said), 4);
  assert.equal(coveredMessages(digest({ messages: 9 }), said), 0, "a transcript shorter than the summary starts over");
  assert.equal(coveredMessages(digest({ turns: 2 }), said), 2, "a summary written by turns rereads its last turn");
  assert.equal(digestIsStale(digest({ messages: 5 }), said), false);
  assert.equal(digestIsStale(digest({ messages: 4 }), said), true);
  assert.equal(digestIsStale(undefined, []), false, "an empty conversation has nothing to summarize");
});

test("the writer gets only the messages after the summary, newest first when they do not all fit", () => {
  const said = [user("fix the build"), agent("Done."), user("now ship it"), agent("Shipped.")];
  assert.equal(digestMaterial(said, 2), "User: now ship it\n\nAssistant: Shipped.");

  const long = [user("the opening request"), ...Array.from({ length: 30 }, (_, index) => agent(`step ${index} ${"x".repeat(5_000)}`))];
  const bounded = digestMaterial(long, 0);
  assert.ok(bounded.length < 70_000, `material stays bounded (${bounded.length})`);
  assert.match(bounded, /^First request — User: the opening request\n\n\(\d+ earlier messages omitted for length\)/, "a first summary keeps the opening request");
  assert.match(bounded, /Assistant: step 29 /, "the newest message is always kept");

  const running = digestMaterial([user("ship it"), agent(`started the build ${"x".repeat(20_000)} now waiting for review`)], 0);
  assert.match(running, /Assistant: started the build x+ … x+ now waiting for review$/, "a long answer keeps its opening and where it got to");
});

test("the prompt folds new messages into the current summary and keeps the panel narrow", () => {
  assert.doesNotMatch(digestPrompt(undefined), /Current summary:/);
  assert.match(digestPrompt("**Goal** — ship it"), /Fold the new messages into the summary[\s\S]*Current summary:\n\*\*Goal\*\* — ship it$/);
  assert.match(digestPrompt(undefined), /No headings, code blocks, tables, raw JSON or long file paths/);
  assert.equal(parseDigestAnswer("```markdown\n**Goal** — x\n```"), "**Goal** — x");
  assert.equal(parseDigestAnswer("  plain  "), "plain");
});

test("the routing classifier's tier writes the summary only when it is sure and the model is allowed", () => {
  const levels = { "2": { provider: "anthropic", modelId: "haiku", thinkingLevel: "low", description: "easy" }, "8": { modelId: "opus", thinkingLevel: "high", description: "hard" } };
  const own = { harnessId: "claude", provider: "claude", modelId: "sonnet" };
  const sure = { level: 2, score: 2, confidence: 0.9 };
  assert.deepEqual(routedSummaryModel(levels, sure, 0.5, own), { harnessId: "claude", provider: "anthropic", modelId: "haiku", thinkingLevel: "low", source: "classifier" });
  assert.deepEqual(routedSummaryModel(levels, { level: 8, score: 8, confidence: 0.9 }, 0.5, own, "claude")?.provider, "claude", "a harness with a fixed provider keeps it");
  assert.equal(routedSummaryModel(levels, { ...sure, confidence: 0.3 }, 0.5, own), null, "an unsure classifier leaves the conversation's model");
  assert.equal(routedSummaryModel(levels, { ...sure, abstained: true }, 0.5, own), null);
  assert.equal(routedSummaryModel(levels, { level: 5, score: 5, confidence: 0.9 }, 0.5, own), null, "an unmapped level leaves the conversation's model");
  assert.equal(routedSummaryModel({ "2": { provider: "openai-codex", modelId: "gpt-5.6-mini", thinkingLevel: "low", description: "easy" } }, sure, 0.5, own), null, "a model routing may not pick is not used");
  assert.equal(routedSummaryModel(levels, null, 0.5, own), null);
});

test("the digest route folds new messages into the summary and follows the node's writer policy", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "joint-bob-digest-"));
  const generator = path.join(root, "digest-generator.mjs");
  const calls = path.join(root, "calls.jsonl");
  await writeFile(generator, `import { appendFile } from "node:fs/promises";\nexport default async (input) => { if (input.material.includes("FAIL please")) throw new Error("model unavailable"); await appendFile(${JSON.stringify(calls)}, JSON.stringify(input) + "\\n"); return "\`\`\`markdown\\n**Goal** — summary " + input.material.split("\\n\\n").length + "\\n\`\`\`"; };\n`);
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
  const callsMade = async () => (await readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  type DigestResponse = { digest: ConversationDigest | null; stale: boolean; turns?: number; error?: string; policy?: { updates: string; writer: string; from: string } };
  const auth = await signIn(environment, node);
  const endpoint = `/projects/${project.id}/conversations/${conversationId}/digest`;
  /** Appends records, then waits until the conversation listing has noticed them. */
  const append = async (lines: string[]) => {
    await appendFile(transcript, lines.join("\n") + "\n");
    for (const until = Date.now() + 15_000; Date.now() < until;) {
      if ((await api<DigestResponse>(node, auth, "GET", endpoint)).body.stale) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };
  try {
    const before = await api<DigestResponse>(node, auth, "GET", endpoint);
    assert.equal(before.status, 200);
    assert.deepEqual([before.body.digest, before.body.stale, before.body.turns], [null, true, 1]);
    assert.deepEqual(before.body.policy, { updates: "each-message", writer: "automatic", from: "this machine" }, "by default summaries follow each message, written automatically");

    // Automatic without a routing classifier: the conversation's own agent and model, as the page reports them.
    const sonnet = { harnessId: "claude", provider: "claude", modelId: "sonnet" };
    const first = await api<DigestResponse>(node, auth, "POST", endpoint, { conversation: sonnet });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.digest?.summary, "**Goal** — summary 2", "the answer's code fence is removed");
    assert.deepEqual([first.body.digest?.turns, first.body.digest?.messages], [1, 2]);
    assert.deepEqual(first.body.digest?.model, { ...sonnet, source: "conversation" });
    const [firstCall] = await callsMade();
    assert.equal(firstCall.material, "User: Rotate the staging certificates\n\nAssistant: Rotated staging.pem.", "only what was said, never tool output");
    assert.doesNotMatch(firstCall.instructions, /Current summary:/);
    assert.deepEqual(firstCall.run, { ...sonnet, thinkingLevel: "", source: "conversation" });

    assert.equal((await api<DigestResponse>(node, auth, "GET", endpoint)).body.stale, false);
    const again = await api<DigestResponse>(node, auth, "POST", endpoint, {});
    assert.equal(again.body.digest?.updatedAt, first.body.digest?.updatedAt, "an up-to-date summary is not rewritten");
    assert.equal((await callsMade()).length, 1);

    // The next update gets the current summary and only the new messages.
    await append([record("user", 4, [{ type: "text", text: "Now production" }]), record("assistant", 5, [{ type: "text", text: "Production rotated too." }])]);
    const second = await api<DigestResponse>(node, auth, "POST", endpoint, {});
    assert.deepEqual([second.body.digest?.turns, second.body.digest?.messages], [2, 4]);
    const secondCall = (await callsMade())[1];
    assert.match(secondCall.instructions, /Current summary:\n\*\*Goal\*\* — summary 2$/);
    assert.equal(secondCall.material, "User: Now production\n\nAssistant: Production rotated too.", "messages already summarized are not sent again");
    assert.deepEqual(secondCall.run, { harnessId: "claude", provider: "", modelId: "", thinkingLevel: "", source: "conversation" }, "without the page's report, the transcript's agent writes it");

    // The node's admin can name the writer; it applies whatever the conversation runs on.
    const fixed = { updates: "each-message", writer: { source: "fixed", harnessId: "pi", modelId: "gpt-test", thinkingLevel: "low" } };
    assert.equal((await api(node, auth, "PUT", "/conversation-summary/settings", fixed)).status, 200);
    const settings = await api<{ node: unknown; effective: { view: { writer: string; from: string } }; relayServing: unknown }>(node, auth, "GET", "/conversation-summary/settings");
    assert.deepEqual(settings.body.node, fixed);
    assert.deepEqual(settings.body.effective.view, { updates: "each-message", writer: "gpt-test", from: "this machine" });
    assert.equal(settings.body.relayServing, null, "a machine that serves no relay has no relay policy to publish");
    assert.equal((await api(node, auth, "PUT", "/conversation-summary/settings", { updates: "hourly", writer: { source: "automatic" } })).status, 400);
    await append([record("user", 6, [{ type: "text", text: "And the CA" }]), record("assistant", 7, [{ type: "text", text: "CA rotated." }])]);
    const third = await api<DigestResponse>(node, auth, "POST", endpoint, { conversation: sonnet });
    assert.equal(third.body.digest?.turns, 3);
    assert.deepEqual((await callsMade())[2].run, { harnessId: "pi", provider: "", modelId: "gpt-test", thinkingLevel: "low", source: "setting" });
    assert.equal((await api(node, auth, "POST", endpoint, { conversation: { harnessId: "not-a-harness" } })).status, 400, "the reported model is validated");
    assert.equal((await api(node, auth, "PUT", "/conversation-summary/settings", { updates: "each-message", writer: { source: "automatic" } })).status, 200);

    const unstarted = await api<DigestResponse>(node, auth, "GET", `/projects/${project.id}/conversations/00000000-0000-4000-8000-000000000000/digest`);
    assert.deepEqual([unstarted.status, unstarted.body.digest, unstarted.body.stale, unstarted.body.turns], [200, null, false, 0], "a conversation with no transcript yet simply has no summary");
    assert.equal((await api(node, auth, "POST", `/projects/${project.id}/conversations/00000000-0000-4000-8000-000000000000/digest`, {})).status, 404);

    // A model that fails leaves the stored summary in place and says why.
    await append([record("user", 8, [{ type: "text", text: "FAIL please" }]), record("assistant", 9, [{ type: "text", text: "Trying." }])]);
    const failed = await api<DigestResponse>(node, auth, "POST", endpoint, {});
    assert.equal(failed.status, 200);
    assert.match(failed.body.error ?? "", /model unavailable/);
    assert.equal(failed.body.digest?.turns, 3, "the last good summary is still returned");
    assert.equal((await api(node, auth, "POST", `/projects/not-a-project/conversations/${conversationId}/digest`, {})).status, 404);
  } finally {
    await stopDevNode(server);
    await rm(root, { recursive: true, force: true });
  }
});
