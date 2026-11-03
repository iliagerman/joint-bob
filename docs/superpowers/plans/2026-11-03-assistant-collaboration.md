# Assistants That Work Together: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An owner's assistants know each other and help each other. When the owner asks, they share freely and can act. When someone else asks, only the helpers' published actions are used, judged by the decision model.

**Architecture:**
- **Asking (owner side):** the asking agent calls Joint Bob's own tools through the bundled MCP bridge, using a reserved virtual server `joint_bob`. Asking starts a normal turn of the helper as the owner, and the answer is read back in short waits. Each ask is recorded so the chat line, **Show** and the helper's Activity can be built.
- **Other people's requests:** the coded pipeline in `src/social/requests.ts` also offers the helpers' published actions. Free/busy is combined across calendars, and a booking is checked against every calendar. Calendar operations run on the helper's machine.
- **Across machines:** a twin-only "changed → pull manifest" exchange shares the owner's assistant list between the owner's machines. Short signed start and status calls carry asks and calendar operations.

**Tech Stack:** TypeScript (Node 22, ESM), Express, `node:sqlite`, zod, `@modelcontextprotocol/sdk` (existing bridge), vanilla JS front end (`public/assistant/*`), node:test + Playwright (`test/ui/launch-chrome.ts`).

**Spec:** `docs/superpowers/specs/2026-11-03-assistant-collaboration-design.md` (approved 2026-11-03). Mocks: `mockups/assistant-collaboration-chat.html` (option A), `mockups/assistant-collaboration-others.html`.

## Global Constraints

- Public requests never start an agent session. The decision model authorizes; code executes the named operations (`src/social/requests.ts` header comment).
- Only owner turns with origin `chat` or `scheduled` may ask. Turns with origin `webhook` or `assistant` may not. `assistant` is a turn started by an ask, so this rule gives one hop.
- Asking requires both assistants' projects to be private to the owner. Check it again on every ask, and again on the helper's machine.
- The switch is directional (`asker → helper`), on by default, and also governs other people's requests.
- Helper actions are never listed to other people: not in directory listings, the thread catalog, or the "You can ask for: …" reply.
- A calendar change that can't be confirmed is `uncertain` and is never retried automatically. A taken slot is never replaced by another one.
- No polling loops for cluster sync. Changes are pushed. Pulls happen at startup, when this machine returns, and when a peer returns.
- Never show, copy or move secrets between assistants.
- Bridge tool names are exactly `list_assistants`, `ask_assistant` and `ask_result` on server `joint_bob`. Claude/Kiro see them as `mcp__joint_bob__<tool>`; Pi sees them as `mcp__joint_bob__<tool>` too, because the name has no `-`. None of the names may match `/(bash|shell|terminal|exec|command|browser)/i`.
- One tool call never waits more than 90 s, under the 125 s bridge fetch abort.
- Copy is plain language and follows `docs/assistants.md` and the approved mock wording: "Asked Work assistant · work calendar · 4 s", **Show**, "Other assistants", `Used Work assistant's "Read free and busy times"`.
- Shared checkout: stage only your own hunks, from a private index, and run tests in a `git archive` scratch export (see `TESTING.md`). Never run tests in the project folder.

## Review Focus

1. **The helper's machine is unreachable or restarts in the middle of an ask.** The ask ends `failed` with "Couldn't reach Work assistant on <machine>". It is never re-run, and the asking agent gets that message instead of hanging. *(Tested in Task 4.)*
2. **A project becomes shared after its switch was turned on.** The next ask, and any helper action for someone else, is refused, and the switch shows the reason. *(Tested in Tasks 1 and 5.)*
3. **The agent calls `ask_result` after the asking turn already finished, or with an ask ID from another assistant.** It gets "Ask not found", never another assistant's answer. *(Tested in Task 3.)*
4. **A helper declines or doesn't answer the free/busy judgment.** Its calendar is left out. The reply doesn't mention it, and no busy times are guessed. *(Tested in Task 5.)*
5. **A booking slot is free in the create action's calendar but busy in another assistant's calendar.** Nothing is booked, and the reply is "<owner> isn't free then. Which other time would work?" *(Tested in Task 5.)*

