import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { chatDefaults, chatDefaultsSchema, chatModelSchema, chatState, clearChatHistory, saveChatDefaults, saveChatState, type ChatScope } from "../../conversation-chat.js";
import { getProject, projectVisible } from "../../store.js";
import { chatChanged, chatRunning, chatStream, startChatQueue } from "../conversation-chat-runner.js";
import { GitReviewRunError } from "../git-review-run.js";
import { sendError } from "../http-auth.js";
import { registeredHarnessIdSchema } from "../schemas.js";
import { listReviewScopeSessions } from "../sessions-helpers.js";
import { app } from "../state.js";

const modelSchema = chatModelSchema.extend({ harnessId: registeredHarnessIdSchema });
const questionSchema = z.object({ id: z.string().uuid().optional(), question: z.string().trim().min(1).max(40_000), model: modelSchema.nullable(), readOnly: z.boolean().optional() }).strict();
const modeSchema = z.object({ readOnly: z.boolean() }).strict();
const defaultsSchema = chatDefaultsSchema.extend({ model: modelSchema.nullable() });
const endpoint = "/api/projects/:projectId/conversations/:conversationId/chat";

app.get("/api/conversation-chat/settings", (_request, response) => {
  response.json(chatDefaults((response.locals.authSession as AuthSession).userId));
});
app.put("/api/conversation-chat/settings", (request, response, next) => {
  try {
    const value = defaultsSchema.parse(request.body);
    saveChatDefaults((response.locals.authSession as AuthSession).userId, value);
    response.json(value);
  } catch (error) { next(error); }
});

/** Check visibility before any history access or transcript read. */
async function authorizedConversation(projectId: string, conversationId: string, auth: AuthSession) {
  const project = await getProject(projectId);
  if (!project || !await projectVisible(project.id)) throw new GitReviewRunError(404, "Project not found");
  const sessions = await listReviewScopeSessions(project, auth.userId, auth.accountId);
  if (!sessions.some((session) => (session.conversationId ?? session.id) === conversationId)) {
    throw new GitReviewRunError(404, "Conversation not found");
  }
  return project;
}

for (const method of ["get", "post", "patch", "delete"] as const) {
  app[method](endpoint, async (request, response, next) => {
    const auth = response.locals.authSession as AuthSession;
    const { projectId, conversationId } = request.params;
    const scope: ChatScope = { userId: auth.userId, projectId, conversationId };
    try {
      const project = await authorizedConversation(projectId, conversationId, auth);
      if (method === "get") {
        startChatQueue(project, scope, auth.accountId);
        response.json({ ...chatState(scope), defaults: chatDefaults(auth.userId), busy: chatRunning(scope), stream: chatStream(scope) });
        return;
      }
      if (method === "patch") {
        const { readOnly } = modeSchema.parse(request.body);
        if (chatRunning(scope) || chatState(scope).queue.length) throw new GitReviewRunError(409, "Wait for Activity Chat to finish before changing its permissions");
        const state = chatState(scope);
        state.readOnly = readOnly;
        saveChatState(scope, state);
        chatChanged(scope, auth.accountId);
        response.json(state);
        return;
      }
      if (method === "delete") {
        if (chatRunning(scope) || chatState(scope).queue.length) throw new GitReviewRunError(409, "A side-chat answer is still running");
        clearChatHistory(scope);
        chatChanged(scope, auth.accountId);
        response.json(chatState(scope));
        return;
      }
      const payload = questionSchema.parse(request.body);
      const id = payload.id ?? randomUUID();
      const state = chatState(scope);
      if (!state.queue.some((question) => question.id === id) && !state.messages.some((message) => message.id === id)) {
        state.queue.push({ id, question: payload.question, model: payload.model, readOnly: payload.readOnly ?? state.readOnly });
        state.model = payload.model;
        saveChatState(scope, state);
      }
      startChatQueue(project, scope, auth.accountId);
      chatChanged(scope, auth.accountId);
      response.status(202).json({ ...chatState(scope), busy: chatRunning(scope) });
    } catch (error) {
      if (error instanceof GitReviewRunError) sendError(response, error.status, error.message);
      else next(error);
    }
  });
}
