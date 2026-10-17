import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { getClusterNode } from "../../cluster.js";
import { sharedProjectSessions } from "../sessions-helpers.js";
import { getProject, projectVisible } from "../../store.js";
import { deleteItem, deletePersonalAssistant, getPersonalAssistant, listPersonalAssistants, listSavedItems, saveItem, savedImage, savePersonalAssistant } from "../../personal-assistants.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";

const profileSchema = z.object({
  projectId: z.string().min(1).max(200), engine: z.string().min(1).max(50),
  sessionId: z.string().min(1).max(300), name: z.string().trim().min(1).max(100),
  instructions: z.string().max(20000), allowBrowser: z.boolean().optional(), allowTerminal: z.boolean().optional(),
  mcpServerNames: z.array(z.string().min(1).max(200)).max(100).optional(),
}).strict();
const itemSchema = z.object({
  collection: z.string().trim().min(1).max(100), title: z.string().trim().min(1).max(300),
  url: z.string().url().max(4096)
    .refine(value => /^https?:\/\//i.test(value), "Use an HTTP(S) link")
    .refine(value => { const parsed = new URL(value); return !parsed.username && !parsed.password; }, "Remove credentials from the link").nullable(),
  note: z.string().max(10000), images: z.array(z.object({ name: z.string().min(1).max(255), mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]), data: z.string().min(1).max(14000000) }).strict()).max(4),
}).strict();
function actor(response: { locals: { authSession?: AuthSession } }): string { return response.locals.authSession!.accountId; }
async function visible(accountId: string, id: string) {
  const entry = await getPersonalAssistant(accountId, id);
  return entry && await projectVisible(entry.projectId) ? entry : undefined;
}
app.get("/api/personal-assistants", async (_request, response, next) => {
  try {
    const entries = await listPersonalAssistants(actor(response));
    response.json({ assistants: (await Promise.all(entries.map(async entry => await projectVisible(entry.projectId) ? entry : undefined))).filter(Boolean) });
  } catch (error) { next(error); }
});
app.post("/api/personal-assistants", async (request, response, next) => {
  try {
    const input = profileSchema.parse(request.body);
    const project = await getProject(input.projectId);
    if (!project || !await projectVisible(project.id)) { sendError(response, 404, "Conversation not found"); return; }
    const session = response.locals.authSession as AuthSession;
    const local = (await getClusterNode()).id;
    const listed = (await sharedProjectSessions(project, session.userId, session.accountId, true)).find(entry => entry.harnessId === input.engine && entry.id === input.sessionId);
    if (!listed) { sendError(response, 404, "Conversation not found"); return; }
    if (listed.executionNodeId && listed.executionNodeId !== local) { sendError(response, 409, "Open this conversation on its execution node to create an assistant"); return; }
    response.status(201).json({ assistant: await savePersonalAssistant(actor(response), { ...input, nodeId: local }) });
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint/.test(error.message)) { sendError(response, 409, "Conversation already has a personal assistant"); return; }
    next(error);
  }
});
app.put("/api/personal-assistants/:id", async (request, response, next) => {
  try {
    const existing = await visible(actor(response), request.params.id);
    if (!existing) { sendError(response, 404, "Assistant not found"); return; }
    const input = profileSchema.parse(request.body);
    if (input.projectId !== existing.projectId || input.engine !== existing.engine || input.sessionId !== existing.sessionId) { sendError(response, 400, "Cannot move an assistant to another conversation"); return; }
    response.json({ assistant: await savePersonalAssistant(actor(response), input, existing.id) });
  } catch (error) { next(error); }
});
app.delete("/api/personal-assistants/:id", async (request, response, next) => {
  try {
    if (!await visible(actor(response), request.params.id)) { sendError(response, 404, "Assistant not found"); return; }
    await deletePersonalAssistant(actor(response), request.params.id);
    response.status(204).end();
  } catch (error) { next(error); }
});
app.get("/api/personal-assistants/:id/items", async (request, response, next) => {
  try {
    if (!await visible(actor(response), request.params.id)) { sendError(response, 404, "Assistant not found"); return; }
    response.json({ items: await listSavedItems(actor(response), request.params.id) });
  } catch (error) { next(error); }
});
app.post("/api/personal-assistants/:id/items", async (request, response, next) => {
  try {
    if (!await visible(actor(response), request.params.id)) { sendError(response, 404, "Assistant not found"); return; }
    const entry = await saveItem(actor(response), request.params.id, itemSchema.parse(request.body));
    response.status(201).json({ item: entry });
  } catch (error) { if (error instanceof Error && /^(Invalid image|Unsupported image type|Images exceed)/.test(error.message)) { sendError(response, 400, error.message); return; } next(error); }
});
app.delete("/api/personal-assistants/:id/items/:itemId", async (request, response, next) => {
  try {
    if (!await visible(actor(response), request.params.id) || !await deleteItem(actor(response), request.params.id, request.params.itemId)) { sendError(response, 404, "Item not found"); return; }
    response.status(204).end();
  } catch (error) { next(error); }
});
app.get("/api/personal-assistants/:id/items/:itemId/images/:name", async (request, response, next) => {
  try {
    if (!await visible(actor(response), request.params.id)) { sendError(response, 404, "Image not found"); return; }
    const image = await savedImage(actor(response), request.params.id, request.params.itemId, request.params.name);
    if (!image) { sendError(response, 404, "Image not found"); return; }
    response.set("Cache-Control", "private, no-store").set("X-Content-Type-Options", "nosniff").type(image.mimeType).send(image.bytes);
  } catch (error) { next(error); }
});
