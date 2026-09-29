import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { priceUsage } from "../src/usage-pricing.js";
import { DatabaseSync } from "node:sqlite";
import { applyUsageEvent, ensureUsageSchema, saveUsageEvent, usageDatabase, usageTotals } from "../src/usage-ledger.js";
import type { UsageEvent } from "../src/usage-types.js";

const db = usageDatabase();
beforeEach(() => db.exec("DELETE FROM model_usage_events; DELETE FROM usage_inventory; DELETE FROM replication_outbox;"));
function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return { id: "request", projectId: "project", conversationId: "conversation", sessionId: "session", engine: "pi", provider: "provider", modelId: "model",
    occurredAt: "2025-01-01T00:00:00.000Z", requestId: null, input: 10, output: 5, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0,
    cacheWriteUnknown: 0, reasoning: 2, apiCostUsd: null, pricing: null, usageStatus: "reported", difficultyLevel: null,
    difficultyConfidence: null, difficultyStatus: "not-classified", turnId: null, toolCalls: 0, toolErrors: 0, ...overrides };
}
function stored(): UsageEvent { return JSON.parse((db.prepare("SELECT payload FROM model_usage_events").get() as { payload: string }).payload) as UsageEvent; }

test("pricing an event ignores nullable metadata", () => {
  assert.equal(priceUsage(event(), { input: 1, output: 2 }), .00002);
});

test("native request updates retain exact cost and canonical owner", () => {
  const pricing = { source: "pi-reported", capturedAt: "2025-01-01T00:00:00.000Z", rates: { input: 99, output: 99 } };
  saveUsageEvent(event({ apiCostUsd: .7, pricing }), "node");
  saveUsageEvent(event({ projectId: "other", conversationId: "other", output: 50, apiCostUsd: .7, pricing }), "node");
  assert.equal(stored().apiCostUsd, .7); assert.equal(stored().projectId, "project");
  assert.deepEqual(usageTotals({ projectIds: ["project"] }), { apiCostUsd: .7, input: 10, output: 50, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWriteUnknown: 0, reasoning: 2, totalTokens: 60, requests: 1, pricedRequests: 1, missingRequests: 0, unavailableSessions: 0, toolCalls: 0, toolErrors: 0, partial: false });
});

test("catalog updates retain captured rates and later tool errors", () => {
  const old = { source: "runtime-catalog", capturedAt: "2025-01-01T00:00:00.000Z", rates: { input: 1, output: 1 } };
  const newer = { source: "runtime-catalog", capturedAt: "2025-02-01T00:00:00.000Z", rates: { input: 100, output: 100 } };
  saveUsageEvent(event({ pricing: old, apiCostUsd: .000015 }), "node");
  saveUsageEvent(event({ output: 10, pricing: newer, apiCostUsd: .002 }), "node");
  saveUsageEvent(event({ output: 10, pricing: newer, apiCostUsd: .002, toolCalls: 1, toolErrors: 1 }), "node");
  assert.equal(stored().apiCostUsd, .00002); assert.equal(stored().pricing?.capturedAt, old.capturedAt); assert.equal(stored().toolErrors, 1);
});

const replicatedEvent: UsageEvent = {id:"event",projectId:"p",conversationId:"c",sessionId:"s",engine:"pi",provider:"x",modelId:"m",occurredAt:"2025-01-01T00:00:00.000Z",requestId:"r",input:2,output:3,cacheRead:0,cacheWrite5m:0,cacheWrite1h:0,reasoning:1,apiCostUsd:null,pricing:null,usageStatus:"reported",difficultyLevel:null,difficultyConfidence:null,difficultyStatus:"not-classified",turnId:null,toolCalls:0,toolErrors:0};
test("replicated native request is idempotent",()=>{const db=new DatabaseSync(":memory:");ensureUsageSchema(db);const replication={id:"repl",originNodeId:"node",entityType:"model.usage",entityKey:replicatedEvent.id,operation:"upsert",payload:{projectId:replicatedEvent.projectId,event: replicatedEvent,originNodeId:"node"},createdAt:replicatedEvent.occurredAt};applyUsageEvent(db,replication);applyUsageEvent(db,replication);assert.equal((db.prepare("SELECT count(*) count FROM model_usage_events").get() as {count:number}).count,1);});
test("replication validates entity identity",()=>{const db=new DatabaseSync(":memory:");ensureUsageSchema(db);assert.throws(()=>applyUsageEvent(db,{id:"x",originNodeId:"node",entityType:"model.usage",entityKey:"wrong",operation:"upsert",payload:{projectId:replicatedEvent.projectId,event: replicatedEvent,originNodeId:"node"},createdAt:replicatedEvent.occurredAt}));});
