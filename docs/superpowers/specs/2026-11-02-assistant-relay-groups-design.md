# Discoverable assistants and relay groups

Status: approved by the user on 2026-11-02, including the clickable mock `mockups/assistant-relay-groups.html` and its Resources tab. Implementation authorized.

Date: 2026-11-02

Builds on [continuous assistant chat](2026-11-01-assistant-mode-design.md) and [chat-first assistants](../plans/2026-11-02-assistant-chat-first.md). This document does not commit or ship the preceding work.

## Intent

People should be able to find one another and their assistants on a relay, form groups by invitation, and request useful actions from assistants. An assistant watches the groups it belongs to and acts according to its owner's instructions. The owner should not need to follow every message, but must retain control over what the assistant shares or does.

The decision model decides whether to act. The executing agent does not make that authorization decision.

## Confirmed requirements

- A person can opt into discovery, and can separately make an assistant discoverable on relays.
- Searching for people or assistants searches all of the searcher's active relays together, not only a selected relay.
- A person may own multiple assistants and chooses one default assistant.
- Anyone can create a group and invite people. A person must accept before joining.
- The default assistant automatically joins groups its owner joins. It leaves when that owner leaves.
- An assistant can be invited independently. Its owner must approve; this does not add the owner to the group. Other assistants can therefore participate without their owner being a member.
- Group members can chat with each other, with human and assistant participants present.
- A member assistant receives the conversation and uses a decision model to recognize direct requests, relevant events and situations requiring attention. An explicit mention is useful evidence, not the only trigger.
- Outcomes include staying silent while recording activity, notifying the owner, performing an authorized action, and preparing a response or action for the owner's permission.
- Owners define public actions, such as seeing calendar information or arranging a meeting, and instructions governing those actions.
- **TypeSafe or Laya decides whether to comply, execute or ask for approval using the owner's instructions. The executing agent cannot grant itself permission or override that decision.** Keep API identifiers `typesafe` and `laya`; user-facing copy says decision model.
- People can discover and contact an assistant directly to request public actions, without sharing a group with it.
- Preserve the existing private assistant chat, resumable topic conversations, settings, saved items, automations and permissions.

## Proposed scope and product defaults

These are the designer's choices for review, not additional requirements attributed to the user.

### Discovery and identity

Discovery is off until the owner enables it, independently for the person and each assistant on a selected relay. Public means available to authenticated people on that relay, not anonymous Internet access. No new relay-local human password account is required: people use their existing Joint Bob sign-in on their own machine.

Search queries all relays where the searcher's machine currently has an authenticated, admitted connection and combines their authorized results in one list. No relay selection is required before searching. Deduplicate the same verified person or assistant across relays by stable identity, not display name, and retain the matching relay routes for subsequent contact. Respect publication visibility on each relay; discovery on one relay does not publish an identity to another. If a relay fails during search, show partial results and identify the unavailable relay rather than silently presenting the results as complete. Combined discovery does not grant cross-relay group membership; joining still requires the group's relay admission and invitation checks.

A directory listing contains a stable identity, display name, optional public description, human/assistant kind, owning identity for an assistant, public action descriptions and reachability. It must not publish email by default, private instructions, credentials, project/session identifiers, calendar contents or private history. A discoverable assistant identifies its owner even if the owner has no searchable personal listing; explain that before publication.

Listings distinguish equal display names by their verified origin. Turning discovery off removes search visibility and stops new unsolicited direct threads, but does not expel existing group memberships or erase accepted threads. Blocking a caller or disabling a public action is a separate, immediate restriction on existing requests too.

### Groups and the default assistant

A group belongs to one relay and has an authoritative host machine, initially its creator's machine. Every authenticated person on an admitted machine can create a group; relay administration permission is not required. Every human member may invite another person or assistant. The creator manages the group and can remove members or close it. Removing the creator closes the group in the first version; transferring group management is later work.

