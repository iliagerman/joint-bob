import assert from "node:assert/strict";
import test from "node:test";
import { normalizeUsageRecords } from "../src/usage-import.js";
import { priceUsage } from "../src/usage-pricing.js";

const context={projectId:"p",conversationId:"c",createdAt:"2025-01-01T00:00:00.000Z"};
test("Claude repeated blocks count once and preserve cache TTLs",()=>{const records=[1,2].map(output=>({type:"assistant",message:{id:"request",role:"assistant",model:"claude-x",usage:{input_tokens:10,output_tokens:output,cache_read_input_tokens:3,cache_creation_input_tokens:6,cache_creation:{ephemeral_5m_input_tokens:2,ephemeral_1h_input_tokens:4}}}}));const events=normalizeUsageRecords("claude","s",records,context);assert.equal(events.length,1);assert.equal(events[0].output,2);assert.equal(events[0].cacheWrite1h,4);});
test("copied fork assistant is excluded",()=>assert.equal(normalizeUsageRecords("pi","s",[{jointBobUsageOrigin:"old",message:{role:"assistant",usage:{input:1,output:1}}}],context).length,0));
test("pricing does not add reasoning and threshold equality remains base",()=>assert.equal(priceUsage({input:100,output:10,cacheRead:0,cacheWrite5m:0,cacheWrite1h:0},{input:1,output:2,inputTiers:[{threshold:100,input:10}]}),0.00012));
