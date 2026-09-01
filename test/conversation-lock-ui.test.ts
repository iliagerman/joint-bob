import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("a conversation owned by another node replaces the composer with a take-ownership notice", async () => {
  const [html, app, styles, serviceWorker] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("public/app.js", "utf8"),
    readFile("public/styles.css", "utf8"),
    readFile("public/sw.js", "utf8"),
  ]);

  const stripStart = html.indexOf('<div class="command-strip"');
  const composerStart = html.indexOf('<form class="composer" id="composer">');
  const noticeStart = html.indexOf('id="conversationLock"');
  assert.ok(stripStart >= 0 && composerStart >= 0, "Missing command strip or composer");
  assert.ok(noticeStart > stripStart && noticeStart < composerStart, "Lock notice must sit between the command strip and the composer");
  assert.match(html, /<div class="conversation-lock" id="conversationLock" role="status" data-testid="conversation-lock-notice" hidden>/);
  assert.match(html, /id="conversationLockDetail" data-testid="conversation-lock-detail"/);
  assert.match(html, /id="conversationLockStatus"/);
  assert.match(html, /id="conversationLockTakeButton" type="button" data-testid="conversation-lock-take-button">Take ownership<\/button>/);

  for (const id of ["conversationLock", "conversationLockDetail", "conversationLockStatus", "conversationLockTakeButton"]) {
    assert.match(app, new RegExp(`${id}: document\\.querySelector\\("#${id}"\\)`));
  }

  const render = app.slice(app.indexOf("function renderConversationLock()"));
  assert.ok(render.startsWith("function renderConversationLock()"), "Missing renderConversationLock");
  const renderBody = render.slice(0, render.indexOf("\n}"));
  assert.match(renderBody, /elements\.conversationLock\.hidden = !lock/);
  assert.match(renderBody, /elements\.composer\.hidden = Boolean\(lock\)/);
  assert.match(renderBody, /elements\.commandStrip\.hidden = Boolean\(lock\)/);
  assert.match(renderBody, /conversationLockDetail\.textContent/);
  assert.match(renderBody, /conversationLockTakeButton\.disabled/);

  // A locked conversation must never leave the message box usable.
  const composerEnabled = app.slice(app.indexOf("function setComposerEnabled(enabled)"));
  assert.match(composerEnabled.slice(0, composerEnabled.indexOf("\n}")), /const allowed = enabled && !state\.conversationLock;/);

  assert.match(app, /state\.conversationLock = payload\.ownership \?\? null;/);
  assert.match(app, /if \(payload\.type === "ownership"\)/);
  assert.match(app, /elements\.conversationLockTakeButton\.addEventListener\("click", \(\) => takeLockedConversationOwnership\(\)/);
  assert.match(app, /function takeLockedConversationOwnership\(\)[\s\S]*state\.sessionNodes\.find\(\(node\) => node\.id === state\.activeNodeId\)/);

  assert.match(styles, /\.conversation-lock \{/);
  assert.match(styles, /\.conversation-lock\[hidden\] \{ display: none; \}/);
  assert.match(serviceWorker, /const CACHE_NAME = "joint-bob-v82";/);
});

test("the take-ownership controls are engine-neutral, so a Claude conversation can be claimed", async () => {
  const [app, html] = await Promise.all([
    readFile("public/app.js", "utf8"),
    readFile("public/index.html", "utf8"),
  ]);

  const render = app.slice(app.indexOf("function renderConversationLock()"));
  const renderBody = render.slice(0, render.indexOf("\n}"));
  assert.match(renderBody, /const takeable = !state\.activeTaskId;/);
  // The lock banner offers the same wording to both engines.
  assert.match(renderBody, /Anything you send from here is rejected until you take ownership/);
  assert.doesNotMatch(app, /only Pi conversations can be taken over/);

  // The session panel button and the request it fires are gated on the ticket
  // check alone; neither consults the engine any more.
  assert.match(app, /elements\.sessionTakeOwnershipButton\.hidden = Boolean\(state\.activeTaskId\);/);
  const take = app.slice(app.indexOf("async function takeSessionOwnership("));
  assert.match(take.slice(0, take.indexOf("\n}")), /if \(ownershipWait \|\| ownershipTaking \|\| state\.activeTaskId \|\| !state\.activeProjectId \|\| !session\) return;/);
  assert.match(html, /id="sessionTakeOwnershipButton" data-testid="session-take-ownership-button"/);
});

