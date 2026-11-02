# Assistant mode with a continuous chat

Status: UI direction approved; updated behavior specification for implementation planning.

## User requirements

An assistant is a normal agent with a persistent identity, instructions, tools, and the same access rules as a normal agent conversation. It is not a separate, restricted chatbot.

- Any conversation can become an assistant. Put Create assistant in the mobile conversation menu and the desktop conversation toolbar.
- Desktop has a Conversations / Assistants mode toggle and an assistant list.
- Each assistant has dedicated Webhooks and Scheduled tasks buttons. These open management forms, not a request to create automations through chat. Mobile forms should feel native, fill the screen, and keep primary actions reachable. Desktop uses dialogs.
- Each assistant has a selectable conversation classifier. Reuse TypeSafe and Laya, but give them a separate conversation-routing mechanism rather than repurposing difficulty scores.
- Incoming messages may continue a saved conversation, start a new one, or ask for information from history.
- **The assistant always presents one continuous, chronological chat.** Background conversation boundaries must not clear the chat, replace its transcript, announce a reset, or require the user to select a topic.
- All previous conversations remain stored. When a classifier or LLM-assisted search identifies an earlier conversation to continue, restore and resume that same conversation with its saved context. Do not create a replacement conversation containing a summary of the old one.

## Approved visual direction

The interactive, synthetic-data mockup is `mockups/assistant-mode.html`.

Version 2 removes per-message routing badges and new-context notices from the assistant chat. Walkthrough buttons and routing explanations live outside the mock application and are design-review controls only. Selecting New topic followed by Return to laptops appends both exchanges to the existing timeline.

The classifier is configured in assistant settings. Conversation history can be inspected deliberately, but browsing it is not required to resume a topic. Normal source citations remain appropriate when answering questions about earlier discussions.

## Key separation

There are three different identities:

1. **Assistant identity:** the stable thing the user opens, configures, messages, and attaches automations to.
2. **Visible timeline:** the assistant's user-facing messages in the order they occurred, regardless of which underlying conversation handled them.
3. **Conversation identity:** a saved topic-specific agent conversation, with its own context and existing harness segments.

Do not treat the currently selected underlying session as the assistant's identity or as the complete visible transcript.

Example:

| Visible order | Message | Background action |
| --- | --- | --- |
| 1 | Compare these laptops | Create conversation A |
| 2 | Help with tomorrow's meeting | Create conversation B |
| 3 | Back to the laptops, choose the second one | Resume conversation A |
| 4 | What did we decide about deployment last week? | Retrieve relevant permitted history and answer |

The chat keeps messages 1, 2, 3, and 4 in that order. Conversation A contains its relevant turns from 1 and 3. Conversation B remains saved with its own context. Resuming A does not move its old messages to the bottom or make the meeting exchange disappear.

## Routing behavior

The three product-level outcomes remain continue, new, and recall. Resuming an older conversation is a continue outcome with a different target, not a fourth independent user mode.

- **Continue:** select a concrete existing conversation identity, resolve its current harness segment, and use the existing resume path. The target may be the current topic or an older one.
- **New:** create a new underlying conversation without copying unrelated topic context into it. Apply the assistant's current instructions and authorized resources. Keep all earlier conversation records and the visible timeline intact.
- **Recall:** retrieve relevant evidence from permitted history and answer the user's question, rather than loading every past transcript into the model. If the request also continues earlier work, resume the identified conversation instead of merely quoting it.

The router needs the current message and bounded recent visible context to understand references such as "the second one". It also needs relevant candidate conversation identities and descriptions. LLM-assisted history search may retrieve additional candidates or evidence. A short-list miss must not be mistaken for proof that the topic is new.

Routing and difficulty scoring remain separate. The classifier does not write the user-facing answer; the normal agent does. There is no keyword-only replacement for the requested semantic routing.

### Proposed implementation defaults

These are engineering choices, not additional user requests:

- Retrieve candidate topics using existing searchable history where possible, then use the chosen classifier to select an action and candidate. Use the normal authorized agent/model for deeper history lookup when needed.
- Automatic resume targets this assistant's saved topics, including its conversion-source conversation. Other normally accessible conversations can supply recall evidence, but are not silently adopted as assistant topics or rewritten with its instructions. This interprets "return to a previous conversation" as returning to one of the conversations kept behind this assistant's continuous chat.
- A classifier outage or invalid response must not silently reset context or invent a successful routing decision. Preserve the queued message and history, and show a retryable error. If candidate search still leaves a genuinely ambiguous user request, ask a short clarification in the same chat.
- For a pure recall request, use a separate retrieval/answer turn without replacing the last active work topic. Follow-up questions may resume that recall context when appropriate.
- Background scheduling and webhook events target the assistant identity and enter the same ordered routing pipeline. Preserve creator identity, profile selection, and source metadata. Existing non-assistant automation behavior is unchanged.

## Persistence and streaming constraints

Use normal conversation storage and harness lifecycle machinery for the actual topic sessions. Add only the assistant-to-conversation relationship and durable timeline/turn association needed to join their user-facing events.