Invitation states are pending, accepted, declined, revoked and expired. Acceptance is authenticated as the invited person or, for an assistant, its owner. A pending invitation grants no transcript access. Repeated acceptance cannot duplicate memberships. Invitation lifetimes are bounded; the implementation plan chooses a consistent expiry.

Acceptance by a person adds the person and the then-selected default assistant as one authoritative membership change. Creation counts as joining too. Record the specific accompanying assistant; do not infer it later from the current default. Its participation is visible to all members, even if it is not discoverable. Its execution node must be admitted to the group's relay and its identity/delegation verifiable; otherwise show the required connection step before accepting rather than silently omitting it. An admitted assistant that is offline still becomes a member, with monitoring shown as pending rather than falsely active.

When the person leaves or is removed, remove their recorded accompanying assistant in the same membership change. Stop new monitoring, cancel pending public work and invalidate approvals for that group. Do not silently remove independently invited non-default assistants. If the default assistant was already a member independently, merge its membership without duplication and link it to the owner's join; it leaves with that owner afterward. Remaining independently would require a new approved invitation.

Changing the default affects future group joins, not existing memberships. Show which assistant accompanies the person in each existing group. Clearing or deleting the default does not pick a replacement silently; joining without a default adds only the person. Replacing assistants in already-joined groups is explicit later work, not an automatic migration in this release.

New members and their accompanying assistants receive messages from their accepted membership onward, not earlier private history. A later rejoin starts a new membership interval. Previously delivered copies cannot be remotely erased by leaving; no new messages or history ranges outside the authorized intervals become readable.

Assistant ownership and supervision are disclosed to members: an assistant can report authorized group information to its owner even when that owner is not a member. The owner may review that assistant's observed activity and decisions, not use ownership to gain independent group membership or unrestricted group APIs.

### Direct requests

A discoverable assistant accepts direct public-action requests from signed-in relay participants without a shared group. These are separate requester/assistant threads, not access to the owner's private assistant conversation. Repeated contact resumes that requester's thread; different callers never share context. Human-to-human communication in this release uses groups; adding a separate human direct-message product is outside this request.

A direct assistant thread exposes the action catalog and request results, not private configuration. A request outside the published catalog cannot become permission merely because it addresses the assistant by name. General social replies, if desired, are themselves explicitly published behavior governed by instructions.

## Assistant resources (approved 2026-11-02)

The assistant page gets a **Resources** tab: Browser logins, Skills, Plugins, MCP servers and Secrets, attached to the assistant rather than to one conversation. Every topic the assistant opens gets them. Only the owner's private chat and its topics use them; group and direct-request work never does.

- **Skills and plugins.** Every skill and plugin active on the execution machine is on by default; the owner turns individual ones off for this assistant. A plugin's skills and MCP servers are unavailable while the plugin is off. Installing new resources stays in Joint Bob Resources.
- **MCP servers.** The existing per-assistant server selection moves here. A server needing sign-in shows **Sign in**.
- **Secrets.** The existing account attachments move here and are copied to new topics as today. The decision model's key cannot be detached while that model is selected. Values are never shown.
- **Browser logins.** A login is a persistent browser profile attached to the assistant. **Add login → New sign-in** creates a profile on the assistant's execution machine and opens it for the owner to sign in through the existing viewer; **Saved login** attaches an existing profile shared with the owner. A profile on another machine cannot be attached or used; **Sign in on <machine>** creates a new profile there and leaves the old one where it is. **Detach** removes the attachment, not the profile. Attached profiles are available to every topic conversation of the assistant. One topic uses a profile at a time; another topic's start waits for it instead of failing. A login challenge or expired login on an attached profile adds a **Sign in** item to the assistant's activity. MFA and CAPTCHA stay with the human.
- **Browser use** remains one switch; turning it off keeps logins saved.
- Lists fit the available height and page with Previous / Next rather than scrolling.

## Implementation decisions (2026-11-02)

These refine the architecture above for the first release.