---

## File Structure

| File | Responsibility |
|---|---|
| `src/assistant-collaboration/store.ts` (new) | Tables `assistant_ask_switches`, `assistant_asks` and `assistant_peer_directory`, with their CRUD. |
| `src/assistant-collaboration/directory.ts` (new) | An assistant's capability summary, the owner's full assistant list (local plus twins), and askable helpers with reasons. |
| `src/assistant-collaboration/twin-sync.ts` (new) | Twin-only `changed`/`manifest` routes, `announceAssistantChanges()`, and pulls on startup and return. |
| `src/assistant-collaboration/ask.ts` (new) | `startAsk`, `waitForAsk`, helper turn execution (local or remote), and the signed `ask`/`ask-status` routes. |
| `src/assistant-collaboration/bridge-tools.ts` (new) | Tool definitions, the call handler for server `joint_bob`, and the instructions block. |
| `src/assistant-collaboration/helper-actions.ts` (new) | Others path: helper actions for triage, combined busy blocks, and remote calendar operations. |
| `src/server/routes/assistant-collaboration.ts` (new) | Owner API: peers list and switch, served asks for Activity. |
| `src/personal-assistants.ts` | `origin` column on turns. |
| `src/server/routes/personal-assistants.ts` | Pass `origin`, and add asks to the transcript timeline. |
| `src/account-keys.ts` | Add `personal_assistants.account_id` to `ACCOUNT_KEY_COLUMNS`, which fixes assistants keeping a pre-pairing account ID. |
| `src/store.ts` | `projectPrivateToOwner()`. |
| `src/mcp/agent.ts`, `src/server/routes/managed-mcp.ts`, `src/mcp/store.ts`, `src/harnesses/claude/resources.ts`, `src/harnesses/kiro/resources.ts`, `src/personal-assistants.ts` (`filterPersonalAssistantTools`), `src/server/harness-chat.ts` (baseline) | Let the `joint_bob` server through every gate. |
| `src/server/replication-v2.ts` | `signedPeerPost(peer, target, payload, timeoutMs = 10_000)`. |
| `src/social/requests.ts` | Use helper actions in triage, judgment and execution. |
| `src/server/cron.ts`, `src/server/webhooks.ts` | Pass `origin: "scheduled"` and `origin: "webhook"`. |
| `src/server.ts`, `src/server/peer-return.ts` | Hook the directory pulls. |
| `public/assistant/chat.js`, `public/assistant/resources.js`, `public/assistant/activity.js`, `public/assistant/assistant.css`, `public/sw.js` | UI. |
| `docs/assistants.md` | User documentation. |

---

### Task 1: Turn origin, privacy, switches and ask records

**Files:**
- Modify: `src/personal-assistants.ts` (turn schema at :43–77, `beginPersonalAssistantTurn` at :157)
- Modify: `src/server/routes/personal-assistants.ts` (`AssistantAutomationTurnOptions` at :164, `executeAssistantTurn` at :175, `processAssistantTurn` at :205, `runPersonalAssistantAutomationTurn` at :233)
- Modify: `src/server/cron.ts:91`, `src/server/webhooks.ts:114`
- Modify: `src/account-keys.ts:11-29`
- Modify: `src/store.ts` (next to `projectVisible` at :533)
- Create: `src/assistant-collaboration/store.ts`
- Test: `test/assistant-collaboration-store.test.ts`

