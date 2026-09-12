#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { latestActiveGroups, redactSensitive } from "./whatsapp-lib.mjs";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(await readFile(path.join(skillRoot, "config.json"), "utf8"));
const cli = process.env.JOINT_BOB_BROWSER_CLI;
if (!cli) fail("JOINT_BOB_BROWSER_CLI is unavailable. Use the designated Joint Bob browser executor.");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function invoke(args, profile = true) {
  const fullArgs = [cli, ...args];
  if (profile) fullArgs.push("--profile", config.profileId);
  const result = spawnSync(process.execPath, fullArgs, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
  if (result.status !== 0) fail((result.stderr || result.stdout || "Browser command failed").trim());
  const parsed = JSON.parse(result.stdout);
  if (parsed.truncated) fail("Browser output was truncated; narrow the request before retrying.");
  if (parsed.result?.dialogPending) fail("A browser dialog is pending; inspect and resolve it before retrying.");
  return parsed;
}

function evaluate(expression) {
  return invoke(["evaluate", expression]).result;
}

function ensureSession() {
  const status = invoke(["status"], false);
  const node = status.nodes.find(item => item.id === config.nodeId);
  if (!node?.available) fail(`Configured browser node is unavailable: ${node?.reason || config.nodeId}`);
  let session = status.sessions.find(item => item.profileId === config.profileId && item.nodeId === config.nodeId && item.state === "running");
  if (!session) session = invoke(["start", "https://web.whatsapp.com", "--profile", config.profileId, "--node", config.nodeId], false).session;
  if (session.owner !== "agent") fail("Browser is under human control. Resume agent control before running this command.");
  const active = session.tabs.find(tab => tab.id === session.activePageId);
  if (active && new URL(active.url).origin !== config.origin) fail(`Configured profile is on unexpected origin: ${active.url}`);
  return session;
}

function mapApplication() {
  const result = evaluate(`(()=>({
    title:document.title,
    url:location.href,
    loginRequired:Boolean(document.querySelector('img[alt*="QR code"]')),
    tabs:[...document.querySelectorAll('[role="tab"]')].map(e=>({name:e.innerText.replace(/\\n/g,' ').trim(),selected:e.getAttribute('aria-selected')==='true'})).filter(e=>e.name),
    dialog:document.querySelector('[role="dialog"]')?.innerText.split('\\n')[0]||null,
    searchLabel:document.querySelector('[data-testid="chat-list-search-container"] input')?.getAttribute('aria-label')||null,
    openChat:document.querySelector('[data-testid="conversation-info-header-chat-title"]')?.innerText.trim()||null,
    chatRows:document.querySelectorAll('[data-testid^="list-item-"]').length,
    loadedMessages:document.querySelectorAll('[data-testid="msg-container"]').length
  }))()`);
  console.log(JSON.stringify(result, null, 2));
}

function inventory(days) {
  const dialog = evaluate("Boolean(document.querySelector('[role=dialog] button[aria-label=Close]'))");
  if (dialog) invoke(["click", '[role="dialog"] button[aria-label="Close"]']);
  invoke(["fill", '[data-testid="chat-list-search-container"] input', ""]);
  const groupsSelected = evaluate(`[...document.querySelectorAll('[role="tab"]')].some(e=>e.getAttribute('aria-selected')==='true'&&e.innerText.includes('Groups'))`);
  if (!groupsSelected) invoke(["click", '[role="tab"]:has-text("Groups")']);
  const measure = `(()=>{const g=document.querySelector('[role="grid"][aria-label="Chat list"]');let s=g;while(s&&getComputedStyle(s).overflowY!=='auto')s=s.parentElement;if(!g||!s)throw new Error('Group chat list not ready');return {top:s.scrollTop,max:s.scrollHeight-s.clientHeight,step:Math.max(200,Math.floor(s.clientHeight/2))}})()`;
  const extract = `(()=>{const re=/^(?:\\d{1,2}:\\d{2}|Yesterday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|\\d{1,2}\\/\\d{1,2}\\/\\d{4})$/;const rendered=[...document.querySelectorAll('[role="grid"][aria-label="Chat list"] [role="row"]')].filter(row=>row.innerText.trim()&&!row.innerText.includes('Loading…'));const rows=rendered.flatMap(row=>{const lines=row.innerText.split('\\n').map(value=>value.trim()).filter(Boolean);const index=lines.findIndex(value=>re.test(value));if(index<0)return [];let name=lines[index-1]||'';if(index===1&&/unread messages?$/.test(lines[index+1]||''))name=lines[index+2]||name;return name?[{name,activity:lines[index]}]:[]});return {rows,unparsed:rendered.length-rows.length}})()`;
  const rows = new Map();
  let top = 0;
  let pages = 0;
  let unparsedRows = 0;
  let reachedEnd = false;
  while (pages < 100) {
    evaluate(`(()=>{const g=document.querySelector('[role="grid"][aria-label="Chat list"]');let s=g;while(s&&getComputedStyle(s).overflowY!=='auto')s=s.parentElement;s.scrollTop=${top};return s.scrollTop})()`);
    const ready = evaluate(`new Promise(resolve=>{const end=Date.now()+10000;const check=()=>{const g=document.querySelector('[role="grid"][aria-label="Chat list"]');let s=g;while(s&&getComputedStyle(s).overflowY!=='auto')s=s.parentElement;const box=s.getBoundingClientRect();const visible=[...g.querySelectorAll('[role="row"]')].filter(row=>{const r=row.getBoundingClientRect();return r.bottom>box.top&&r.top<box.bottom&&row.innerText.trim()});if(visible.length&&!visible.some(row=>row.innerText.includes('Loading…')))resolve(true);else if(Date.now()>=end)resolve(false);else setTimeout(check,100)};check()})`);
    if (!ready) fail(`Group list did not finish loading near scroll offset ${top}`);
    const extracted = evaluate(extract);
    unparsedRows += extracted.unparsed;
    for (const row of extracted.rows) rows.set(`${row.name}\0${row.activity}`, row);
    pages += 1;
    const current = evaluate(measure);
    if (current.top >= current.max) { reachedEnd = true; break; }
    top = Math.min(current.top + current.step, current.max);
  }
  evaluate(`(()=>{const g=document.querySelector('[role="grid"][aria-label="Chat list"]');let s=g;while(s&&getComputedStyle(s).overflowY!=='auto')s=s.parentElement;s.scrollTop=0;return s.scrollTop})()`);
  const browserNow = new Date(evaluate("(()=>{const d=new Date();return new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate())).toISOString()})()"));
  const groups = latestActiveGroups([...rows.values()], days, browserNow);
  const complete = reachedEnd && unparsedRows === 0;
  console.log(JSON.stringify({ generatedAt: browserNow.toISOString(), days, count: groups.length, coverage: { pages, reachedEnd, complete, unparsedRows }, groups }, null, 2));
}

function cssString(value) {
  return JSON.stringify(value).replace(/</g, "\\3c ");
}

function recent(group, limit) {
  invoke(["fill", '[data-testid="chat-list-search-container"] input', group]);
  const searchReady = evaluate(`new Promise(resolve=>{const end=Date.now()+10000;const check=()=>{const found=[...document.querySelectorAll('[role="grid"][aria-label="Search results."] [data-testid="cell-frame-title"]')].some(e=>(e.innerText||'').trim()===${JSON.stringify(group)}||(e.querySelector('[title]')?.getAttribute('title')||'').trim()===${JSON.stringify(group)});if(found)resolve(true);else if(Date.now()>=end)resolve(false);else setTimeout(check,100)};check()})`);
  if (!searchReady) fail(`Group search timed out: ${group}`);
  const candidates = evaluate(`(()=>[...document.querySelectorAll('[role="grid"][aria-label="Search results."] [data-testid="cell-frame-title"]')].map(e=>({title:e.querySelector('[title]')?.getAttribute('title')||'',name:e.innerText.trim()})))()`);
  const exact = candidates.filter(item => item.name === group || item.title.trim() === group);
  if (exact.length !== 1) fail(exact.length ? `Multiple groups have the exact name: ${group}` : `Group not found: ${group}`);
  invoke(["click", `[role="grid"][aria-label="Search results."] [data-testid="cell-frame-title"] [title=${cssString(exact[0].title)}]`]);
  const opened = evaluate(`new Promise(resolve=>{const end=Date.now()+10000;const check=()=>{const name=document.querySelector('[data-testid="conversation-info-header-chat-title"]')?.innerText.trim()||null;if(name===${JSON.stringify(group)})resolve(name);else if(Date.now()>=end)resolve(name);else setTimeout(check,100)};check()})`);
  if (opened !== group) fail(`Opened ${opened || "no chat"}, expected ${group}`);
  if (evaluate("Boolean(document.querySelector('[aria-label=\"Scroll to bottom\"]'))")) invoke(["click", '[aria-label="Scroll to bottom"]']);
  const syncing = evaluate(`document.querySelector('[data-testid="conversation-panel-messages"]')?.innerText.includes('Syncing older messages')||false`);
  const messages = evaluate(`(()=>[...document.querySelectorAll('[data-testid="msg-container"]')].slice(-${limit}).map(e=>({meta:e.querySelector('[data-pre-plain-text]')?.getAttribute('data-pre-plain-text')||'',text:e.innerText})))()`)
    .map(message => ({ meta: message.meta, text: redactSensitive(message.text) }));
  console.log(JSON.stringify({ group, count: messages.length, coverage: { requested: limit, loaded: messages.length, syncing, complete: !syncing && messages.length >= limit }, messages }, null, 2));
}

const [command = "help", ...args] = process.argv.slice(2);
if (command === "help") {
  console.log("Usage: whatsapp.mjs status | map | active-groups [days] | recent <group> [limit]");
  process.exit(0);
}
const session = ensureSession();
if (command === "status") console.log(JSON.stringify({ profile: config.profileLabel, node: config.nodeName, session }, null, 2));
else if (command === "map") mapApplication();
else if (command === "active-groups") inventory(Number(args[0] ?? 30));
else if (command === "recent") {
  if (!args[0]) fail("recent requires an exact group name");
  const limit = Number(args[1] ?? 30);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) fail("Limit must be an integer from 1 to 200");
  recent(args[0], limit);
} else fail(`Unknown command: ${command}`);
