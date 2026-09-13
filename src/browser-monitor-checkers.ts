import { createHash } from "node:crypto";
import { z } from "zod";
import { BrowserMonitorCheckError } from "./browser-monitor-scheduler.js";
import { monitorCheckpointSchema, monitorCheckResultSchema, monitorInputSchema, type MonitorCheckResult, type MonitorItem } from "./browser-monitor-types.js";

const text = (max: number) => z.string().trim().min(1).max(max);
const selector = text(2048);
const attribute = z.enum(["id", "title", "aria-label", "data-id", "data-message-id", "data-legacy-message-id", "data-thread-id", "data-legacy-thread-id", "data-account-id", "data-target-id", "data-sender-id", "email"]);
const fieldSchema = z.object({ selector, attribute: attribute.nullable(), format: z.enum(["text", "email"]) }).strict();
const originSchema = z.string().refine(value => {
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && value === url.origin; }
  catch { return false; }
}, "Expected an exact HTTP(S) origin");

export const browserCheckerSchema = z.object({
  id: text(100), version: z.number().int().positive(), name: text(120),
  origins: z.array(originSchema).min(1).max(10).refine(values => new Set(values).size === values.length, "Origins must be unique"),
  kind: z.enum(["messages", "page-change"]), readySelector: selector, loginSelector: selector.nullable(),
  loadingSelector: selector.nullable(), emptySelector: selector.nullable(), account: fieldSchema,
  target: fieldSchema, targetLabel: fieldSchema, itemsSelector: selector, itemId: fieldSchema.nullable(),
  sender: fieldSchema.nullable(), text: fieldSchema, incomingSelector: selector.nullable(), outgoingSelector: selector.nullable(),
}).strict().superRefine((value, context) => {
  const messageFields = [value.itemId, value.sender, value.incomingSelector, value.outgoingSelector];
  if (value.kind === "messages" ? messageFields.some(item => item === null) : messageFields.some(item => item !== null)) context.addIssue({ code: "custom", message: `${value.kind} checker fields are inconsistent` });
  if (Buffer.byteLength(JSON.stringify(value)) > 32 * 1024) context.addIssue({ code: "custom", message: "Checker declaration exceeds 32 KiB" });
});
export type BrowserChecker = z.infer<typeof browserCheckerSchema>;

const monitorReadInputSchema = z.object({ checker: browserCheckerSchema, origin: monitorInputSchema.shape.origin, accountId: text(320), targetIds: monitorInputSchema.shape.targetIds, checkpoint: monitorCheckpointSchema }).strict();
export interface MonitorReadInput { checker: BrowserChecker; origin: string; accountId: string; targetIds: string[]; checkpoint: Record<string, string> }

