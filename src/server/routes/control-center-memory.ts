import type { NextFunction, Response } from "express";
import { z } from "zod";
import type { AuthSession } from "../../auth.js";
import { memoryContextFor } from "../../control-center/memory-runtime.js";
import {
  cleanTopic, deleteTopic, editChange, keepChange, lastRead, linkedFrom, listChanges, listTopics, MAX_BODY, MemoryError, readTopic, revertChange,
  searchTopics, topicHistory, topicLinks, TOPIC_NAME, waitingChanges, writeTopic, type ChangeMeta, type MemoryContext, type StoredTopic,
} from "../../control-center/memory-store.js";
import { sendError } from "../http-auth.js";
import { app } from "../state.js";

const PERSON = { kind: "person", text: "", messageId: null, conversationId: null, projectId: null, projectName: null } as const;
const by = (why: string): ChangeMeta => ({ author: "person", why, source: PERSON });

const name = z.string().regex(TOPIC_NAME);
const topicFields = { description: z.string().max(2_000), body: z.string().max(MAX_BODY + 2_000), project: z.string().max(200).nullable().optional() };
const topicBody = z.object(topicFields).strict();
const newTopicBody = z.object({ name, ...topicFields }).strict();
const changeId = z.string().min(1).max(100);

async function contextOf(response: Response): Promise<MemoryContext> {
  return memoryContextFor((response.locals.authSession as AuthSession).accountId);
}

function fail(response: Response, next: NextFunction, error: unknown): void {
  if (error instanceof z.ZodError) { sendError(response, 400, "Invalid request for Bob's memory"); return; }
  if (error instanceof MemoryError) { sendError(response, error.status, error.message); return; }
  next(error);
}

function summary(topic: StoredTopic) {
  return { name: topic.name, description: topic.description, project: topic.project, updatedAt: topic.updatedAt };
}

function detail(ctx: MemoryContext, topic: StoredTopic) {
  return { ...summary(topic), body: topic.body, links: topicLinks(topic.body), linkedFrom: linkedFrom(listTopics(ctx.root), topic.name), history: topicHistory(ctx, topic.name) };
}

app.get("/api/control-center/memory/topics", async (request, response, next) => {
  try {
    const { query } = z.object({ query: z.string().max(200).optional() }).strict().parse(request.query);
    const ctx = await contextOf(response);
    const all = listTopics(ctx.root);
    response.json({ topics: (query?.trim() ? searchTopics(all, query) : all).map(summary), total: all.length, lastRead: lastRead(ctx), waiting: waitingChanges(ctx) });
  } catch (error) { fail(response, next, error); }
});

app.get("/api/control-center/memory/topics/:name", async (request, response, next) => {
  try {
    const ctx = await contextOf(response);
    const topic = readTopic(ctx.root, name.parse(request.params.name));
    if (!topic) { sendError(response, 404, "That topic does not exist"); return; }
    response.json({ topic: detail(ctx, topic) });
  } catch (error) { fail(response, next, error); }
});

app.post("/api/control-center/memory/topics", async (request, response, next) => {
  try {
    const input = newTopicBody.parse(request.body);
    const ctx = await contextOf(response);
    if (readTopic(ctx.root, input.name)) { sendError(response, 409, "A topic with that name already exists"); return; }
    const change = writeTopic(ctx, cleanTopic(input.name, input), by("You created this topic"));
    response.status(201).json({ topic: detail(ctx, readTopic(ctx.root, input.name)!), change });
  } catch (error) { fail(response, next, error); }
});

app.put("/api/control-center/memory/topics/:name", async (request, response, next) => {
  try {
    const topicName = name.parse(request.params.name);
    const input = topicBody.parse(request.body);
    const ctx = await contextOf(response);
    if (!readTopic(ctx.root, topicName)) { sendError(response, 404, "That topic does not exist"); return; }
    const change = writeTopic(ctx, cleanTopic(topicName, input), by("You edited this topic"));
    response.json({ topic: detail(ctx, readTopic(ctx.root, topicName)!), change });
  } catch (error) { fail(response, next, error); }
});

app.delete("/api/control-center/memory/topics/:name", async (request, response, next) => {
  try {
    const ctx = await contextOf(response);
    response.json({ change: deleteTopic(ctx, name.parse(request.params.name), by("You deleted this topic")) });
  } catch (error) { fail(response, next, error); }
});

app.get("/api/control-center/memory/changes", async (request, response, next) => {
  try {
    const { offset, limit } = z.object({ offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(50).default(10) }).strict().parse(request.query);
    response.json({ ...listChanges(await contextOf(response), offset, limit), offset });
  } catch (error) { fail(response, next, error); }
});

app.post("/api/control-center/memory/changes/:id/keep", async (request, response, next) => {
  try { response.json({ change: keepChange(await contextOf(response), changeId.parse(request.params.id)) }); }
  catch (error) { fail(response, next, error); }
});

app.post("/api/control-center/memory/changes/:id/revert", async (request, response, next) => {
  try { response.json({ change: revertChange(await contextOf(response), changeId.parse(request.params.id)) }); }
  catch (error) { fail(response, next, error); }
});

app.post("/api/control-center/memory/changes/:id/edit", async (request, response, next) => {
  try {
    const input = topicBody.parse(request.body);
    response.json({ change: editChange(await contextOf(response), changeId.parse(request.params.id), input, "You edited what Bob saved") });
  } catch (error) { fail(response, next, error); }
});