**Interfaces:**
- Produces:
  - `type TurnOrigin = "chat" | "scheduled" | "webhook" | "assistant"`, exported from `src/personal-assistants.ts`.
  - `beginPersonalAssistantTurn(accountId, assistantId, requestId, topicId, message, origin: TurnOrigin)`.
  - `runningPersonalAssistantTurn(assistantId: string, topicIds: string[]): Promise<{ requestId: string; origin: TurnOrigin } | null>`: the newest `running` turn in any of those topics.
  - `AssistantAutomationTurnOptions.origin: TurnOrigin`, required. Cron passes `"scheduled"` and webhooks pass `"webhook"`. The chat route passes `"chat"`.
  - `projectPrivateToOwner(projectId: string): Promise<boolean>`. True when the project exists, its owner is this node or an active twin, and `resourceClusterIds(db, localNodeId, "project", id)` is empty.
  - From `src/assistant-collaboration/store.ts`:
    - `askAllowedBySwitch(askerId: string, helperId: string): Promise<boolean>`: defaults to true when no row exists.
    - `setAskSwitch(askerId: string, helperId: string, enabled: boolean): Promise<void>`
    - `interface AskRecord { id; accountId; askerId; askerName; askerTurnRequestId: string | null; helperId; helperName; helperNodeId; purpose; question; answer: string | null; error: string | null; status: "running" | "completed" | "failed"; startedAt; finishedAt: string | null }`
    - `insertAsk(record: Omit<AskRecord, "answer" | "error" | "status" | "finishedAt">): Promise<void>`: idempotent on `id`.
    - `finishAsk(id: string, result: { answer: string } | { error: string }): Promise<boolean>`: changes only a `running` row.
    - `getAsk(id: string): Promise<AskRecord | null>`
    - `asksForTurns(askerId: string, requestIds: string[]): Promise<AskRecord[]>`
    - `asksServedBy(helperId: string, limit = 50): Promise<AskRecord[]>`

- [ ] **Step 1: Write the failing tests** in `test/assistant-collaboration-store.test.ts`:
  - `"turns record where they came from"`: begin a turn with `"webhook"`; `runningPersonalAssistantTurn(id, [topic])` returns `{ origin: "webhook" }`. Once finished, it returns `null`.
  - `"switches default on and turn off per direction"`: `askAllowedBySwitch(a, b) === true`. After `setAskSwitch(a, b, false)`, `(a,b)` is false and `(b,a)` is still true.
  - `"an ask finishes once"`: `insertAsk` twice with the same id leaves one row. `finishAsk(id, {answer:"x"})` returns true, then `finishAsk(id, {error:"y"})` returns false and the answer stays `"x"`.
  - `"a project shared into a cluster is not private"`: an own project is `true`. After recording a `sharing_resource_owners`/cluster share for it, as `test/cluster-project-metadata-api.test.ts` does, it is `false`.
  - `"assistant rows follow an account id change"`: after `syncLocalAccountIds`, `personal_assistants.account_id` holds the new id.

- [ ] **Step 2: Run and see them fail.** `npm run test:file -- test/assistant-collaboration-store.test.ts` should fail with missing exports.

- [ ] **Step 3: Implement.**
  - **Turn origin:** add the `origin TEXT NOT NULL DEFAULT 'chat'` migration, using the existing `turnColumns` pattern. Thread `origin` through `processAssistantTurn → executeAssistantTurn → beginPersonalAssistantTurn`.
  - **Privacy:** add `projectPrivateToOwner` beside `projectVisible`.
  - **Store:** create the store tables, keyed and indexed by `(helper_id, started_at)` and `(asker_id, asker_turn_request_id)`.
  - **Account ids:** add `{ table: "personal_assistants", column: "account_id" }` to `ACCOUNT_KEY_COLUMNS`.

- [ ] **Step 4: Run.** `npm run test:file -- test/assistant-collaboration-store.test.ts test/personal-assistants.test.ts test/personal-assistants-api.test.ts test/cron.test.ts test/webhooks.test.ts` should PASS.

- [ ] **Step 5: Commit** `feat(assistants): record turn origin and add collaboration store`.

---

### Task 2: What each assistant can do, across the owner's machines

**Files:**
- Create: `src/assistant-collaboration/directory.ts`, `src/assistant-collaboration/twin-sync.ts`
- Modify: `src/server/replication-v2.ts:196` (add `timeoutMs`)
- Modify: `src/server.ts:209-216` (startup pull), `src/server/peer-return.ts:41,61` (pull when this machine or a peer returns)
- Modify (announce on change): `src/server/routes/personal-assistants.ts` (create, update, delete), `src/server/routes/assistant-resources.ts` (resources, logins), `src/server/routes/social.ts` (action create, update, status, delete), `src/server/routes/personal-assistants.ts` secret attach (`shareAssistantAccess`)
- Test: `test/assistant-collaboration-directory.test.ts`

