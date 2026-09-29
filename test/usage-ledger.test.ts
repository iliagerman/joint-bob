import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { applyUsageEvent, ensureUsageSchema } from "../src/usage-ledger.js";
import type { UsageEvent } from "../src/usage-types.js";

const event:UsageEvent={id:"event",projectId:"p",conversationId:"c",sessionId:"s",engine:"pi",provider:"x",modelId:"m",occurredAt:"2025-01-01T00:00:00.000Z",requestId:"r",input:2,output:3,cacheRead:0,cacheWrite5m:0,cacheWrite1h:0,reasoning:1,apiCostUsd:null,pricing:null,usageStatus:"reported",difficultyLevel:null,difficultyConfidence:null,difficultyStatus:"not-classified",turnId:null,toolCalls:0,toolErrors:0};
test("replicated native request is idempotent",()=>{const db=new DatabaseSync(":memory:");ensureUsageSchema(db);const replication={id:"repl",originNodeId:"node",entityType:"model.usage",entityKey:event.id,operation:"upsert",payload:{projectId:event.projectId,event,originNodeId:"node"},createdAt:event.occurredAt};applyUsageEvent(db,replication);applyUsageEvent(db,replication);assert.equal((db.prepare("SELECT count(*) count FROM model_usage_events").get() as {count:number}).count,1);});
test("replication validates entity identity",()=>{const db=new DatabaseSync(":memory:");ensureUsageSchema(db);assert.throws(()=>applyUsageEvent(db,{id:"x",originNodeId:"node",entityType:"model.usage",entityKey:"wrong",operation:"upsert",payload:{projectId:event.projectId,event,originNodeId:"node"},createdAt:event.occurredAt}));});
