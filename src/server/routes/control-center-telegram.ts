// Control center: telegram. Connecting Bob's own Telegram bot, from Bob's settings. Telegram's calls arrive in ../control-center-telegram.ts.
import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";
import { connectBobTelegram, disconnectBobTelegram, newBobTelegramPairing, TelegramConnectError, telegramStatus } from "../control-center-telegram.js";

const connectSchema = z.object({
  token: z.string().trim().regex(/^\d+:[A-Za-z0-9_-]{20,}$/, "That doesn't look like a bot token. Copy it from @BotFather."),
  baseId: z.string().min(1).max(200).optional(),
}).strict();

const mine = (response: { locals: Record<string, unknown> }): AuthSession => response.locals.authSession as AuthSession;

function failure(error: unknown, response: Parameters<typeof sendError>[0], next: (error: unknown) => void): void {
  if (error instanceof z.ZodError) { sendError(response, 400, error.errors.map((issue) => issue.message).join(", ")); return; }
  if (error instanceof TelegramConnectError) { sendError(response, error.status, error.message); return; }
  next(error);
}

app.get("/api/control-center/telegram", async (_request, response, next) => {
  try { response.json(await telegramStatus(mine(response).accountId)); } catch (error) { failure(error, response, next); }
});

app.post("/api/control-center/telegram", async (request, response, next) => {
  try {
    const { token, baseId } = connectSchema.parse(request.body);
    response.status(201).json(await connectBobTelegram(mine(response), token, baseId));
  } catch (error) { failure(error, response, next); }
});

app.post("/api/control-center/telegram/pairing", async (_request, response, next) => {
  try { response.json(await newBobTelegramPairing(mine(response).accountId)); } catch (error) { failure(error, response, next); }
});

app.delete("/api/control-center/telegram", async (_request, response, next) => {
  try {
    if (!await disconnectBobTelegram(mine(response).accountId)) { sendError(response, 404, "Bob has no Telegram bot"); return; }
    response.status(204).end();
  } catch (error) { failure(error, response, next); }
});