**Interfaces:**
- Consumes: Task 1 (`projectPrivateToOwner`, `askAllowedBySwitch`), `listPersonalAssistants`, `assistantResourcePreferences`, `assistantLoginProfileIds`, `getScopeSecretAccounts`, `listActions`, `isTrustedTwin`, `replicationPeers`, `adminAccountId`, `accountOfSomeoneElse`.
- Produces:
  - `interface AssistantSummary { id; accountId; name; nodeId; machineName; about: string; has: string[]; private: boolean; instructions: string; actions: Array<{ id; name; description; instructions; operations: string[]; revision: number; digest: string; status: "published" }> }`
    - `about` is the first 300 characters of the instructions.
    - `has` holds the labels of attached secret accounts, browser login labels and allowed MCP server names, followed by published action names.
    - Skills and plugins are left out because they are machine-wide.
  - `localAssistantSummaries(accountId: string): Promise<AssistantSummary[]>`
  - `ownerAssistants(accountId: string): Promise<AssistantSummary[]>`: local summaries plus cached twin summaries, deduplicated by `id`, with the local copy winning.
  - `interface HelperView extends AssistantSummary { enabled: boolean; available: boolean; reason: string | null }`
  - `askableHelpers(asker: PersonalAssistant): Promise<HelperView[]>`: every other assistant of the owner. It returns `available = enabled && asker private && helper.private`, with `reason` set to one of:
    - "Turned off for this assistant."
    - "<Asker> is in a shared project, so it can't ask your other assistants."
    - "<Helper> is in a shared project, so other assistants can't ask it."
  - `announceAssistantChanges(): void`: fire-and-forget, never throws.
  - `pullTwinAssistants(peerNodeId?: string): Promise<void>`
  - Routes:
    - `POST /api/cluster/v2/assistants/changed`: `{}` → 204; triggers a pull from the sender.
    - `POST /api/cluster/v2/assistants/manifest`: `{}` → `{ assistants: AssistantSummary[] }` for the admin account.
    - Both require `machineProtocol === 2 && isTrustedTwin(db, local, sender)`, otherwise 403.

- [ ] **Step 1: Write the failing tests:**
  - `"a summary names what is attached and what is published"`: an assistant with a secret account labelled `Work Google`, a login `LinkedIn`, MCP allowlist `["kms-jira"]` and a published "Read free and busy times" has `has` equal to `["Work Google", "LinkedIn", "kms-jira", "Read free and busy times"]` and `private === true`.
  - `"helpers explain why they can't be asked"`: with the asker's project shared, every helper has `available: false` and the shared-project reason. With the switch off, the reason is "Turned off for this assistant."
  - `"twins exchange assistant lists without polling"`: two dev nodes are paired with `pairTwinNodes(environment)`, and an assistant is created on node B. Within 10 s, `ownerAssistants` on node A includes it with `nodeId` = B, with no request to `/manifest` before B announced.
  - `"only twins can read the manifest"`: a signed request from a non-twin cluster peer gets 403.

- [ ] **Step 2: Run and see them fail.** `npm run test:file -- test/assistant-collaboration-directory.test.ts`

- [ ] **Step 3: Implement.**
  - **Pattern:** follow `src/server/saved-commands.ts`:
    - `changed`/`manifest` routes
    - coalesced in-flight pulls (`refreshCommandOwner` style)
    - a 4 MiB body cap
  - **Not copied from it:** the 30 s timer.
  - **Peers:** `replicationPeers(db, local).filter(peer => isTrustedTwin(db, local, peer.nodeId))`.
  - **Cache:** cached rows are replaced per node on each successful pull.
  - **Announce hooks:** call `announceAssistantChanges()` after each mutating route listed under Files.

- [ ] **Step 4: Run** the directory test plus `test/saved-commands-twins.test.ts` and `test/cluster-twins.test.ts`. They should PASS.

- [ ] **Step 5: Commit** `feat(assistants): share assistant summaries between twins`.

---

### Task 3: Built-in bridge tools and local asks

