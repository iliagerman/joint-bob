# Control center: one place to see and steer every agent

Status: draft for approval, 2026-11-04. Approved mock (direction): `mockups/command-center.html`. The user said "looks good" to its second version and then added four changes, which are all in the mock and in this document.

Builds on what exists: assistants and their chat-first routing (`docs/superpowers/specs/2026-11-01-assistant-mode-design.md`), auto respond (`docs/auto-respond.md`), the per-conversation running summary (`src/conversation-digest.ts`), the Canvas, scheduled tasks and webhooks, project knowledge (`docs/project-knowledge.md`) and the decision-model clients in `src/classifiers/`.

## Why

The user runs many agents across many projects and machines, and keeps a developer's job: decide, review, unblock. Today they open each project, find the right conversation, remember what was running, and type the same opening lines ("make sure your latest code is from main"). They want one screen that shows every agent running right now, with what each one is doing, and one agent that acts as them: it can answer questions about any project, start or continue work in the right project, watch that work, answer routine questions as them, and bring back only what needs their decision. In their words: a command center, "from a single place access all my agents and ask them questions and delegate tasks."

It speeds the developer up and never replaces them: Bob prepares, delegates and reports; the user reviews and decides.

## Goals

1. **A control center screen** with three parts: a project list on one side, a board of live agents in the middle, and a chat with **Bob** (the top agent that acts as the user).
2. **Live board.** One card per running conversation across all projects and machines. Cards are grouped as *Needs you*, *Running*, *Done · ready for review*. Each card shows project, title, who started it (the user, Bob, or a schedule), harness and model, machine, elapsed time, and a **live line** that is the conversation's running summary, updated as it changes. The card opens to the full summary and recent steps.
3. **Project overview.** Selecting a project shows its conversations as short headlines, what changed recently, its automations and its knowledge, with buttons to ask Bob about it or start a task there.
4. **Open a card = open the conversation** over the board. The user can read it and reply themselves. **While it is open, Bob does not drive that agent** (no auto answers, no new instructions). The card says "You're in it". Closing hands it back to Bob.
5. **Bob chat.** Questions about any project; delegating tasks; answering and escalating. Every project agent Bob starts is an ordinary conversation in that project, listed in the normal conversation list and marked as started by Bob, so everything stays traceable and the user can take over any of them. Several conversations per project are fine.
6. **Decision model first.** The decision model (TypeSafe or Laya, as already chosen in settings) makes every routing choice. Only when its confidence is **below 90%** does Bob's full agent decide instead. The threshold is a setting (default 90). Questions that don't depend on each other go to the decision model in **one request** (the API takes several questions at once). Choices Bob needs, in order:
   1. What the message is: a question, a new task, more work on an existing conversation, an automation change, or the user's answer to a waiting question.
   2. Which project. Recent projects are the options, each with a few short headlines of its recent conversations. Large sets are split into groups asked **in parallel**, then a final choice among the group winners. Laya reads far less text than TypeSafe, so its groups are smaller.
   3. Which existing conversation to continue, or a new one (the assistants' router already does this).
   4. Short or long job. Short: answer in Bob's chat from summaries, memory and a quick look at the project. Long: start a conversation in that project.
   5. Which memory topics matter for this message.
   6. When a project agent stops: finished, a routine question Bob may answer, or a question for the user.
   7. After an exchange: is anything worth remembering. Only a yes makes the agent write.
   If neither the decision model nor Bob's agent is sure which project, Bob asks the user with a short picker.
7. **Bob's agent is configurable from the chat**: harness, model and effort, plus the decision model and the confidence threshold. **Agents Bob starts use Bob's own harness unless the user says otherwise** in the message ("do it with Pi on Bedrock").
8. **Bob learns, in files.** Bob has a memory of **topic files**, one subject per file, each linked to related topics and searchable. Bob always has the list of topics with one line each; before acting, the decision model picks the relevant topics and Bob reads them first. It learns from the user's corrections, preferences and decisions.
9. **The user can review everything Bob writes for itself.** A **Bob's memory** tab lists topics, shows and edits each file, and has a **What Bob changed** list: each change as a diff, what taught Bob (the message or conversation), when, with **Keep / Edit / Revert**. Changes have history. A switch **Ask me before Bob saves anything** turns every write into a pending change.
10. **Free placement.** Cards can be dragged anywhere on the board and given any color with a color picker; the whole card takes the color. A **Grouped / Free** switch and **Reset layout** (back to the default arrangement, colors and filters) are always available.
11. **Project filters.** A project filter row (multi-select chips) applies to the live board, clusters, automations and memory topics. Selecting a project in the left list sets the same filter.
12. **Quick in and out.** One button in the normal toolbar, a keyboard shortcut (Cmd/Ctrl + `.`) and a phone shortcut open the control center; **Esc** or **Exit** returns to the workspace. The workspace toolbar shows a badge with the number of agents waiting for the user, so they know without opening it.
13. **Clusters.** A **My agents / Clusters** switch shows the running agents of other people in the user's clusters, grouped by person, limited to what they share. The user can dive into one read-only. Bob can summarise them and answer questions about them but never answers for them.
14. **Automations in one place.** A table of every scheduled task and webhook in all projects with on/off, last result, edit and delete, and create. Bob can list, create, change, pause and delete them from chat; the list and the chat always agree.
15. **Where the chat lives.** The chat panel is resizable (drag its edge) and can sit on the left or the right. Both choices are remembered.

16. **Move jobs to another node.** The user can tell Bob "move all my running jobs from the Mac to the homeserver" (or move one). Bob lists each running conversation with what will happen and asks once before doing it. A conversation moves through the existing ownership transfer, after its current turn ends (or at once if it's waiting for the user); the user can choose to stop the turns and move now. A conversation that can't run on the target (for example its harness, model or login isn't set up there) is listed with the reason and is not moved. Schedules move with their owner as today. The node strip on the board also has **Move all…** per node.
    **Bulk and aggressive moves.** The board has **Select** (checkboxes on cards) and **Move all…** per node (preselects every unfinished agent on that node). The bulk bar offers a target node and two ways: **Stop and move now** stops each running turn, moves the conversation, then sends it "Continue where you stopped: you were moved from <node> to <node>. Check what was half done before repeating anything."; **Move after current turn** waits as above. The same works from chat and Telegram ("move everything off the Mac now"). Bob confirms once for the whole batch, lists what can't move and why, and never replays an interrupted send, upload, deploy or trade: the continue message tells the agent to check state first.
17. **Story and Overview from a card.** Each card has **Story** (the change story) and **Overview** (the two-host Activity overview) buttons, also in the open conversation. They use the existing generators and open over the board when ready.
18. **Watch or take control.** A card offers **Watch** (read the live conversation; Bob keeps driving) and **Take control** (reply yourself; Bob stops driving it until the user gives it back or closes it). Opening a card defaults to Watch; Take control is one click, on the card or in the open view. Other people's agents are always read-only. This refines goal 4: the "never two drivers" rule applies once the user takes control.
19. **Pause and restore the monitor.** One switch in Bob's header pauses everything Bob does on its own (watching agents, answering as the user, starting scheduled follow-ups, handling incoming triggers) and restores it later. While paused, agents keep running, nothing answers for them, questions wait on the board, and a banner says so with a **Restore** button. Bob's chat still answers the user's own messages unless the user also stops it.
20. **Incoming triggers.** Webhooks (for example a GitHub issue or PR, an alarm, a Stripe event) appear as incoming items. The decision model rates each **urgent or not** (below the 90% confidence the agent rates it). Urgent ones show in Bob's chat with actions (investigate read-only, open, snooze). The rest go to a **bell** with a count in Bob's header; its list shows each item, the rating, and **Open / Ask Bob to triage / Dismiss** so the user can handle them later. Bob never acts on a trigger beyond what the user already set up for that webhook, except a read-only investigation the user chooses.
21. **Dashboards.** Bob can create dashboards for a project and for the user's own workspace, using the existing dashboard feature (dashboard-creator agent, bundled widgets, data scripts, manual refresh, node approval rules in `2026-10-24-dashboards-design.md`). Dashboards are reachable from a **Dashboards** entry in the left list, a **Dashboards** tab, and a **Dashboard** button on every card (that project's dashboard). The tab lists project dashboards and "for me" dashboards as cards (with who made it, when it was refreshed, and whether it refreshes by script or AI). **One click on a card shows the dashboard** over the board, with Refresh and "Ask Bob to change it". Bob says when a refresh costs AI.

22. **Production and destructive steps always ask the user, checked through Guardian.** Bob and every agent it starts run under a Guardian rule, "production or destructive" (deploys, prod infrastructure, pushes or merges to main, deleting data, files, automations or conversations, force operations, real money), checked by the decision model before commands and file changes, set to **ask me**. Bob's own actions go through the same check (moving jobs, deleting or pausing automations, stopping turns). The review appears as a red **Needs your OK** card on the board and in Bob's chat, with **Allow once / Block / Open**, and in the conversation as Guardian already does. **Bob never approves a Guardian review**; only the user does. Guardian's existing rules hold: nobody answering in 10 minutes blocks it, and when the model can't answer the action is blocked. The rule is on for everything Bob touches and can't be turned off from the control center. This relies on Guardian being on for the node; if it is off, Bob's chat says production steps are unguarded and Bob asks the user itself before any action of its own it would class as production or destructive.
23. **Auto respond is Bob's tool.** For each conversation Bob watches, Bob decides whether to turn on that conversation's **auto respond** (with instructions Bob writes from the user's standing instructions and memory, and stop instructions that always include "a production or destructive step", "a plan to approve" and "something only the user can decide") or to answer the agent itself. The card shows "auto respond · set by Bob · n/limit". **When auto respond ends** (a stop instruction held, the limit was reached, the turn failed, the user pressed Stop, or no budget), **Bob is notified** with the reason and the last message, and decides the next step: answer itself, turn auto respond on again, move the card to Done, or bring it to the user. A user's own auto respond settings on a conversation are never overwritten; Bob only turns on auto respond where it is off, and turns off only what it turned on.

24. **Schedules for Bob.** Scheduled tasks can be assigned to Bob itself, not only to a project, for example a **morning report** (08:00: what finished overnight, what waits for the user, failed runs, incoming, spend) and an **evening report** (19:00: what got done, what is still running, decisions waiting, cost by project), across all projects or chosen ones. They appear in Automations with owner **Bob** and are created, edited and deleted there or from chat ("also send me an evening report at 7pm"). The output posts in Bob's chat and, when chosen, to Telegram, with buttons for the items that need the user.
25. **Phone view, chat first.** On a phone the control center is Bob's chat: a header with monitoring state and the bell; a strip of chips (needs your OK, need you, running, to review, dashboards) that opens a compact **agents sheet** with one row and one action per agent; inline approvals and questions in the chat; a composer with project and agent chips, voice and send. The full board stays on desktop.
26. **Telegram, only the user.** Bob can be connected to its own Telegram bot, reusing the assistants' Telegram connection (token, one-time link to the user's own Telegram account, voice transcription and voice replies). Bob's bot **answers only the linked user**: no groups (it leaves any group at once), anyone else gets no answer. It sends reports, urgent triggers, questions and Guardian reviews with buttons, and accepts anything the user can do in Bob's chat: questions, tasks, answers, moves and approvals.

27. **Bob talks to the user's other agents.** Bob can ask any assistant the user owns on the machines of their relay cluster (for example a marketing agent, the personal assistant, a work assistant) and bring the answer back, using the existing assistant collaboration (`2026-11-03-assistant-collaboration-design.md`): Bob is one more of the owner's assistants, asks run a normal turn of the helper as the owner with the helper's own logins and tools, each ask is recorded and shown as "Asked <assistant> · <what it used> · <time>" with **Show**, the per-pair **may ask** switch applies (on by default), and an assistant whose project is shared with anyone else can't be asked (shown with the reason). Bob may ask **whoever the user may ask**: the user's own assistants, and other people's assistants only the way the user can (groups, direct requests and their published public actions, each decided by the other side's decision model and limits). Bob never gets more reach than the user. The decision model picks which assistants a message needs (several can be asked in parallel); below the threshold Bob's agent decides.
    **Where they show.** An **Assistants** section lists each assistant with its machine, busy or idle, what it has attached, the last ask and the **may ask** switch. There are no ask buttons: the user just asks Bob. **Clicking an assistant opens its own chat** over the board, where the user can read it, see what Bob asked it (marked as Bob's) and message it directly; its attached resources and Bob's asks are listed beside the chat. On extra-wide screens (about 1700 px and up) it is a column on the same page, between the board and Bob's chat; on smaller screens it is an **Assistants** tab. On the phone it is a chip that opens the same list as a sheet.

28. **Filter and label the chat.** Every item in Bob's chat carries two labels, a **project** (or General for cross-project items such as reports) and an **importance**: *Needs OK* (a Guardian review), *Urgent*, *Needs you*, *Report*, *Done* or *FYI*. The chat has a project filter and importance chips (All, Needs me, Reports, FYI) with a "n of m" count. A message and the replies and notes that follow it share one label set (the highest importance among them), and filtering hides or shows them together. The decision model assigns the labels when the item is created (the same call that picks the project), so they are stored with the message, not guessed when filtering.

## Non-goals

- Replacing the normal conversation view or the Canvas. The control center is an overview and a router, not a new place to read transcripts.
- Bob working in a project itself. Work is always done by a normal conversation in that project.
- Bob answering for another person's agent, or any agent the user has open.
- Speaking to other people's assistants (still groups and direct requests).
- A new memory format that bypasses existing project knowledge: project rules stay in `.agents/knowledge/`; Bob's memory is about the user and cross-project habits.

## Anti-goals: failures even if it technically works

- Bob changing, deleting or pausing an automation, or pushing, merging, deploying or deleting anything, because of its own judgment. Those need the user, unless the user's message asked for exactly that.
- Bob answering a question that changes what users see, a plan that needs approval, or anything the user said they decide themselves, instead of bringing it back.
- Bob and the user driving the same agent at once.
- A silent memory write the user cannot find, see the reason for, or undo.
- A confident wrong project: a task started in the wrong project. Low confidence must ask, never guess.
- Another person's private conversation content shown to the user beyond what the cluster shares.
- Extra model calls where the decision model could decide, or slow answers because everything waits for the full agent.

## Constraints and existing rules this must keep

- The decision model decides, per the existing assistant guarantees; the agent never judges whether a *public* request from someone else is allowed.
- Existing guarantees for assistants stay: public requests never start an agent session.
- Guardian, secrets isolation, ownership (a conversation runs where it is owned) and replication rules are unchanged. Bob runs on the node the user chooses; conversations it starts run where their project runs.
- UI: lists fit the height and page rather than scroll; management UIs live in Settings tabs, not extra dialogs (existing user preference). The control center itself is the one new screen.
- The controls and memory are per user; multi-user safe (one Bob per user).

## Decisions taken by the user

- Bob acts as the user across all projects; a single interface; multiple conversations per project, all visible under the regular conversations.
- Combination of the assistant feature (routing, continuous chat) and auto respond (answering as the user when a project agent stops).
- Live board with a summary line per card and drill-down; ask questions and delegate from one place.
- Bob can create, change and delete scheduled tasks and webhooks.
- Decision model for as much as possible; below 90% confidence (changeable) the regular model decides; the user picks harness, model, effort of Bob's agent while chatting.
- Agents Bob starts use Bob's harness unless told otherwise.
- Cards freely movable with reset; project filters; quick in and out; review of Bob's memory files.
- Memory is topic files, indexed and linked; Bob sees the topic list and opens relevant topics.
- Chat panel resizable and placeable left or right.
- Opening a card hands that agent to the user until closed (refined: Watch by default, Take control to hand it over).
- Move all running jobs to another node by asking Bob; Story and Overview from the card; pause and restore the monitor.
- Urgent incoming triggers in the chat (decision model rates), the rest in a bell the user opens later.
- Bob creates dashboards for projects and for the user, and one click on a card shows them.
- Aggressive bulk moves: stop the turns, move, and tell each to continue on the new node.
- Scheduled tasks for Bob (morning and evening reports across projects).
- A minimal, chat-oriented phone view, and a Telegram connection that answers only the user.
- Bob can ask the user's other agents in the relay cluster (marketing, personal assistant), shown in their own section: on the same page on XL screens, a separate tab on smaller ones.
- **Below the threshold, Bob's agent checks.** Whenever the decision model is under the confidence threshold, for any choice including whether a trigger is urgent, Bob's full agent looks at the actual issue and decides.
- **Every production-related or destructive step needs the user's confirmation**, with the decision model doing the check through **Guardian** (see goal 22).
- **Bob decides per conversation whether to turn on auto respond or answer itself**, and **Bob is notified when auto respond ends** (see goal 23).

## My calls, to confirm (not yet agreed)

- **Short vs long.** Short = answered in Bob's chat from what Bob already knows plus a quick read. Long = starts a conversation. Boundary is the decision model's choice, adjustable by the user saying "do this in the project".
- **When a project agent stops** and Bob answers itself: Bob answers routine confirmations as the user would, from one set of standing instructions for all projects (editable in Bob's settings, written from memory), and brings back anything that changes behaviour users see, plan approvals and anything it is unsure about. Per-conversation answer limits follow auto respond's.
- **Starting tasks.** Bob starts a new task without asking when the decision model (or, below the threshold, Bob's agent) is confident about the project and the task. Confirmation is required only where goal 22 applies.
- **Bob's memory** is stored on the node where Bob runs, as plain markdown files with an index, and replicated to the user's twins like other per-user settings. Changes are written immediately and shown for review (Keep/Revert), unless **Ask me before Bob saves anything** is on.
- **Clusters** show only agents that people share with the user; other people's agents open read-only.
- **Bob's agent session**: one long-lived conversation per user, like an assistant, with the routing keeping its topics separate.

- **"You're in it".** Applies when the user has the conversation open anywhere (the board popup, the normal workspace, another window or device). It is a lease held by the owner node, renewed while a page is open and dropped a short time after the last page closes or the node loses it. A turn Bob started before the lease finishes normally; Bob sends nothing new while it holds.
- **Board columns.** *Needs you* = the agent stopped on a question or permission, or Bob escalated it. *Running* = a turn in progress. *Done · ready for review* = finished and not yet reviewed, using the existing review marks; marking it done or reviewing it removes the card. Older finished conversations are not listed.
- **Cluster sharing.** First version shows only what the cluster sharing already exposes (shared projects and their conversations); no new per-conversation sharing control.
- **Where things live.** Bob's memory and the automations table are tabs of the control center, as in the mock. Their content is the same data the Settings tabs and project pages edit; no second copy.
- **Bob's node and twins.** Bob and its memory live on the node the user chooses; memory replicates to twins like other per-user settings; two edits to one topic keep both in its history and the later wins. If the node is offline the board still shows agents from other nodes and chat says Bob is away.
- **No usable decision model** (not configured, timeout, error): every choice goes to Bob's full agent. It is slower and costs more; the chat shows a one-line notice.

- **Telegram can do everything the chat can**, including allowing or blocking Guardian reviews (user decision, replaces my earlier suggestion to keep approvals in the app). The linked Telegram account is therefore as trusted as the user's session: the one-time link, the check that only the linked account is answered and the advice to turn on Telegram two-step verification (as in `docs/assistants.md`) are the protection; Bob's settings say this plainly where Telegram is connected.

## Left to the builder

Storage layout and replication of the memory files and their index; the exact prompt and criteria wording for each decision question; how to batch questions into one request and split large option sets per decision-model limits; how live lines are streamed to the board (reuse the digest push); where the controls live in the toolbar and on phones; tests; the transition from the existing assistant code (whether Bob is a special kind of assistant or reuses its router).
