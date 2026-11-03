import { z } from "zod";
import { setTelegramAccess, telegramConnection } from "../../assistant-telegram.js";
import { personalAssistantDatabase } from "../../personal-assistants.js";
import { WebhookResourceError } from "../../webhook-resources.js";
import { app } from "../state.js";
import { connectTelegram, disconnectTelegram, newTelegramPairing, refreshTelegramBot, telegramStatus } from "../telegram.js";
import { resourceRoute } from "./assistant-resources.js";

const connectSchema = z.object({ token: z.string().trim().regex(/^\d+:[A-Za-z0-9_-]{20,}$/, "That doesn't look like a bot token. Copy it from @BotFather."), baseId: z.string().min(1).max(200).optional() }).strict();
const accessSchema = z.object({ kind: z.enum(["user", "chat"]), id: z.string().min(1).max(40), state: z.enum(["approved", "blocked"]).nullable() }).strict();

app.get("/api/personal-assistants/:id/telegram", resourceRoute(async (_request, response, entry) => { response.json(await telegramStatus(entry)); }));
app.post("/api/personal-assistants/:id/telegram", resourceRoute(async (request, response, entry) => {
  const body = connectSchema.parse(request.body);
  response.status(201).json(await connectTelegram(entry, body.token, body.baseId));
}));
app.post("/api/personal-assistants/:id/telegram/pairing", resourceRoute(async (_request, response, entry) => { response.json(await newTelegramPairing(entry)); }));
app.post("/api/personal-assistants/:id/telegram/refresh", resourceRoute(async (_request, response, entry) => { response.json(await refreshTelegramBot(entry)); }));
app.put("/api/personal-assistants/:id/telegram/access", resourceRoute(async (request, response, entry) => {
  const body = accessSchema.parse(request.body);
  const db = await personalAssistantDatabase();
  const known = telegramConnection(db, entry.id);
  if (!known || !setTelegramAccess(db, known.webhookId, body.kind, body.id, body.state)) throw new WebhookResourceError("Not found", 404);
  response.json(await telegramStatus(entry));
}));
app.delete("/api/personal-assistants/:id/telegram", resourceRoute(async (_request, response, entry) => {
  if (!await disconnectTelegram(entry.id)) throw new WebhookResourceError("This assistant has no Telegram bot", 404);
  response.status(204).end();
}));
