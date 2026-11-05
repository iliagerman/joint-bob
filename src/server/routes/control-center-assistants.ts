import type { NextFunction, Response } from "express";
import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { BobAssistantError, bobAsksOf, listAssistantCards, setBobMayAsk } from "../../control-center/assistants-asks.js";
// Loading the runtime registers Bob's assistants with what Bob knows before it answers.
import "../../control-center/assistants-runtime.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";

const idSchema = z.string().uuid();
const mayAskSchema = z.object({ enabled: z.boolean() }).strict();

const accountOf = (response: Response): string => (response.locals.authSession as AuthSession).accountId;

function fail(response: Response, next: NextFunction, error: unknown): void {
  if (error instanceof z.ZodError) { sendError(response, 400, "Invalid request for Bob's assistants"); return; }
  if (error instanceof BobAssistantError) { sendError(response, error.status, error.message); return; }
  next(error);
}

app.get("/api/control-center/assistants", async (_request, response, next) => {
  try {
    response.json({ assistants: await listAssistantCards(accountOf(response)) });
  } catch (error) { fail(response, next, error); }
});

app.put("/api/control-center/assistants/:id/may-ask", async (request, response, next) => {
  try {
    const { enabled } = mayAskSchema.parse(request.body);
    response.json({ assistant: await setBobMayAsk(accountOf(response), idSchema.parse(request.params.id), enabled) });
  } catch (error) { fail(response, next, error); }
});

app.get("/api/control-center/assistants/:id/asks", async (request, response, next) => {
  try {
    response.json({ asks: await bobAsksOf(accountOf(response), idSchema.parse(request.params.id)) });
  } catch (error) { fail(response, next, error); }
});
