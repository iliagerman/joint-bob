import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { chatDefaults, chatDefaultsSchema, chatModelSchema, chatState, clearChatHistory, conversationChatPrompt, saveChatDefaults, saveChatState, type ChatScope } from "../../conversation-chat.js";
import { getSettings } from "../../settings.js";
import { getProject, projectVisible } from "../../store.js";
import type { HarnessId } from "../../types.js";
import { loadConversationMessages } from "../conversation-turns.js";
import { GitReviewRunError, runGitReview } from "../git-review-run.js";
import { sendError } from "../http-auth.js";
import { registeredHarnessIdSchema } from "../schemas.js";
import { listReviewScopeSessions } from "../sessions-helpers.js";
import { app } from "../state.js";

const modelSchema = chatModelSchema.extend({ harnessId: registeredHarnessIdSchema });
const questionSchema = z.object({ question: z.string().trim().min(1).max(40_000), model: modelSchema.nullable() }).strict();
const defaultsSchema = chatDefaultsSchema.extend({ model: modelSchema.nullable() });
const endpoint = "/api/projects/:projectId/conversations/:conversationId/chat";
const running = new Set<string>();

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

for (const method of ["get", "post", "delete"] as const) {
  app[method](endpoint, async (request, response, next) => {
    const auth = response.locals.authSession as AuthSession;
    const { projectId, conversationId } = request.params;
    const scope: ChatScope = { userId: auth.userId, projectId, conversationId };
    const key = JSON.stringify(scope);
    let locked = false;
    try {
      const project = await authorizedConversation(projectId, conversationId, auth);
      if (method === "get") {
        response.json({ ...chatState(scope), defaults: chatDefaults(auth.userId), busy: running.has(key) });
        return;
      }
      if (running.has(key)) throw new GitReviewRunError(409, "A side-chat answer is still running");
      if (method === "delete") {
        clearChatHistory(scope);
        response.json(chatState(scope));
        return;
      }
      const payload = questionSchema.parse(request.body);
      running.add(key);
      locked = true;
      const { messages, lastHarness } = await loadConversationMessages(project, conversationId);
      const state = chatState(scope);
      const attribution = [...messages].reverse().find((message) => message.role === "assistant" && message.attribution)?.attribution;
      const model = payload.model ?? {
        harnessId: attribution?.harnessId ?? lastHarness, provider: attribution?.provider ?? "", modelId: attribution?.modelId ?? "",
      };
      const instructions = conversationChatPrompt(messages, state.messages, payload.question);
      state.messages.push({ role: "user", text: payload.question });
      state.model = model;
      saveChatState(scope, state);
      const result = await runGitReview({
        projectId, cwd: getSettings().projects.homePath, harnessId: model.harnessId as HarnessId,
        provider: model.provider, modelId: model.modelId, thinkingLevel: "",
        selection: { scope: "context", label: "conversation" }, question: "", diff: "", instructions,
        useTools: false,
      });
      state.messages.push({ role: "assistant", text: result.answer });
      state.model = { harnessId: model.harnessId, provider: result.provider, modelId: result.modelId };
      saveChatState(scope, state);
      response.json(state);
    } catch (error) {
      if (error instanceof GitReviewRunError) sendError(response, error.status, error.message);
      else next(error);
    } finally {
      if (locked) running.delete(key);
    }
  });
}
