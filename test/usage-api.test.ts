import assert from "node:assert/strict";
import test from "node:test";
import { subscriptionPlanInputSchema } from "../src/subscription-usage.js";

test("subscription price is explicit and unknown cannot become zero",()=>{assert.throws(()=>subscriptionPlanInputSchema.parse({provider:"anthropic",accountLabel:"a",planName:"Pro",renewalAt:null,quotaWindows:[],status:"available",source:"manual"}));const plan=subscriptionPlanInputSchema.parse({provider:"anthropic",accountLabel:"a",planName:"Pro",price:{amount:20,currency:"usd",billingPeriod:"month"},renewalAt:null,quotaWindows:[],status:"available",source:"manual"});assert.equal(plan.price.amount,20);assert.equal(plan.price.currency,"USD");});
test("quota remaining must be derived",()=>assert.throws(()=>subscriptionPlanInputSchema.parse({provider:"x",accountLabel:"a",planName:"p",price:{amount:0,currency:"USD",billingPeriod:"month"},renewalAt:null,status:"available",source:"manual",quotaWindows:[{id:"w",label:"window",used:2,limit:10,remaining:9,unit:"requests",resetsAt:null,capturedAt:"2025-01-01T00:00:00.000Z",source:"manual"}]})));
