import { randomUUID } from "node:crypto";
import { z } from "zod";
import { usageDatabase } from "./usage-ledger.js";

const iso = z.string().datetime();
export const quotaWindowSchema = z.object({ id:z.string().min(1).max(100),label:z.string().min(1).max(100),used:z.number().finite().nonnegative().nullable(),limit:z.number().finite().nonnegative().nullable(),unit:z.enum(["percent","credits","requests","tokens"]),remaining:z.number().finite().nonnegative().nullable(),resetsAt:iso.nullable(),capturedAt:iso,source:z.literal("manual") }).strict().superRefine((value,ctx)=>{ if(value.unit==="percent"&&[value.used,value.limit,value.remaining].some(number=>number!==null&&number>100))ctx.addIssue({code:z.ZodIssueCode.custom,message:"Percent values cannot exceed 100"}); const expected=value.used!==null&&value.limit!==null?Math.max(0,value.limit-value.used):null; if(value.remaining!==expected)ctx.addIssue({code:z.ZodIssueCode.custom,message:"remaining must be derived from used and limit"}); });
export const subscriptionPlanInputSchema=z.object({id:z.string().uuid().optional(),provider:z.string().trim().min(1).max(100),accountLabel:z.string().trim().min(1).max(100),planName:z.string().trim().min(1).max(100),price:z.object({amount:z.number().finite().nonnegative(),currency:z.string().regex(/^[A-Za-z]{3}$/).transform(value=>value.toUpperCase()),billingPeriod:z.enum(["month","year"])}).strict(),renewalAt:iso.nullable(),quotaWindows:z.array(quotaWindowSchema).max(20),status:z.enum(["available","unavailable"]),source:z.literal("manual")}).strict();
export type SubscriptionPlanInput=z.input<typeof subscriptionPlanInputSchema>; export type SubscriptionPlan=z.output<typeof subscriptionPlanInputSchema>&{id:string;owner:string};
function ownerKey(owner:string):string{const value=owner.trim().toLowerCase();if(!value)throw new Error("Owner is required");return value;}
export function listSubscriptionPlans(owner:string):SubscriptionPlan[]{const key=ownerKey(owner);return (usageDatabase().prepare("SELECT payload FROM subscription_plans WHERE owner=? ORDER BY id").all(key) as unknown as Array<{payload:string}>).map(row=>JSON.parse(row.payload) as SubscriptionPlan);}
export function saveSubscriptionPlan(owner: string, input: SubscriptionPlanInput): SubscriptionPlan {
  const key = ownerKey(owner);
  const parsed = subscriptionPlanInputSchema.parse(input);
  const id = parsed.id ?? randomUUID();
  const existing = usageDatabase().prepare("SELECT owner FROM subscription_plans WHERE id=?").get(id) as { owner: string } | undefined;
  if (existing && existing.owner !== key) {
    throw Object.assign(new Error("Subscription plan belongs to another account"), { statusCode: 409 });
  }
  const plan = { ...parsed, id, owner: key };
  usageDatabase().prepare(`INSERT INTO subscription_plans(id,owner,payload) VALUES(?,?,?)
    ON CONFLICT(id) DO UPDATE SET payload=excluded.payload WHERE subscription_plans.owner=excluded.owner`)
    .run(plan.id, key, JSON.stringify(plan));
  return plan;
}
export function deleteSubscriptionPlan(owner:string,id:string):boolean{z.string().uuid().parse(id);return usageDatabase().prepare("DELETE FROM subscription_plans WHERE owner=? AND id=?").run(ownerKey(owner),id).changes>0;}