1. **Directory served by member machines.** Each machine answers directory searches for its own opted-in people and assistants, over the existing signed peer channel, only to machines in the same active relay sharing group as the relay the listing is published on. The searcher's machine asks every member of each of its active relays and merges the answers. No relay-server change is needed and relays never store listings. A machine that is offline is not listed; an inactive relay is reported as unavailable.
2. **Public actions run in code, not in an agent.** Published operations are code adapters with fixed scopes: calendar free/busy, calendar event creation, and sharing an owner-written text. Dates, times and durations are parsed and validated by code; replies are composed by code from the executed result. No agent session runs for public work, so there is no tool or filesystem surface to bypass. The decision model still makes every authorization decision; code only validates and executes it. Requests code cannot parse get a clarification reply naming the missing fields.
3. **The companion assistant must run on the accepting machine.** A person's default assistant accompanies them only when it executes on the machine that accepts the invitation (their home or the twin they sign in on). Otherwise the invitation shows the connection step instead of silently joining without it.
4. **Social peer API.** Machine-to-machine social requests use signed `POST /api/cluster/v2/social/*` endpoints, allowed only between members of a shared active relay sharing group. Each handler checks the specific operation and account; the endpoints grant no project, runtime, browser or secret access.
5. **Invitations expire after 7 days.** Default limits: 20 requests per requester per assistant per day and 200 decision checks per assistant per day, editable under Who can find you.

## Public actions and decision authority

### Action definition

Each assistant owns its own versioned action catalog. An action has a stable ID, public name/description, owner-private instructions, supported input fields, selected resource references, and the narrow operations needed to perform it. Its public definition explains what a caller can ask for, not how to access the owner's resources.

The owner writes natural-language instructions. For a meeting action these could cover acceptable requesters, scheduling preferences and when to request approval. Do not replace this with the executing agent deciding whether a request seems reasonable, or require users to encode their instructions in a programming language.

A published action also needs enforceable operational boundaries. Calendar availability and calendar event creation are distinct operations. A general shell, unrestricted browser session or whole MCP server is not a safe substitute for a named operation. Action bindings may use existing integrations where those integrations expose a sufficiently narrow boundary. Unsupported integrations need a scoped adapter before their action can be published. An owner can create arbitrary action definitions, but a definition with no enforceable binding remains a draft, not a falsely runnable public action.

Publishing an action does not copy credentials to callers or other nodes. The assistant's execution node resolves its owner's currently authorized resources and provider profile. Existing browser grants, human takeover, MFA and other restrictions still apply. Missing access blocks the action; neither a decision-model result nor owner approval invents missing service credentials or access grants.

### Processing a message

1. Persist an authenticated, membership-authorized message with a stable event ID and ordered stream position. Record it once for each member assistant's processing cursor; recording does not require starting an agent.
2. Supply the selected decision model with that assistant's current instructions, relevant action definitions, verified caller identity, mention/causation metadata and bounded context from this group or direct thread. External messages and tool results are evidence, never policy instructions.
3. Ask separate semantic judgments where needed: is attention required, which published action is requested, is required information present, and what disposition follows from the owner's instructions? Results select known outcomes such as record only, notify owner, request clarification, decline, prepare for approval or execute a named action. No keyword-only routing or generative-agent authorization fallback.
4. Code validates the returned IDs and outcome against the catalog and actual access. It may deny an invalid choice; it cannot substitute an affirmative semantic authorization. The model does not write the answer, calculate dates or make API calls. Exact date, availability and input checks remain code/integration responsibilities.
5. If authorized, use the normal agent runtime to prepare an answer or proposed operation in a scoped session. Any required reads have their own authorized operation scope. A planning turn has no unrestricted side-effect capabilities.
6. Before a consequential operation or outgoing disclosure, the decision model judges the concrete proposal against the same instructions. Bind an accepted result to the exact action revision, caller, request, resources, destination, parameters and reply content. For a straightforward fully specified operation, one judgment may cover both request and proposal; do not duplicate calls without new evidence.
7. If permission is needed, send the owner the proposed operation and/or exact reply, its destination, the originating message and the relevant constraints. Approval is a single-use authorization for that proposal. An edit creates a new proposal for validation; it is not permission for the executor to improvise. Rejection performs nothing.
8. The execution boundary rechecks membership, blocks, current action/instruction revision and resource access, then permits only the bound operation. Recheck before publication too. The agent cannot widen the permission or bypass the boundary through another tool.
9. Record the decision, proposal, approval if any, operation receipt and delivered result. Publish only the result authorized for that caller/destination. Notifications and approval requests go to the owner's private assistant activity, not the group.

