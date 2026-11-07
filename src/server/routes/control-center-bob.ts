import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { BobActionError, runBobAction } from "../../control-center/bob-actions.js";
import { bobDatabase, countBobMessages, getBobMessage, listBobMessages, readBobSettings, writeBobSettings, type BobImportanceFilter } from "../../control-center/bob-store.js";
import { GitReviewRunError, handleBobMessage } from "../bob.js";
import { sendError } from "../http-auth.js";
import { QuickNoteLaunchError } from "../quick-note-dispatch.js";
import { fileAttachmentSchema, imageAttachmentSchema } from "../schemas.js";
import { appearanceContextSchema } from "../control-center-display.js";
import { app } from "../state.js";
// A press of a message another of the person's machines wrote is run there.
import "../control-center-bob-remote.js";

const messageSchema = z.object({
  message: z.string().trim().min(1).max(8000),
  /** The person chose the project; it is not guessed. */
  projectId: z.string().min(1).max(200).optional(),
  /** Bob only answers: no task, move, dashboard or automation starts from this message. Used for text that came from outside. */
  answerOnly: z.boolean().optional(),
  /** Pasted or picked images and files, with the same limits as a conversation's message box. */
  images: z.array(imageAttachmentSchema).max(4).optional(),
  files: z.array(fileAttachmentSchema).max(6).optional(),
  /** The page's own display settings and what it allows, so Bob's display agent can change them there. */
  appearance: appearanceContextSchema.optional(),
}).strict();

const settingsSchema = z.object({
  harnessId: z.string().max(60),
  provider: z.string().max(200),
  modelId: z.string().max(300),
  thinkingLevel: z.string().max(40),
  threshold: z.number().min(0).max(1),
  classifier: z.enum(["typesafe", "laya"]),
  monitoring: z.boolean(),
  askBeforeSaving: z.boolean(),
  autoRespond: z.enum(["bob", "always", "never"]),
  reviewCheck: z.enum(["push", "ask", "off"]),
}).partial().strict();

const querySchema = z.object({
  project: z.string().min(1).max(200).optional(),
  importance: z.enum(["important", "reports", "fyi"]).optional(),
  /** Only the items that were cleared, with why. */
  cleared: z.literal("1").optional(),
}).strict();

app.get("/api/control-center/bob/settings", async (_request, response, next) => {
  try {
    response.json(readBobSettings(await bobDatabase(), (response.locals.authSession as AuthSession).accountId));
  } catch (error) { next(error); }
});

app.put("/api/control-center/bob/settings", async (request, response, next) => {
  try {
    const change = settingsSchema.parse(request.body);
    response.json(writeBobSettings(await bobDatabase(), (response.locals.authSession as AuthSession).accountId, change));
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid settings for Bob"); return; }
    next(error);
  }
});

app.get("/api/control-center/bob/messages", async (request, response, next) => {
  try {
    const query = querySchema.parse(request.query);
    const session = response.locals.authSession as AuthSession;
    const db = await bobDatabase();
    response.json({
      messages: listBobMessages(db, session.accountId, { project: query.project, importance: query.importance, cleared: query.cleared === "1" }),
      waiting: countBobMessages(db, session.accountId, "important" as BobImportanceFilter),
    });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid filter"); return; }
    next(error);
  }
});

app.post("/api/control-center/bob/action", async (request, response, next) => {
  try {
    const { messageId, actionId } = z.object({ messageId: z.string().min(1).max(100), actionId: z.string().min(1).max(100) }).strict().parse(request.body);
    const session = response.locals.authSession as AuthSession;
    const db = await bobDatabase();
    const messages = await runBobAction(db, session, messageId, actionId);
    // The pressed item as it is now: cleared, or (a button that only opens something) still waiting with its buttons.
    response.json({ messages, pressed: getBobMessage(db, session.accountId, messageId) });
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid action"); return; }
    if (error instanceof BobActionError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

app.post("/api/control-center/bob/message", async (request, response, next) => {
  try {
    const input = messageSchema.parse(request.body);
    response.json(await handleBobMessage(response.locals.authSession as AuthSession, input));
  } catch (error) {
    if (error instanceof z.ZodError) { sendError(response, 400, "Invalid message for Bob"); return; }
    if (error instanceof GitReviewRunError || error instanceof QuickNoteLaunchError) { sendError(response, error.status, error.message); return; }
    next(error);
  }
});