const PROGRAM = String.raw`(() => {
const input=__INPUT__,checker=input.checker;
const fail=(health,detail)=>({ok:false,health,detail:detail.slice(0,2000)});
const forbidden=element=>element.matches('input,textarea,select,option,script,style,template,noscript,[contenteditable]:not([contenteditable="false"])')||Boolean(element.closest('input,textarea,select,option,script,style,template,noscript,[contenteditable]:not([contenteditable="false"])'));
const visible=element=>{if(!(element instanceof HTMLElement)||forbidden(element))return false;const style=getComputedStyle(element),rect=element.getBoundingClientRect();return rect.width>0&&rect.height>0&&style.display!=='none'&&style.visibility!=='hidden'&&style.visibility!=='collapse';};
const query=(root,value,self=false)=>{let found;try{found=value===':scope'&&self?[root]:[...(self&&root.matches(value)?[root]:[]),...root.querySelectorAll(value)];}catch{return {error:'Invalid CSS selector'};}return {elements:found.filter(visible)};};
const one=(root,field,self=false,allowEmpty=false)=>{const result=query(root,field.selector,self);if(result.error)return result;if(result.elements.length!==1)return {error:'Field selector must match exactly one visible element'};const element=result.elements[0];if(field.attribute===null&&element.querySelector('input,textarea,select,option,script,style,template,noscript,[contenteditable]:not([contenteditable="false"])'))return {error:'Text field contains a forbidden element'};let value=field.attribute===null?element.innerText:element.getAttribute(field.attribute);if(value===null)return {error:'Required field attribute is missing'};value=value.trim();if(field.format==='email'){const matches=value.match(/[A-Z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi)||[];const unique=[...new Set(matches.map(item=>item.toLowerCase()))];if(unique.length!==1)return {error:'Email identity must contain exactly one distinct address'};value=unique[0];}return value||allowEmpty?{value}:{error:'Required field is empty'};};
const identity=(field,label)=>{const result=one(document,field);if(result.error)return fail('incompatible',label+' extraction failed: '+result.error);return result.value.length>320?fail('incompatible',label+' exceeds allowed bounds'):result;};
if(location.origin!==input.origin||!checker.origins.includes(input.origin))return fail('wrong-account','Browser origin does not match monitor grant');
if(checker.loginSelector){const login=query(document,checker.loginSelector);if(login.error)return fail('incompatible',login.error);if(login.elements.length)return fail('needs-login','Browser source requires login');}
const ready=query(document,checker.readySelector);if(ready.error)return fail('incompatible',ready.error);if(!ready.elements.length)return fail('incompatible','Browser source is not ready');
if(checker.loadingSelector){const loading=query(document,checker.loadingSelector);if(loading.error)return fail('incompatible',loading.error);if(loading.elements.length)return fail('incompatible','Browser source is still loading');}
const account=identity(checker.account,'Account');if(account.ok===false)return account;if(account.value!==input.accountId)return fail('wrong-account','Browser account does not match monitor grant');
const target=identity(checker.target,'Target');if(target.ok===false)return target;const targetLabel=identity(checker.targetLabel,'Target label');if(targetLabel.ok===false)return targetLabel;
if(input.targetIds.length&&!input.targetIds.includes(target.value))return fail('target-missing','Current browser target is outside monitor scope');
let matches=query(document,checker.itemsSelector);if(matches.error)return fail('incompatible',matches.error);let complete=input.targetIds.length===1&&input.targetIds[0]===target.value,detail=complete?'Current configured target covered':'Only the current target is covered';
if(matches.elements.length>500){complete=false;detail='More than 500 visible items; newest 500 read';matches.elements=matches.elements.slice(-500);}
if(!matches.elements.length){if(!checker.emptySelector)return fail('incompatible','No items and no explicit empty marker');const empty=query(document,checker.emptySelector);if(empty.error)return fail('incompatible',empty.error);if(!empty.elements.length)return fail('incompatible','No items and empty state is not visible');if(input.checkpoint[target.value]){complete=false;detail='Saved message boundary is not loaded';}return {ok:true,accountId:account.value,targetId:target.value,targetLabel:targetLabel.value,rows:[],complete,detail};}
const rows=[];
if(checker.kind==='page-change'){if(matches.elements.length!==1)return fail('incompatible','Page-change region must match exactly once');const body=one(matches.elements[0],checker.text,true,true);if(body.error)return fail('incompatible','Region extraction failed: '+body.error);if(body.value.length>16000)return fail('incompatible','Page-change region exceeds allowed bounds');rows.push({id:null,senderId:account.value,direction:'incoming',text:body.value});}
else for(const row of matches.elements){const id=one(row,checker.itemId,true),sender=one(row,checker.sender,true),body=one(row,checker.text,true);if(id.error||sender.error||body.error)return fail('incompatible','Message row extraction failed');if(id.value.length>1024||sender.value.length>320||body.value.length>16000)return fail('incompatible','Message row exceeds allowed bounds');const incoming=query(row,checker.incomingSelector,true),outgoing=query(row,checker.outgoingSelector,true);if(incoming.error||outgoing.error||Boolean(incoming.elements.length)===Boolean(outgoing.elements.length))return fail('incompatible','Message direction must match exactly one declaration');rows.push({id:id.value,senderId:sender.value,direction:incoming.elements.length?'incoming':'outgoing',text:body.value});}
if(checker.kind==='messages'&&input.checkpoint[target.value]&&!rows.some(row=>row.id===input.checkpoint[target.value])){complete=false;detail='Saved message boundary is not loaded';}
return {ok:true,accountId:account.value,targetId:target.value,targetLabel:targetLabel.value,rows,complete,detail};
})()`;

