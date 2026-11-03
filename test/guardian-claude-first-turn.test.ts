import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { api, seedDevEnvironment, signIn, startDevNode, stopDevNode, type SeededNode, type SignedIn } from "./dev-nodes.js";
import { guardianAskSettings, guardianDecisionModel, installGuardianClaude } from "./guardian-claude-fixture.js";
import { temporaryRoot, waitFor } from "./queued-prompt-harness.js";

type Frame = Record<string, unknown>;
interface Review { id: string; conversationId: string; title: string; subject: string }

/** A conversation socket as the page opens it: a new Claude conversation names a fresh id. */
function openConversation(node: SeededNode, session: SignedIn, projectId: string, sessionPath: string, sessionId: string): { socket: WebSocket; frames: Frame[] } {
  const url = new URL("/ws", node.url);
  url.protocol = "ws:";
  url.searchParams.set("projectId", projectId);
  url.searchParams.set("sessionPath", sessionPath);
  url.searchParams.set("sessionId", sessionId);
  url.searchParams.set("nodeId", node.nodeId);
  const socket = new WebSocket(url, { origin: node.url, headers: { Cookie: session.cookie } });
  const frames: Frame[] = [];
  socket.on("message", (raw) => frames.push(JSON.parse(raw.toString()) as Frame));
  return { socket, frames };
}

const openReviews = (frames: Frame[]): Review[] | undefined => {
  const last = frames.filter((frame) => frame.type === "guardianReviews").at(-1);
  return last ? last.reviews as Review[] : undefined;
};

test("a Guardian review raised on a new Claude conversation's first turn reaches its page and outlives a reconnect", { timeout: 120_000 }, async () => {
  const root = await temporaryRoot("guardian-claude-first-");
  const model = await guardianDecisionModel();
  const sockets: WebSocket[] = [];
  let child: Awaited<ReturnType<typeof startDevNode>> | undefined;
  try {
    const environment = await seedDevEnvironment(root, 1);
    const node = environment.nodes[0];
    const project = node.projects[0];
    const capture = path.join(root, "claude-runs.jsonl");
    await installGuardianClaude(root, node, capture);
    child = await startDevNode(environment, node);
    const session = await signIn(environment, node);
    assert.equal((await api(node, session, "PUT", "/guardian", { settings: guardianAskSettings(model) })).status, 200);

    // A tool call on the first turn, through Claude's hook.
    const sessionId = randomUUID();
    const page = openConversation(node, session, project.id, "claude:new", sessionId);
    sockets.push(page.socket);
    await waitFor(page.frames, () => page.frames.some((frame) => frame.type === "ready"));
    const ready = page.frames.find((frame) => frame.type === "ready")!;
    page.socket.send(JSON.stringify({ type: "prompt", message: "Please delete the 2023 exports" }));
    await waitFor(page.frames, () => Boolean(openReviews(page.frames)?.length), 30_000);
    const [review] = openReviews(page.frames)!;
    assert.equal(review.conversationId, ready.conversationId, `the review is filed under the conversation the page has open (${String(ready.conversationId)}), not ${review.conversationId}`);
    assert.equal(review.subject, "rm -rf exports/2023");

    // A reload while it waits, by the transcript path the page switched to when Claude reported it:
    // the new socket's ready message still carries the review.
    const sessionFile = page.frames.find((frame) => frame.type === "sessionFile")?.sessionFile;
    assert.equal(typeof sessionFile, "string", "Claude reported its transcript before asking Guardian");
    const reloaded = openConversation(node, session, project.id, sessionFile as string, sessionId);
    sockets.push(reloaded.socket);
    await waitFor(reloaded.frames, () => reloaded.frames.some((frame) => frame.type === "ready"));
    assert.deepEqual((reloaded.frames.find((frame) => frame.type === "ready")!.guardianReviews as Review[]).map(({ id }) => id), [review.id], "a reconnect while a review waits must not clear it");
    assert.deepEqual(openReviews(page.frames)?.map(({ id }) => id), [review.id], "the first window still shows it");

    reloaded.socket.send(JSON.stringify({ type: "guardianDecision", reviewId: review.id, decision: "block" }));
    await waitFor(page.frames, () => openReviews(page.frames)?.length === 0, 20_000);
    await waitFor(page.frames, () => page.frames.some((frame) => frame.type === "agent_end"), 20_000);
    const runs = (await readFile(capture, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { sessionId: string; verdict: { action: string } | null });
    assert.equal(runs.at(-1)?.verdict?.action, "block", "the person's Block reaches Claude");

    // A key in the first message of another new conversation, checked before Claude starts.
    const second = randomUUID();
    const keyed = openConversation(node, session, project.id, "claude:new", second);
    sockets.push(keyed.socket);
    await waitFor(keyed.frames, () => keyed.frames.some((frame) => frame.type === "ready"));
    const keyedReady = keyed.frames.find((frame) => frame.type === "ready")!;
    keyed.socket.send(JSON.stringify({ type: "prompt", message: "Check staging with AKIAABCDEFGHIJKLMNOP" }));
    await waitFor(keyed.frames, () => Boolean(openReviews(keyed.frames)?.length), 30_000);
    const [keyReview] = openReviews(keyed.frames)!;
    assert.equal(keyReview.conversationId, keyedReady.conversationId);
    keyed.socket.send(JSON.stringify({ type: "guardianDecision", reviewId: keyReview.id, decision: "allow" }));
    await waitFor(keyed.frames, () => keyed.frames.some((frame) => frame.type === "agent_end"), 20_000);
  } finally {
    for (const socket of sockets) socket.terminate();
    if (child) await stopDevNode(child);
    model.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  }
});