Assistant-wide monitoring instructions can authorize owner notifications or recording. They do not make unpublished external actions available to strangers. Requests to speak in the owner's name follow those instructions and approval decisions; the resulting message remains visibly attributable to the assistant acting for the owner, rather than masquerading as a manually typed human message.

A missing, failed or invalid decision-model response pauses the request with an explicit status. Uncertain decisions do not execute; request clarification or owner review using bounded handling chosen and tested in the implementation plan. Do not invent production confidence thresholds. The owner approving a frozen proposal is not an executing agent overriding a decision.

### Isolation is required, not prompt-only

Keep owner-private chat, each direct requester thread and each group in separate context domains. Public turns cannot search or resume owner-private topics, copy their source history or inherit all their secret accounts. Topic routing may reuse the existing logic only with candidates and recall evidence already confined to the authorized domain.

Reuse existing runtime, scheduling and provider-account machinery where applicable, but add trusted server-side public-turn context and an enforceable operation gate. The existing `setTools` name list and tool-policy prompt are not sufficient to authorize particular parameters or data disclosures. A harness that cannot prevent bypass of the action gate is unavailable for public execution until supported; private assistant use remains unchanged. No unrestricted filesystem or process access to the owner's project, home, credentials or native browser profiles in a public execution session.

Assistant messages carry origin and causal-chain metadata. Evaluate them for monitoring, but do not let assistants start autonomous reply loops. Proposed first-release rule: an assistant can notify its owner about another assistant's message, but cannot create a new public execution chain solely from that message. Continue only an already-authorized bounded request or wait for a human request/approval. Persist deduplication before effects, not just after posting a reply.

## Architecture grounded in the repository

### What exists

| Area | Verified behavior and consequence |
| --- | --- |
| `src/relay/relay-server.ts`, `protocol.ts`, `runtime.ts`, `identity.ts` | Authenticated machine admission, presence, signed identity and Noise-encrypted peer channels exist. No social user directory, human invitation workflow or group message store was found in these flows. Reuse transport, not machine membership as human consent. |
| `src/relay/sharing-groups.ts` | A relay's sharing group is a machine cluster for explicitly shared workspaces. It is not a chat group and must not be repurposed into one. |
| `src/server/http-auth.ts`, `src/relay/sharing-groups.ts` | Signed peer requests also pass channel-sender and resource checks. Merely pinning a social contact's key must not grant runtime, login, project or resource access. |
| `src/accounts.ts`, `src/auth.ts` | Account IDs derive from authoritative home identity and username; twin handling exists. A relay-authenticated node is not automatically proof that it owns an arbitrary claimed account ID. |
| `src/personal-assistants.ts` | Multiple owner-bound assistants, immutable source identity, execution preferences, topics and turns exist. Discovery, a per-person default, public actions and social memberships do not exist here. |
| `src/server/routes/personal-assistants.ts` | Private routing can consider owner-accessible project history and copies source-conversation secret accounts into new topics. Do not send strangers through this path unchanged, including its trusted automation entry. |
| `src/server/conversation-prompt.ts`, `src/server/harness-chat.ts`, `src/harnesses/runtime.ts` | Queueing, attribution, execution settings and tool selection exist. The runtime contract has no general parameter-bound public-action authorization hook; implementing one is substantive work. |
| `src/classifiers/conversation-routing.ts` | TypeSafe/Laya topic selection exists separately from difficulty scoring. It is not an action-authorization classifier. Its provider context budgets differ, so silent truncation of policy is unacceptable. |
| `src/message-authors.ts`, `src/conversation-notifications.ts` | Attribution and notification patterns exist for project conversations. Social messages need their own verified human/assistant author envelope, not a forged owner-authored project prompt. |

