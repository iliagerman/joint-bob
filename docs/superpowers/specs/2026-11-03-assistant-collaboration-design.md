# Assistants that work together

Status: agreed in conversation on 2026-11-03. Approved mocks: `mockups/assistant-collaboration-chat.html` (option A was chosen) and `mockups/assistant-collaboration-others.html`.

Builds on `docs/superpowers/specs/2026-11-02-assistant-relay-groups-design.md` (groups, direct requests, public actions, Resources tab) and the chat-first assistants shipped in 2.199.0. Everything that design guarantees still holds.

## Why

The user keeps several assistants, each set up for one part of their life. For example, a work assistant has the work calendar and a default assistant handles everyday things. Today each assistant only knows what is attached to it. To ask the default assistant about tomorrow's work meetings, the user would have to attach the work calendar to it as well. In the user's words: "I don't have to duplicate the abilities, they all need to be aware of one another." When someone else talks with one assistant, it should also be able to get help from the owner's other assistants "and get collaborative work done".

The example the user gave: the work assistant is connected to the work calendar, and the user asks the default assistant about their work meetings tomorrow.

## Goals

1. **Awareness.** Each assistant knows its owner's other assistants and what each one can do. What one can do comes from what is attached to it and from its instructions. That covers secrets such as a Google calendar credential, browser logins, enabled skills and plugins, allowed MCP servers, and published public actions. The owner fills in nothing extra.
2. **When the owner asks, assistants share freely.** One assistant asks another and brings the answer back. Answers carry full detail: meeting titles, times, attendees. Doing things is allowed too. For example, the default assistant asks the work assistant to book a meeting in the work calendar. That happens **without checking with the owner first** (user's decision).
3. **When someone else asks, the others help only with what the owner published.** Someone messages one of the owner's assistants, in a group or a direct request. The owner's other assistants may contribute only through their **published public actions**, under each action's instructions, decided by the **decision model** exactly as today. Example: Noa asks the default assistant when the owner is free. The work assistant publishes "Read free and busy times", so Noa gets free times and never meeting titles or attendees. When nothing published covers the request, the answer is no, the same as today.
4. **Across the owner's machines.** Assistants on any of the owner's machines (the owner's twins) are included. For example, the work assistant runs on the Mac and the shopping assistant on the homeserver.
5. **Visible to the owner, invisible to others.** See "What people see".
6. **Only between private assistants** (user's decision). Asking is allowed only when both assistants live in projects that only the owner can see. Visibility is per project (`projectVisibleToActor`), and anyone a project is shared with can read its conversations. Otherwise a helper's answer, or the question sent to it, would land in a chat other people can read. When either project is shared, the pair's switch shows as off with the reason, and it can't be turned on until that changes.
7. **Not from webhooks** (user's decision). A webhook's text comes from outside, like an email or a form, so turns started by a webhook routed through an assistant cannot ask other assistants. Scheduled tasks routed through an assistant can, since the owner wrote them.
8. **Free times and bookings take every calendar into account** (user's decision). When someone else asks, several of the owner's assistants may publish free/busy, each on its own calendar, such as personal and work. Their answers are combined: busy in any of those calendars counts as busy. Before a booking is created through any create-event action, it is checked against all of those calendars.
9. **A switch per pair.** Each assistant's Resources has an **Other assistants** section listing the owner's other assistants. It shows what each has attached and which machine it runs on, with a switch: may this assistant ask that one. All switches are on by default. This was the agent's suggestion, and the user accepted it after seeing the mock.

## Non-goals

- Talking to other people's assistants. That still goes only through groups and direct requests.
- New public action types. The three that exist (free/busy, create event, share text) are what others can reach.
- Messages to the asked assistant showing up in its own chat. They appear in its Activity.
- A separate "what I'm good for" description field.

## Anti-goals: these make it a failure even if it works

- A private detail reaching another person through a helper: a meeting title, attendees, notes, anything beyond what a published action returns.
- An agent session running because of someone else's message. Public requests never start an agent. That is an existing guarantee and must stay true when helpers are involved.
- An agent, rather than the decision model, deciding whether someone else's request is allowed.
- Assistants asking each other in loops or long chains.
- The owner having to connect the same calendar, login or skill to several assistants to get this.

## What people see (approved mocks)

**Owner asks, in the asking assistant's chat (option A).** Before the answer, a short line names the helper and what it used: `Asked Work assistant · work calendar · 4 s`, with **Show**. Show opens the exact question sent and the answer received. When the helper did something, the line says so: `Work assistant booked it · Thu 14:00–14:30`, with **Show**. Then the asking assistant's answer follows as normal. The 2.201.3 "Working on it… m:ss" status covers the wait.

**Someone else asks.** The requester sees only the reply, for example "Ilia is free Thursday 11:00–12:00 and 14:00–16:00". Nothing tells them another assistant helped, and nothing beyond the action's result is included. The owner's Activity on the asked assistant shows the request and a line `Used Work assistant's "Read free and busy times"`, with **Show**. The existing approval flow is unchanged. If the helper's action says to ask the owner first, the approval card shows the exact proposal and names the helper action. Approve once, Edit and Reject work as today.

**The helper's side.** Its Activity lists each request it served: which assistant asked, the question, what it answered or did. Its chat stays as it is.

**Resources → Other assistants**, the sixth section after Browser logins, Skills and plugins, MCP servers and Secrets. Each other assistant appears with its name, a short summary of what it has ("Work calendar, KMS Jira MCP, LinkedIn login"), its machine, and the switch.

## How it works: parts already decided

### Owner path: agents ask agents

- The asking assistant's agent gets a new capability, but only in assistant topic conversations. It is scoped like the existing agent capabilities in `src/agent-capabilities.ts`: a per-conversation token and an instructions block. It is delivered as a Joint Bob tool through the bundled bridge (see "Calls the agent made"). It can:
  - **list** the owner's other assistants it may ask, with what each can do;
  - **ask** one of them a message and wait for the answer.
- Asking runs a normal turn of the helper **as the owner**. It goes through the helper's own topic routing and its own agent, with the helper's own resources, so nothing is duplicated. The helper's answer text comes back to the asking agent, which writes the reply to the owner.
- Only turns authored by the owner can ask: the owner's own chat messages, and scheduled tasks routed through the assistant. Turns started by a webhook cannot ask (goal 7), even though they run as the owner. Group messages and direct requests from other people never start an agent, so they can never reach this path.
- Asking is refused when either assistant's project is visible to anyone but the owner (goal 6). This is checked when the ask is made, not only when the switch is shown, because a project can be shared after the switch was turned on.
- Each ask is recorded, with the asking turn, helper, question, answer, what the helper did, duration and outcome. That record feeds the chat line, Show, and the helper's Activity.

### Others path: public actions from helpers, in code

- In `src/social/requests.ts`, triage today offers only the asked assistant's own published actions (`listActions(assistant.id)` filtered to published). It also offers the published actions of the owner's other assistants that this assistant may ask, with each action labelled by its assistant.
- For free times (goal 8), every published free/busy action the asked assistant may use is consulted, including its own. The reply offers only times that are free in all of them. Each action is still judged by the decision model under its own instructions. An action that declines, or doesn't answer, leaves its calendar out. Its busy times are not guessed, and the reply doesn't say a calendar was left out. *(Agent's call.)*
- For a booking, the decision model chooses one create-event action, as triage does today. The event is created only in that action's calendar. Before it is created, the slot is checked against every free/busy calendar from the previous point. If the slot is taken in any of them, no other slot is offered in its place, the same as today.
- A chosen helper action is judged and executed exactly like an own action, but as the helper's action. That means the helper's instructions and instructions digest, the helper's credentials (`calendarEnvironment(helper)`), and the existing proposal, approval and re-check rules. Before running, all of these are checked again: the helper still exists, the switch is still on, and the action and its revision are unchanged.
- No agent runs in this path. The only thing a helper can contribute to someone else is the result of one of its published actions.

### Across machines

- Assistants live in each machine's own `node.db` today and are not replicated. The owner's machines (twins) must share the list of the owner's assistants and what each can do. When something changes, the change is pushed. There is no polling, per the cluster sync rule. A machine that comes back pulls from its peers.
- An ask, and execution of a helper action, go to the helper's execution machine over the existing signed twin channel. A helper on an unreachable machine fails the ask with a clear message. It is not retried in a way that could repeat an action.

## Constraints carried over

- Public requests never start an agent session. The decision model authorizes; code executes the named operations.
- A calendar change that can't be confirmed is marked Uncertain and never retried automatically.
- Secrets are never shown, copied or moved between assistants. A helper uses its own.
- Blocking someone applies to helper actions too. The owner's blocks cover all of the owner's assistants.
- No polling loops for cluster sync.

## Calls the agent made (the user did not decide these)

- **Shared projects block both paths.** A pair whose switch is off because a project is shared is also unavailable for other people's requests. That keeps one rule for the switch, even though the others path writes nothing into a transcript.
- **One hop only.** A helper answering an ask cannot itself ask another assistant. That prevents loops and chains.
- **The switch is directional**, A may ask B, and on by default. Turning it off removes B from A's list and from A's choices for others' requests.
- **Limits for others' requests:** the per-requester daily limit counts on the assistant the person talked to. Decision checks count on the assistant whose action is judged.
- **Owner asks do not need the decision model.** The asking agent chooses which helper to ask. Authorization only matters on the others path, where the decision model already decides.
- **Asking works with the terminal turned off.** An assistant with terminal access off loses every shell tool, so a shell-only CLI would leave it unable to ask. List and ask are therefore exposed as Joint Bob's own agent tools through the bundled tool bridge in `src/mcp/`, which already serves Claude, Pi and Kiro. The terminal filter and the MCP allowlist must not remove them. The builder may add a CLI as well, but the bridge tool is what must work.
- **Helper actions are not advertised to others.** The asked assistant's directory listing, its direct-thread catalog and its "This assistant doesn't offer that. You can ask for: …" reply list only its own published actions. Helper actions are used when a request matches them, but are never published on relays where the helper isn't discoverable. Requesters are never told a helper exists.

## Left to the builder

- The CLI's name, commands and JSON, and its instructions text.
- How the "what it can do" summary is built from attachments and instructions, and how much of it goes to the asking agent.
- Storage for ask records, switches and the replicated assistant list.
- The wait limit for an ask and the copy for a timeout or an unreachable machine.
- Exact UI details within the approved mocks: the wording of the "used" label ("work calendar"), how Show expands, and the Activity row layout.
- Tests. The existing invariant tests for public requests (no agent, decision model only, re-checks) must also cover helper actions.