Each accepted assistant message needs a stable request/turn identity, an assistant-local ordering position, and a recorded target once routing is committed. Bind streamed responses, tool activity, failures, and completion events to that turn. A change of active topic must not redirect an earlier turn's output into a later one.

- Serialize routing decisions for messages queued to the same assistant so later messages see the correct prior state. Reuse existing queue behavior rather than introduce competing execution machinery.
- Reconnects and reloads reconstruct the same visible chronology without duplicating user messages or replaying entire old transcripts as new replies.
- Loading or resuming an underlying session must not send a history replacement to the assistant view. Its existing `ready`/history response belongs to the topic runtime, not the whole assistant timeline.
- Keep the stable logical conversation identity across any existing harness segment changes. Follow the normal ownership and execution-node rules.
- No destructive context clearing, deleting old sessions, or automatically replaying interrupted external actions.
- Current source conversation history seeds the assistant timeline once when converting an existing conversation. Retain its original session identity and existing data.

Exact schema names, indexing, pagination, transport changes, and retrieval mechanics are left to the implementation plan. Transcript text should remain in existing storage wherever references suffice; do not build a second independent transcript system unnecessarily.

## Access and automation

Normal user, project, conversation, resource, and node restrictions still apply. Assistant mode grants no new access to another user's conversations, secrets, browser profiles, tools, or subscription profiles. History search uses the same access boundaries as the normal agent, not an artificial assistant-only restriction and not unrestricted database access.

The assistant's current instructions and resource settings apply both when creating topic sessions and on subsequent turns in resumed topics. Apply changed settings through the existing runtime configuration mechanisms without replacing the saved topic context. Resuming a conversation must resolve current authorization, not restore stale grants from an old snapshot. New topic sessions must not inherit another user's identity or silently acquire browser login profiles.

Reuse the existing scheduling and webhook management flows, validation, delivery/execution records, and authentication. Dedicated buttons open scoped forms for the selected assistant. Avoid a parallel automation implementation. The assistant remains the target when its active topic changes.

Automation Run with profile follows the existing creator-based policy: Use my current profile resolves the creator's applicable selection at run time; an explicit authorized own/shared automation profile pins that assignment. Shared automation-only profiles are not made available to interactive turns.

Existing personal assistant saved items, shared images, instructions, and access settings remain available. Existing assistants adopt their current conversation as their initial topic. Preserve existing assistant links or redirect them to the new view without changing identity.

## Relevant current implementation

- `public/app/conversation-sharing.js`: existing assistant-create/open action in the responsive toolbar/menu.
- `public/assistant.js` and `public/assistant.html`: current assistant page, primarily configuration and saved items, linking back to its single conversation.
- `src/personal-assistants.ts` and `src/server/routes/personal-assistants.ts`: profiles currently tied to one project/engine/session; saved items and settings.
- `src/classifiers/contract.ts`, `registry.ts`, `typesafe.ts`, and `laya.ts`: current classifier adapters are difficulty-specific. Their request/response contract must not be assumed to support the new outcomes already.
- `src/server/harness-chat.ts`: normal agent dispatch, queues, assistant instructions/tools, session resume, and history delivery.
- `src/conversation-records.ts`, `src/conversation-segments.ts`, and `src/server/harness-sessions.ts`: logical conversations, transcript segments, and runtime lifecycle.
- `public/app/cron.js` and `public/app/webhooks.js`: existing management flows to reuse.

These are verified entry points, not a claim that detailed implementation inspection is complete.

## Builder check

A read-only review identified two points needing explicit decisions: whether unrelated searchable conversations may be adopted, and whether updated assistant settings apply to resumed topics. The defaults above resolve them: unrelated history is recall evidence rather than an implicit adoption, and current assistant settings apply on new and resumed topic turns.

## Required verification

1. Create/open an assistant from desktop and both applicable mobile menu layouts. Existing assistants reopen without duplication.
2. Create topic A, create topic B, then resume A. Assert distinct A/B conversation identities, original A identity reused, A's relevant context restored, and B preserved.
3. Assert the visible timeline stays chronological and retains all messages through the A/B/A sequence. No reset badges, topic dividers, history replacement, duplicated turns, or unrelated context leakage into topic runtimes.
4. Reconnect/reload after that sequence and recover the identical timeline and resumable topic relationships.
5. Retrieve an older topic beyond the initial candidate list. Test both read-only recall and resuming its original conversation.
6. Test TypeSafe and Laya routing separately from difficulty scoring, including ambiguous references, invalid results, missing credentials, provider failure, and unknown/inaccessible target IDs.
7. Queue consecutive user messages and automation events. Verify stable ordering, correct stream attribution, and no duplicate execution on reconnect/retry.
8. Verify assistant instructions/tools follow normal authorization on new and resumed topics. Test inaccessible history and revoked resource grants.
9. Create and manage assistant-targeted webhooks/tasks through dedicated desktop dialogs and mobile full-screen forms. Verify targets survive topic switches and normal non-assistant automations are unchanged.
10. Preserve existing assistants, saved items, screenshots, links, and conversion-source history.

Run focused unit/server tests and disposable browser journeys through `TESTING.md`. The design mockup is not evidence of working backend routing or session restoration.