### Directory, transport and hosting

Use the relay for opt-in directory metadata and routing to participants' machines. Register a signed person/assistant listing through an admitted connection. The registration must prove the account's home authority and, when different, its delegation to the assistant execution node. Derive and verify the existing account identity, and use verified twin/home relationships rather than trusting caller-supplied `accountId`. A relay signature alone cannot authorize one member machine to impersonate another's users. Persist revisions and revocations; identity-authority changes require verified continuity, never silent reassignment.

Add a narrowly scoped social peer API for discovery registrations, invitation delivery, membership operations, message append/read and receipts. Reuse request signatures, replay protection and Noise peer transport. Authorization must check the specific social operation and account identity independently of project sharing. Do not broadly relax `relayPeerRequestAllowed`, expose a remote chat socket, or grant normal cluster access just because machines share a relay.

The group host owns its membership log, ordered messages and delivery state. Direct assistant threads are hosted on the assistant's execution node. This avoids introducing a new replicated chat service or sending message plaintext through relay control frames. Directory entries route to those hosts without creating login or workspace access.

The relay can observe directory information and traffic metadata, but machine-to-machine message bodies stay inside existing encrypted peer channels. Participating host machines and selected decision/agent providers necessarily receive the content they process. The group creator's machine is a trusted content host, not cryptographically excluded. A relay that is itself the group host also has that role's access. Existing phone-gateway TLS termination remains visible to the gateway; do not advertise a stronger end-to-end guarantee for browser use than the existing product provides.

The first version has no automatic host migration, cross-relay group federation or offline execution against stale membership. If a host is offline, show that state and retain local pending sends; they become accepted only when the host verifies current permissions and acknowledges them. Reconnect sends use the same IDs. No automatic replay of an external side effect with an uncertain result.

### Persistence and revocation

Keep schema and endpoint naming to the implementation plan. The necessary records are:

- Per-account default assistant and per-relay person/assistant discovery settings, with authority and revision.
- Per-assistant public actions, private instructions, bindings, enabled state and revision.
- Hosted groups/direct threads, invitations and membership intervals. Companion membership records the owning human join and the actual assistant ID.
- Ordered authenticated messages, receipts, durable outgoing messages and per-assistant cursors.
- Decision requests/results, frozen proposals, pending approvals, single-use execution authorizations and effect receipts.

Use SQLite transactions and uniqueness constraints for membership changes and deduplication. A stable operation ID survives retries and process restarts. Claim before dispatch; confirm from the integration receipt before reporting success. Where an integration lacks idempotency or receipt lookup, an interrupted dispatch becomes uncertain and needs human reconciliation rather than a blind retry.

Revalidate and revoke at dispatch as well as at request creation. Leaving, removal, blocking, disabling an action, editing governing instructions, deleting an assistant or losing resource access invalidates outstanding authorization. Current membership must be confirmed with the host before a group operation starts or publishes. Membership changes and dispatch require a defined serialization point: an operation already dispatched under a valid claim cannot be undone by a later leave. A local leave cancels local work immediately while its host acknowledgement is pending; do not show globally completed removal before acknowledgement.

Do not replicate public-action private instructions, approvals, credentials or private execution transcripts to every relay machine. A removed member loses live access, even when old directory or transcript caches still exist. Existing private assistant storage is preserved; add domain markers or separate social records rather than migrating private history into group storage.

## User-facing behavior to cover in implementation

The approved layout is the clickable mock `mockups/assistant-relay-groups.html` (desktop and mobile). The list below remains the behavior contract.

