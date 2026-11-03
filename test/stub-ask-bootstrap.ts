// Test-only stand-ins for both ends of an ask on a dev node, which has no agent that can finish an
// assistant turn. startDevNode preloads this file when JOINT_BOB_TEST_ASK_LOG is set; nothing in src/ reads it.
// - JOINT_BOB_TEST_ASK_PROMPT ({ projectId, conversationId, requestId }) is the asking turn's prompt,
//   marked as running the way harness-chat marks a prompt while it runs.
// - Each helper turn writes its ask id as a line to JOINT_BOB_TEST_ASK_LOG, then answers with
//   JOINT_BOB_TEST_ASK_ANSWER, or never answers when the question starts with "[hold]".
import { appendFile } from "node:fs/promises";

if (process.env.NODE_ENV !== "test" || !process.env.JOINT_BOB_TEST_ASK_LOG) throw new Error("The ask stub requires NODE_ENV=test and JOINT_BOB_TEST_ASK_LOG");
const log = process.env.JOINT_BOB_TEST_ASK_LOG;

const { promptStarted } = await import("../src/assistant-collaboration/bridge-tools.js");
if (process.env.JOINT_BOB_TEST_ASK_PROMPT) {
  const prompt = JSON.parse(process.env.JOINT_BOB_TEST_ASK_PROMPT) as { projectId: string; conversationId: string; requestId: string };
  promptStarted(prompt.projectId, prompt.conversationId, prompt.requestId);
}

// ask.ts reaches modules that register routes when they load, so it is imported only once the
// server has registered its own and listens.
const { server } = await import("../src/server/state.js");
server.once("listening", () => {
  void import("../src/assistant-collaboration/ask.js").then(({ setAskTurnRunner }) => setAskTurnRunner(async (_accountId, _helperId, requestId, message) => {
    await appendFile(log, `${requestId}\n`);
    if (message.startsWith("[hold]")) await new Promise(() => {});
    return { requestId, topicId: "pi:stub-helper-topic", message, response: process.env.JOINT_BOB_TEST_ASK_ANSWER ?? "", status: "completed", createdAt: new Date().toISOString() };
  }));
});
