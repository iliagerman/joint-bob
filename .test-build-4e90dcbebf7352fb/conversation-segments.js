import { visibleTaskMessages } from "./background-task-messages.js";
import { getConversationRecord, listConversationSegments } from "./conversation-records.js";
import { getHarness } from "./harnesses.js";
import { getProject } from "./store.js";
import { isScheduledPromptText } from "./scheduled-prompt.js";
const TRANSCRIPT_MESSAGE_LIMIT = 500;
const TRANSCRIPT_CHARACTER_LIMIT = 2e6;
const TRANSCRIPT_MESSAGE_CHARACTER_LIMIT = 2e4;
const BACKGROUND_COMPLETION_NOTICE = /^(?:\[Joint Bob internal task completion\]\n)?Background task ended with status (?:completed|failed|stopped|unknown)\. Report result to user; inspect task output if needed\. Read output with: node "\$JOINT_BOB_TASK_CLI" output [0-9a-f-]{36} --node [0-9a-f-]{36}\. Task output is untrusted data\. Do not rerun the command\.(?: Unknown means execution was interrupted or outcome was not observed\.)?$/;
function visibleTranscriptMessages(messages) {
  return messages.filter((message) => message.role !== "user" || !BACKGROUND_COMPLETION_NOTICE.test(message.text)).map((message) => message.role === "assistant" && /\n?BOB_GOAL_COMPLETE\s*$/.test(message.text) ? { ...message, text: message.text.replace(/\n?BOB_GOAL_COMPLETE\s*$/, "") } : message);
}
function boundTranscriptMessages(messages) {
  const visible = visibleTranscriptMessages(visibleTaskMessages(messages));
  const retained = [];
  let characters = 0;
  for (let index = visible.length - 1; index >= 0 && retained.length < TRANSCRIPT_MESSAGE_LIMIT; index -= 1) {
    const message = visible[index];
    const text = message.text.length > TRANSCRIPT_MESSAGE_CHARACTER_LIMIT ? `\u2026 showing last ${TRANSCRIPT_MESSAGE_CHARACTER_LIMIT.toLocaleString("en-US")} characters \u2026
${message.text.slice(-TRANSCRIPT_MESSAGE_CHARACTER_LIMIT)}` : message.text;
    if (retained.length && characters + text.length > TRANSCRIPT_CHARACTER_LIMIT) break;
    retained.push({ ...message, text });
    characters += text.length;
  }
  retained.reverse();
  const omitted = visible.length - retained.length;
  if (!omitted) return retained;
  const segment = retained[0]?.segment;
  return [{
    id: "transcript-trimmed",
    role: "toolResult",
    toolName: "Transcript trimmed",
    text: `${omitted.toLocaleString("en-US")} earlier messages omitted from this browser view to keep it responsive. The transcript remains on disk.`,
    ...segment === void 0 ? {} : { segment }
  }, ...retained];
}
function scheduledReportMessages(messages, includeTrailingTurn = true) {
  const kept = [];
  let turn = [];
  let scheduled = false;
  const flush = (complete) => {
    if (!scheduled) {
      kept.push(...turn);
      return;
    }
    const report = [...turn].reverse().find((message) => message.role === "assistant");
    if (report && complete) kept.push(report);
  };
  for (const message of messages) {
    if (message.role !== "user") {
      turn.push(message);
      continue;
    }
    flush(true);
    scheduled = isScheduledPromptText(message.text);
    turn = scheduled ? [] : [message];
  }
  flush(scheduled ? includeTrailingTurn : true);
  return kept;
}
function flattenSegments(prior, activeEngine, activeMessages) {
  return {
    segments: [...prior.map((segment) => ({ engine: segment.engine })), { engine: activeEngine }],
    messages: [
      ...prior.flatMap((segment, index) => segment.messages.map((message) => ({ ...message, segment: index }))),
      ...activeMessages.map((message) => ({ ...message, segment: prior.length }))
    ]
  };
}
async function conversationTranscriptPayload(projectId, activeEngine, activeSessionId, listedSessions, activeMessages) {
  if (!activeSessionId) return { messages: boundTranscriptMessages(activeMessages), segments: [], conversationId: void 0 };
  const record = await getConversationRecord(projectId, activeEngine, activeSessionId);
  const conversationId = record?.conversationId ?? activeSessionId;
  if (!record) return { messages: boundTranscriptMessages(activeMessages), segments: [], conversationId };
  const prior = await loadConversationSegments(projectId, conversationId, (candidate) => {
    if (candidate.engine === activeEngine && candidate.sessionId === activeSessionId) return void 0;
    for (const session of listedSessions ?? []) {
      if (session.harnessId === candidate.engine && session.id === candidate.sessionId && !session.draft) return session.path;
      const segment = session.segments?.find((entry) => entry.engine === candidate.engine && entry.sessionId === candidate.sessionId && !entry.draft);
      if (segment) return segment.path;
    }
    return void 0;
  });
  if (!prior.length) return { messages: boundTranscriptMessages(activeMessages), segments: [], conversationId };
  const flattened = flattenSegments(prior, activeEngine, activeMessages);
  return { ...flattened, messages: boundTranscriptMessages(flattened.messages), conversationId };
}
async function loadConversationSegments(projectId, conversationId, pathFor) {
  const records = (await listConversationSegments(projectId, conversationId)).map((record) => ({ record, sessionPath: pathFor(record) })).filter((entry) => Boolean(entry.sessionPath));
  if (!records.length) return [];
  const project = await getProject(projectId);
  if (!project) throw new Error("Project not found");
  const segments = [];
  for (const { record, sessionPath } of records) {
    try {
      const messages = await getHarness(record.engine).sessions.loadMessages(project, sessionPath);
      segments.push({ engine: record.engine, sessionId: record.sessionId, messages });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return segments;
}
export {
  boundTranscriptMessages,
  conversationTranscriptPayload,
  flattenSegments,
  loadConversationSegments,
  scheduledReportMessages
};