**Files:**
- Create: `src/assistant-collaboration/bridge-tools.ts`, `src/assistant-collaboration/ask.ts` (local half)
- Modify:
  - `src/mcp/agent.ts:22-29,40-45`: always issue the token, and always include `joint_bob`.
  - `src/server/routes/managed-mcp.ts:75-99`: `authorizeMcpServer` accepts `joint_bob`, and the handler routes `joint_bob` before `accountClient`.
  - `src/mcp/store.ts:46-52` and `src/harnesses/claude/resources.ts:208`: reject a user server named `joint_bob`.
  - `src/personal-assistants.ts:16-20`: `filterPersonalAssistantTools` always keeps `mcp__joint_bob__*`.
  - `src/server/harness-chat.ts:489-498`: the baseline always includes the three tool names.
  - `src/harnesses/kiro/resources.ts:222`: the profile `tools` includes `@joint_bob` when terminal is off.
  - `src/agent-capabilities.ts`: an instructions block, present only when the conversation is an assistant topic.
- Test: `test/assistant-collaboration-ask.test.ts`, `test/source-invariants.test.ts`

**Interfaces:**
- Consumes: Task 1 (`runningPersonalAssistantTurn`, store), Task 2 (`askableHelpers`, `ownerAssistants`), `runPersonalAssistantAutomationTurn`, `listConversationSegments`, `assistantIdForConversation`, `getPersonalAssistantById`.
- Produces:
  - `JOINT_BOB_TOOL_SERVER = "joint_bob"`
  - `jointBobTools(): Tool[]`, with these input schemas:
    - `list_assistants {}`
    - `ask_assistant { assistant: string; message: string; purpose: string }`. `purpose` is 2–6 words, shown in the owner's chat, for example "work calendar".
    - `ask_result { ask: string }`
  - `callJointBobTool(identity: McpAgentIdentity, tool: string, args: unknown): Promise<CallToolResult>`. The result text is JSON:
    - `{ assistants: HelperView[] }` for `list_assistants`
    - `{ ask, status: "running" | "completed" | "failed", answer?, error? }` for the other two
  - `assistantForConversation(projectId: string, conversationId: string): Promise<{ assistant: PersonalAssistant; topicIds: string[] } | null>`. It resolves the conversation through `listConversationSegments` and `assistantIdForConversation(projectId, segment.sessionId)` (sessions vs logical conversation).
  - `startAsk(input: { accountId; asker: PersonalAssistant; askerTurnRequestId: string; helperId: string; message: string; purpose: string }): Promise<AskRecord>`
  - `waitForAsk(id: string, askerId: string, maxMs = 85_000): Promise<AskRecord>`. It returns early on completion, and `getAsk` is scoped to `askerId`.
  - Refusals return `isError: true` with these exact texts:
    - "Only your own chat and scheduled tasks can ask your other assistants." (origin `webhook`, or no running turn)
    - "An assistant answering another assistant can't ask a third one." (origin `assistant`)
    - The helper's `reason` from `askableHelpers`, when not available.
    - "Ask not found." (an unknown ask, or another assistant's)

- [ ] **Step 1: Write the failing tests:**
  - `"the owner's turn asks a local helper and gets its answer"`: a dev node with assistants A and B in private projects. The `fake-claude` fixture answers B's turn with "3 meetings tomorrow". A turn is started in A with origin `chat`. Calling the `/api/mcp/agent` handler as A's topic (`ask_assistant`) and then `ask_result` returns `status: "completed"` and the answer containing "3 meetings". `asksForTurns(A, [turnId])` has one completed record with `purpose` "work calendar".
  - `"webhook and assistant turns can't ask"`: an origin `webhook` turn gets the first refusal, and an origin `assistant` turn the second.
  - `"another assistant's ask is not found"`: B's ask id used from C's topic gets "Ask not found."
  - `"terminal off keeps the built-in tools"`: `filterPersonalAssistantTools(["Bash", "mcp__joint_bob__ask_assistant"], { allowTerminal: false, allowBrowser: false, mcpServerNames: [] })` equals `["mcp__joint_bob__ask_assistant"]`.
  - In `test/source-invariants.test.ts`, `"built-in tool names survive the terminal and browser filters"`: every name from `jointBobTools()` fails `/(bash|shell|terminal|exec|command|browser)/i`.

- [ ] **Step 2: Run and see them fail.**

- [ ] **Step 3: Implement the gates, tools and local ask.**
  - **The ask turn:** a local helper turn runs `runPersonalAssistantAutomationTurn(accountId, helperId, askId, message, { label: "Assistant", origin: "assistant" })`. It is not awaited by the tool call. On settle it calls `finishAsk`, with the turn response or the error text.
  - **The instructions block:** tells the agent to use `list_assistants` when it lacks something, and to call `ask_result` again while the status is `running`. It also says not to ask the same helper the same thing twice.

- [ ] **Step 4: Run** the new tests plus `test/source-invariants.test.ts`, `test/personal-assistants*.test.ts` and `test/claude-isolation-mcp.test.ts`. They should PASS.

- [ ] **Step 5: Commit** `feat(assistants): let an assistant ask the owner's other assistants`.

---

### Task 4: Asking a helper on another of the owner's machines

**Files:**
- Modify: `src/assistant-collaboration/ask.ts` (remote half and routes)
- Test: `test/assistant-collaboration-twins.test.ts`

**Interfaces:**
- Consumes: Task 2 (`ownerAssistants` gives `nodeId`), Task 3 (`startAsk`, `waitForAsk`), `signedPeerPost(..., timeoutMs)`, `isTrustedTwin`, `adminAccountId`, `accountOfSomeoneElse`.
- Produces these routes. Both require `machineProtocol === 2`, `isTrustedTwin(local, sender)`, `accountId === adminAccountId(db)` and `!accountOfSomeoneElse(accountId)`; otherwise 403.
  - `POST /api/cluster/v2/assistants/ask` with `{ askId, accountId, askerId, askerName, helperId, message, purpose }`:
    - On the helper's machine, it re-checks that the helper exists for that account and that `projectPrivateToOwner(helper.projectId)` holds. A failure gives 409 with the reason.
    - It inserts the served record and starts the local helper turn exactly as in Task 3.
    - It returns 202 `{ askId }`, and repeating the same `askId` returns 202 again.
  - `POST /api/cluster/v2/assistants/ask-status` with `{ askId, askerId }` → `{ status, answer?, error? }`; 404 when unknown.
  - **Asker side:** `startAsk` sends the `ask` call (15 s timeout) when `helper.nodeId !== local`. `waitForAsk` polls `ask-status` every 3 s (10 s timeout per call) and copies the result into the local record.
  - **Failure:** when the start fails, or polling has failed continuously for 60 s, the local record finishes with the error "Couldn't reach <Helper> on <machine>." It is never re-sent.

- [ ] **Step 1: Write the failing tests** (two twin dev nodes, `pairTwinNodes`):
  - `"an assistant on one machine asks a helper on the twin"`: A is on node 1 and B on node 2. `ask_assistant` and then `ask_result` complete with B's fixture answer. Node 2's `asksServedBy(B)` lists the ask with `askerName` = A's name.
  - `"a stopped twin fails the ask without retrying"`: stop node 2 after `ask_assistant` returns `running`. Within 70 s, `ask_result` returns `failed` with "Couldn't reach". After node 2 restarts, it has started no second turn for that `askId`.
  - `"a helper whose project became shared refuses on its own machine"`: share B's project into a cluster on node 2 before the ask, so the cache on node 1 still says private. The ask fails with "<Helper> is in a shared project".

- [ ] **Step 2: Run and see them fail.**

- [ ] **Step 3: Implement** the routes and the remote start/poll (updater pattern, `src/updater.ts:411`).

- [ ] **Step 4: Run** `npm run test:file -- test/assistant-collaboration-twins.test.ts test/assistant-collaboration-ask.test.ts`. It should PASS.

- [ ] **Step 5: Commit** `feat(assistants): ask a helper on the owner's other machine`.

---

### Task 5: Helper actions in other people's requests

**Files:**
- Create: `src/assistant-collaboration/helper-actions.ts`
- Modify: `src/social/requests.ts` (`handleIncoming` :240, `propose` :291, `buildProposal` :205, `judge` :310, `execute` :340, `Frozen` :28)
- Test: `test/social-core.test.ts`, `test/social-relay.test.ts`

**Interfaces:**
- Consumes: Task 2 (`askableHelpers` gives `HelperView.actions`, `instructions`, `nodeId`), `calendarClient`, `calendarEnvironment`, `signedPeerPost`.
- Produces:
  - `interface OfferedAction { action: PublicAction; owner: { id; name; instructions; nodeId } }`, where `owner` is the asked assistant itself or a helper.
  - `offeredActions(assistant: PersonalAssistant): Promise<OfferedAction[]>`: own published actions plus the `available` helpers' published actions.
  - `Frozen` gains `helper: { id; name; nodeId } | null`.
  - The digest becomes `instructionsDigest(owner.instructions, action)`.
  - `busyAcross(actions: OfferedAction[], from: Date, to: Date): Promise<{ blocks: BusyBlock[]; used: string[] }>`
  - `createWith(offered: OfferedAction, event: { requestId; start; end; summary; description }): Promise<{ id; link; existed }>`
  - Route `POST /api/cluster/v2/assistants/calendar` with `{ op: "busy" | "create", accountId, helperId, actionId, actionRevision, digest, from?, to?, event? }`, under the same twin and account checks as Task 4:
    - The helper's machine re-checks that the action is published at that revision and digest, and that the helper project is private. A failure gives 409.
    - It runs `calendarClient(calendarEnvironment(helper))`.
    - Timeouts are 30 s. On a `create` timeout the caller raises `CalendarUncertainError`.
- Behaviour:
  - **Triage:** offers every `OfferedAction`. The option text is the action name and description only, with no helper name.
  - **Judgment:** uses the asked assistant's decision model key and limit (`decide(assistant, …)`) but the owning assistant's instructions in `dispositionState`. The limit counts on `owner.id` (`withinLimit(owner.id, "decisions", …)`).
  - **Free/busy:** for a freebusy proposal, every other offered freebusy action is judged too. Only those answering `execute` add their calendar to `busyAcross`. A decline or a missing answer leaves the calendar out silently.
  - **Booking:** `buildProposal` (part-of-day) and `execute` check the slot with `busyAcross(all offered freebusy actions + the create action)`. Any overlap declines with "<owner> isn't free then. Which other time would work?"
  - **Owner's Activity:** the request detail starts with `Used <Helper>'s "<Action>".` whenever `frozen.helper` is set.
  - **Not listed to others:** the `unpublished` reply ("You can ask for: …"), `localListings` and the thread catalog still use only the assistant's own actions.
  - **Switch off or project shared:** a helper with the switch off, or a shared project, gives no `OfferedAction`. `execute` re-checks `askableHelpers` and declines with "The helper assistant is no longer available. Nothing happened."

- [ ] **Step 1: Write the failing tests:**
  - In `social-core`, `"free times combine every calendar that allows it"`: own busy 10–11 and a helper's busy 14–15 (both `execute`) reply with free times that exclude both. With the helper's judgment declining, only 10–11 is excluded, and the reply text doesn't contain the helper's name.
  - In `social-core`, `"a slot busy in another calendar is not booked"`: the create action's calendar is free at 14:00 and the helper's freebusy calendar is busy. The request is `declined`, `client.create` is never called, and the reply says "isn't free then".
  - In `social-core`, `"helper actions are not offered when the switch is off"`: `offeredActions` excludes them, and a request frozen earlier declines at `execute`.
  - In `social-relay` (relay + 2 nodes), `"a direct request is answered from a helper's published action"`: Ilia's default assistant has no actions, and his work assistant publishes free/busy. Noa's direct request gets free times. Ilia's Activity detail starts with `Used Work assistant's "Read free and busy times".` The thread catalog Noa sees lists no actions.
  - Existing invariants still pass: no agent session starts for requests, there is no decision-model answer → nothing happens, and an uncertain create is never retried.

- [ ] **Step 2: Run and see them fail.** `npm run test:file -- test/social-core.test.ts test/social-relay.test.ts`

- [ ] **Step 3: Implement** `helper-actions.ts` and the `requests.ts` changes. Keep `execute`'s re-check order: assistant → action → digest → blocks → membership → helper availability.

- [ ] **Step 4: Run** the same command. It should PASS.

- [ ] **Step 5: Commit** `feat(assistants): answer others with the owner's other assistants' public actions`.

---

### Task 6: Owner UI — chat line, Activity, Other assistants

**Files:**
- Create: `src/server/routes/assistant-collaboration.ts` (and import it in `src/server.ts`)
- Modify: `src/server/routes/personal-assistants.ts:307-332` (transcript timeline)
- Modify: `public/assistant/chat.js`, `public/assistant/resources.js:8` (`SECTIONS`), `public/assistant/activity.js`, `public/assistant/assistant.css`, `public/sw.js` (bump `CACHE_NAME`)
- Modify: `docs/assistants.md` (new section "Your assistants work together")
- Test: `test/ui/ui-assistant-social.test.ts`, `test/assistant-collaboration-ask.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces:
  - **Peers:** `GET /api/personal-assistants/:id/peers` returns `{ helpers: HelperView[] }`, minus `instructions` and `actions[].instructions`. `PUT /api/personal-assistants/:id/peers/:helperId` takes `{ enabled: boolean }`. Both require the owner and the execution node, like `ownedAssistant`.
  - **Served asks:** `GET /api/personal-assistants/:id/served` returns `{ served: AskRecord[] }`.
  - **Transcript:** each ask in the timeline sits right after its turn's user item: `{ id: \`${requestId}:ask:${askId}\`, role: "ask", helperName, purpose, status, seconds, question, answer, error, createdAt }`.
- UI, as in the approved mocks:
  - **Chat line:** `.chat-ask` shows `Asked <b>Work assistant</b> · work calendar · 4 s` with a **Show** button that toggles the question and answer. While running it reads "Asking Work assistant…". When failed it reads "Couldn't ask Work assistant: <error>".
  - **Resources:** a sixth section `["assistants", "Other assistants", "agent"]`. Each row shows the name, `has` joined with ", ", and "on <machine>", with a switch. An unavailable row has its switch disabled and shows its `reason`. The intro text is copied from the mock.
  - **Activity:** a section "Asked by your other assistants", from `served`, showing the asker's name, the question, and the answer or error.

- [ ] **Step 1: Write the failing tests:**
  - API: `"the transcript places each ask between the question and the answer"`.
  - UI, in `ui-assistant-social`:
    - The chat with a stubbed ask timeline shows `Asked Work assistant · work calendar · 4 s`, and **Show** reveals the question text.
    - Resources has `6` side items. "Other assistants" lists the second assistant with a switch, and turning it off persists across reload.
    - A shared-project helper shows the switch disabled with its reason.
    - Activity lists a served ask.
  - Update the existing assertion `".side-item" count 5 → 6`.

- [ ] **Step 2: Run and see them fail.** `npm run test:file -- --test-concurrency=1 test/ui/ui-assistant-social.test.ts`

- [ ] **Step 3: Implement** the routes, timeline, UI and docs, and bump `CACHE_NAME`.

- [ ] **Step 4: Run** the UI test, `test/source-invariants.test.ts` and `test/ui/ui-personal-assistant.test.ts`. They should PASS. Then run `npx tsc --noEmit` and expect no errors.

- [ ] **Step 5: Commit** `feat(assistants): show asks in the chat and manage other assistants`.

---

## Self-review notes

- **Spec coverage:**
  - Goals 1–9 map to Tasks 2/6 (awareness), 3/4 (owner path), 5 (others path, combined calendars), 2/4 (machines), 6 (visibility, switch), 1/3/4/5 (private-only), and 1/3 (no webhooks).
  - The non-goals are kept: no new action types, and helper chats are untouched.
  - The anti-goals are pinned by tests in Tasks 3–5.
- **Deviation from the mock wording, within the builder's latitude:** the chat line's middle part is the asking agent's `purpose`, so a booking reads "Asked Work assistant · book Thu 14:00 with Noa · 6 s" rather than "Work assistant booked it".