test("push transfer stays blocked for Claude while takeover is opened up", async () => {
  const app = await readFile("public/app.js", "utf8");

  // Conversation row menu: the transfer entry is still disabled for Claude.
  assert.match(app, /testid: "session-transfer-button",\s*disabled: isClaude,/);
  assert.match(app, /title: isClaude \? "Claude transfer is not available yet"/);
  // Chat toolbar: the transfer button still requires the Pi engine.
  assert.match(app, /Boolean\(selectedSession && state\.engine === "pi" && socketOpen\(\) && destinations\.length\)/);
  assert.match(app, /state\.engine === "claude"\s*\? "Claude conversation transfer is not available yet"/);
});

test("takeover derives the engine from the session path instead of refusing Claude", async () => {
  const server = await readFile("src/server.ts", "utf8");

  const take = server.slice(server.indexOf("async function takeLocalSessionOwnership("));
  assert.ok(take.startsWith("async function takeLocalSessionOwnership("), "Missing takeLocalSessionOwnership");
  const body = take.slice(0, take.indexOf("\n}"));
  assert.doesNotMatch(body, /Only Pi conversations can be taken over/);
  assert.match(body, /const engine: ConversationEngine = matching\.path\.startsWith\("claude:"\) \? "claude" : "pi";/);
  // The preconditions and the epoch bump keep running, now for the derived engine.
  assert.match(body, /if \(conversationIsActive\(project\.id, engine, sessionId, matching\.path\)\) throw new TaskWorktreeError\("Wait for the current turn to finish before taking ownership"\);/);
  assert.match(body, /const ownership = await takeConversationOwnership\(engine, sessionId, local\.id\);/);
});

test("the execution node reports foreign conversation ownership to the browser", async () => {
  const [server, app] = await Promise.all([readFile("src/server.ts", "utf8"), readFile("public/app.js", "utf8")]);
  const describe = server.slice(server.indexOf("async function describeConversationOwner("));
  assert.ok(describe.startsWith("async function describeConversationOwner("), "Missing describeConversationOwner");
  const body = describe.slice(0, describe.indexOf("\n}"));
  assert.match(body, /if \(ownership\.ownerNodeId === localId\) return null;/);
  assert.match(body, /nodeName: peer\?\.name \?\? "another node"/);
  assert.match(server, /async function foreignConversationOwner\([\s\S]*ownership \? describeConversationOwner\(ownership, localId\) : null/);

  assert.equal([...server.matchAll(/ownership: foreignOwner,/g)].length, 2, "Both engines must publish ownership in the ready payload");
  assert.equal([...server.matchAll(/executionNodeId: local\.id,/g)].length, 2, "Both ready payloads identify their execution node");
  assert.match(app, /if \(payload\.executionNodeId\) \{\s*state\.activeNodeId = payload\.executionNodeId;/);
  assert.match(server, /if \(error instanceof ConversationOwnershipError\)[\s\S]*send\(socket, \{ type: "ownership", ownership: await describeConversationOwner\(error\.ownership, local\.id\)/);
});

test("opening a conversation establishes its owner so the other node can see the lock", async () => {
  const server = await readFile("src/server.ts", "utf8");
  const open = server.slice(server.indexOf("async function openConversationOwnership("));
  assert.ok(open.startsWith("async function openConversationOwnership("), "Missing openConversationOwnership");
  const body = open.slice(0, open.indexOf("\n}"));
  // An unowned conversation is claimed on open; one already owned elsewhere is reported, not stolen.
  assert.match(body, /if \(foreign\) return foreign;/);
  assert.match(body, /await claimConversationAcrossCluster\(engine, sessionId, localId\)/);
  assert.match(body, /if \(!\(error instanceof ConversationOwnershipError\)\) throw error;/);
  assert.match(body, /return describeConversationOwner\(error\.ownership, localId\)/);

  // Every opened conversation runs the claim, not just brand-new ones.
  assert.doesNotMatch(server, /if \(!listedSession\) await claimConversationAcrossCluster/);
  assert.match(server, /foreignOwner = await openConversationOwnership\(requestedEngine, ownershipSessionId, local\.id\)/);
  // A claim that fails for a reason other than ownership must not block reading an existing conversation.
  assert.match(server, /if \(!listedSession\) \{[\s\S]*socket\.close\(1008, webSocketCloseReason\(message\)\);[\s\S]*return;[\s\S]*\}\s*console\.warn\("Conversation ownership claim failed on open"/);
});