- Select the default assistant and opt into person/assistant discovery per relay without leaving the assistant context unnecessarily.
- Find people and assistants, inspect public action descriptions and start direct requests.
- Create groups, invite people/assistants, accept or decline invitations, see participants and ownership, send messages, leave and manage removal.
- See the accompanying assistant as a real member, including unavailable monitoring status.
- Publish, edit, disable and test an action using a preview that cannot create real external effects.
- Review owner notifications and exact approval proposals in the private assistant experience. Closing them returns to the same private assistant chat.
- Distinguish recorded, awaiting decision, awaiting owner approval, executing, completed, declined, blocked, failed and uncertain states. Queued is not completed.
- Provide caller blocking and bounded invitation/message/decision-work limits so discovery cannot cause unlimited agent runs or charges.

## Non-goals and anti-goals

- Do not replace relay workspace sharing, cluster membership, existing sign-in or the private assistant runtime.
- Do not make all assistants accompany their owner or add an owner when only an assistant was invited.
- Do not grant public callers project access, browser profiles, secrets or private chat history.
- Do not let the executing agent authorize requests, add tools or change public policy because group text tells it to.
- Do not build anonymous public endpoints, cross-relay federation, automatic host failover or a generic programming language for policies in this release.
- Do not claim arbitrary existing shell/browser skills are safe public actions without an enforceable operation boundary.
- Do not promise exactly-once effects at an external service that cannot confirm them.

## Verification required before shipping

1. Independent discovery opt-ins; multiple assistants with one default; no private fields in directory responses; same-name users from different homes remain distinct. One search returns authorized matches from every active relay, deduplicates verified identities while preserving routes, and reports partial failures. Inactive, unauthorized or unpublished listings are excluded.
2. Ordinary users create groups and invite without relay admin rights. Only the intended invitee/assistant owner can accept. Replay, expiry and revocation are enforced.
3. Human acceptance atomically adds the recorded default assistant. Independent assistant acceptance does not add its owner. Leave/removal cancels the companion's access and pending work; changing defaults does not orphan the original companion.
4. Membership interval history restrictions, pending invitations, direct-thread caller isolation, and same assistant in several groups with no cross-group disclosure.
5. Forged account IDs, fake assistant ownership, stale delegations, revoked machine admission and social requests attempting project/runtime access are denied.
6. Every semantic action decision uses the selected TypeSafe/Laya path. The executor cannot self-authorize, even with a direct mention or a malicious instruction in group text/tool results.
7. Record-only messages start no agent; notifications reach only the owner; approval shows exact content and destination; stale, edited, duplicate or revoked proposals cannot execute.
8. Calendar fixture distinguishes availability from event detail and event creation. Meeting inputs/time zones are validated by code; unavailable slots do not silently produce another appointment. Exercise another synthetic non-calendar action to prove the catalog is not calendar-specific.
9. Decision failure/uncertainty, unsupported runtime/integration and insufficient policy context fail explicitly without side effects or a different-model authorization fallback.
10. Bypass attempts through shell, filesystem, browser, alternate MCP operations, direct sockets and inherited secret scopes fail at the execution boundary, not merely in prompt text.
11. Idempotent delivery and effect claims survive restarts, repeated requests, disconnections and multiple logged-in devices. Unknown service outcomes are not replayed. Membership/dispatch races follow the documented serialization point.
12. Assistant-to-assistant messages do not create reply storms. Rate limits protect owners before expensive decision/agent calls, without treating an explicit mention as authorization.
13. Mobile and desktop journeys cover discovery, invitation, companion membership, direct request, approval and return to the same private assistant chat.
14. Existing assistant chat, topic resume, saved items, cron/webhooks, relay transport and resource-sharing tests still pass.

Use the isolated harness described in `TESTING.md`, synthetic accounts, loopback fixture servers and mocked decision/calendar providers. Retain the decision-network guard and remove production decision-service credentials. Do not make live decision-service calls, create real calendar events or contact real relay users during automated verification.

## Design review status

A separate read-only builder check returned "nothing important left" on 2026-11-02. Final scope review excluded unrequested human direct messaging and clarified relay admission for the accompanying assistant. These are design checks, not implementation or security-test results.

The user approved this description and the mock on 2026-11-02. The implementation plan is `docs/superpowers/plans/2026-11-02-assistant-relay-groups.md`.