export function createMonitorReadExpression(input: MonitorReadInput): string {
  const parsed = monitorReadInputSchema.parse(input);
  return PROGRAM.replace("__INPUT__", () => JSON.stringify(parsed));
}

const failureSchema = z.object({ ok: z.literal(false), health: z.enum(["needs-login", "wrong-account", "target-missing", "incompatible"]), detail: z.string().max(2000) }).strict();
const successSchema = z.object({ ok: z.literal(true), accountId: text(320), targetId: text(320), targetLabel: text(320), rows: z.array(z.object({ id: z.string().min(1).max(1024).nullable(), senderId: text(320), direction: z.enum(["incoming", "outgoing"]), text: z.string().max(16000) }).strict()).max(500), complete: z.boolean(), detail: z.string().max(2000) }).strict();

export function normalizeMonitorRead(input: MonitorReadInput, value: unknown): MonitorCheckResult {
  const parsedInput = monitorReadInputSchema.parse(input);
  const result = z.union([failureSchema, successSchema]).parse(value);
  if (!result.ok) throw new BrowserMonitorCheckError(result.health, result.detail);
  if (result.accountId !== parsedInput.accountId || (parsedInput.targetIds.length && !parsedInput.targetIds.includes(result.targetId))) throw new BrowserMonitorCheckError("wrong-account", "Browser result identity changed");
  let items: MonitorItem[];
  let finalId: string | null;
  if (parsedInput.checker.kind === "page-change") {
    if (result.rows.length !== 1 || result.rows[0].id !== null) throw new BrowserMonitorCheckError("incompatible", "Invalid page-change result");
    const previous = parsedInput.checkpoint[result.targetId];
    const match = previous?.match(/^page:([1-9]\d*):([0-9a-f]{64})$/);
    if (previous && !match) throw new BrowserMonitorCheckError("incompatible", "Invalid page-change checkpoint");
    const previousRevision = match ? Number(match[1]) : 0;
    if (match && !Number.isSafeInteger(previousRevision)) throw new BrowserMonitorCheckError("incompatible", "Invalid page-change checkpoint");
    const digest = createHash("sha256").update(JSON.stringify([result.accountId, result.targetId, result.rows[0].text])).digest("hex");
    if (match?.[2] === digest) {
      finalId = previous;
      items = [];
    } else {
      const revision = previousRevision + 1;
      if (!Number.isSafeInteger(revision)) throw new BrowserMonitorCheckError("incompatible", "Invalid page-change checkpoint");
      finalId = `page:${revision}:${digest}`;
      items = [{ externalId: finalId, targetId: result.targetId, targetLabel: result.targetLabel, senderId: result.accountId, direction: "incoming", kind: "page.changed", text: result.rows[0].text, occurredAt: null, identity: "fingerprint" }];
    }
  } else {
    if (result.rows.some(row => row.id === null)) throw new BrowserMonitorCheckError("incompatible", "Message result lacks stable identity");
    items = result.rows.map(row => ({ externalId: row.id!, targetId: result.targetId, targetLabel: result.targetLabel, senderId: row.senderId, direction: row.direction, kind: "message.received", text: row.text, occurredAt: null, identity: "stable" }));
    finalId = result.rows.at(-1)?.id ?? null;
  }
  const checkpoint = result.complete && finalId ? { ...parsedInput.checkpoint, [result.targetId]: finalId } : parsedInput.checkpoint;
  return monitorCheckResultSchema.parse({ accountId: result.accountId, items, checkpoint, complete: result.complete, detail: result.detail });
}
