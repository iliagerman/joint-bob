# Project knowledge base and rule generation — design

Status: draft for review. Items marked **(my call)** were decided by the author, not by the user.

## Intent

Agents keep repeating the same mistakes across conversations in one project. They struggle to reach a database the same way each time, retry an approach that already failed, stop in the wrong place during a goal, or ask permission for things that need none. Today each conversation starts from nothing.

This feature turns recurring problems into project rules that agents read on later turns. It also keeps those rules accurate over time, so the user doesn't have to maintain them by hand.

## Goals

- Recurring problems across a project's conversations produce rule suggestions. They appear in the Activity side panel, where the skill suggestions are today.
- Anyone who can edit the project accepts or dismisses each suggestion. Accepting writes the rule into the project knowledge base.
- The knowledge base lives in the project folder and is committed with the project. Accepted rules go out with the user's next commit, push or pull request, and travel to every machine like the rest of the code.
- Agents see the list of rule subjects every turn and fetch a subject's rules when the task needs them.
- Agents can add, read, edit and remove rules themselves, following instructions in the global AGENTS.md.
- A nightly job on the relay reviews the knowledge base of every project the relay holds. It removes rules that are redundant or no longer match the code.

## Non-goals

- Replacing the global AGENTS.md or the per-machine agent memory.
- Changing the usage dashboard's "Suggestions" and "Repeated work" views. They are a separate, model-free feature and stay as they are (**my call**).
- Creating rules automatically without a person's acceptance.
- Committing or pushing. Joint Bob writes the files, and the user decides when they go to git.

## Anti-goals

- A rule the cleanup removes wrongly and silently. Every cleanup change is logged in the knowledge folder and shows in the project's git diff.
- Rules that bloat every agent prompt. Only the subject list is always loaded.
- A second place for rules that competes with the knowledge base.

## Constraints

- Project folders already sync between the machines a project is shared with. The `.joint-bob/` folder inside a project never syncs (a locked rule), so it cannot hold the knowledge base.
- Summaries (`transcript_summaries`) stay local to each machine. Everything this feature must share between machines therefore lives in the project folder, not in the summary store.
- The relay holds full copies of the projects shared with it (`test/workspace-relay-sharing.test.ts:53-56`), so it can edit their knowledge bases locally.
- Decisions with a confidence value use the existing decision model: TypeSafe Jev or Laya, configured through the project's secret accounts and routing config.

## What is removed

- The summary writer's `@@skills` section, its parsing, and `SkillSuggestion` (`src/conversation-digest.ts`).
- The skill-suggestion instructions setting (`conversationSkillSuggestionInstructions`) and its admin route (`src/conversation-summary-policy.ts`, `src/server/routes/conversation-digest.ts`).
- The "Skill suggestions" section and the "Generate skill" dialog in the side panel (`public/app/activity-panel.js`, `public/app/activity-skill-draft.js`, `public/index.html`, styles, `public/sw.js` precache).
- The skill-draft endpoints and `src/server/skill-draft-run.ts`. `src/skill-draft.ts` is removed only if nothing else uses it; the builder should confirm (**my call**).
- `skillCatalog` and `usedSkills`, which only fed suggestions. Shared helpers used by other features stay.
- Matching tests and the landing-page copy that describes skill suggestions (`promo-video/landing/features.js`).

## Folder layout

All under `<project>/.agents/knowledge/` (**my call**: `.agents/` already holds project skills).

- `INDEX.md`: one line per subject, with a link to its file, a one-line description and the number of rules.
- `<subject>.md`: the rules for one subject. Each rule has a stable id, the rule text, a short evidence line naming the conversations it came from, and the date it was added. Subjects are short kebab-case slugs.
- `notes/<conversationId>.json`: the problems the summary writer saw in one conversation. Only the machine running that conversation writes its file, so two machines never edit the same note (**my call**).
- `proposals/<id>.json`: one pending rule suggestion per file, with subject, rule text and evidence (**my call**). One file per suggestion means people accepting different suggestions on different machines don't conflict.
- `CLEANUP-LOG.md`: what the nightly cleanup removed, merged or flagged, and why.

Everything in the folder is committed with the project, as the user decided. Notes and proposals are small text files.

## How rules are proposed

- The summary writer already runs after each answer under the summary policy. Its prompt gains a problem-and-rule section in place of the skill section (**my call**).
- From the current conversation, the writer records problems in that conversation's note file: failed connections, an approach retried after it failed, a stop in a bad place during a goal, unnecessary permission requests, and similar repeated mistakes.
- The writer also receives the project's subject list and the other conversations' note files from the project folder, so a repeat on any machine is visible (user's decision).
- It proposes a rule only when a problem repeats, either across conversations or within one, and no existing rule already covers it. It writes at most three proposals per summary, as today.
- The side panel card, where the skill suggestions were, lists the pending proposals for the project. Each has **Add to knowledge** and **Dismiss**. It shows on every machine that shares the project, because proposals are files in the project.
- **Add to knowledge** appends the rule to its subject file, creates the file and its index line if the subject is new, and deletes the proposal file. The user can edit the rule text and subject before accepting (**my call**).
- **Dismiss** deletes the proposal file and records the dismissal in the source note, so the same evidence isn't proposed again (**my call**).
- Anyone who can edit the project may accept or dismiss (user's decision). If two people accept overlapping proposals, the nightly cleanup merges the duplicates.

## How agents use it

- The project's `INDEX.md` is added to each agent's instructions for that project, next to the existing Memory section (**my call**). The agent sees the subjects, not the rules, along with the folder's path for that project.
- The global AGENTS.md gets a fixed section on how to list subjects, read a subject, add, edit and remove a rule, and keep `INDEX.md` in step. It also covers when to ask the user before changing a rule (**my call**: removing or rewriting someone else's rule needs the user's go-ahead; adding a rule from an explicit user correction does not).
- Agents edit the files directly. There is no separate command or API, since these are ordinary project files.

## Nightly cleanup on the relay

- Runs once a day on the relay node (**my call**: 03:00 relay local time). There's no catch-up loop: a missed night simply runs the next night.
- Covers every project the relay holds a local copy of, however it was shared with the relay (user's decision).
- For each subject file, a tool-using review run on the project folder checks every rule against the current code and the other rules, and proposes one of: keep, remove, or merge with another rule.
- The decision model then judges each remove or merge proposal. Above 95% confidence the change is applied to the files. Anything else is left in place and flagged in `CLEANUP-LOG.md`.
- **Flagged items** become proposals in `proposals/`, phrased as "remove" or "merge" rather than "add", so they appear in the same side-panel card for anyone to accept or dismiss (**my call**).
- **Concurrent edits.** The relay skips any rule whose text changed after its copy was taken, and flags it instead. An edit made on another machine always wins over the cleanup.
- **Housekeeping.** The same run deletes note files older than 30 days and proposals older than 30 days that no one acted on (**my call**).
- **Credentials.** Cleanup needs the project's decision-model secret account to be attached and replicated to the relay (`cluster-sharing-policy.ts:370`). A project without one is skipped and the skip is logged.
- The job never commits. Its edits reach other machines through file sync, uncommitted, and go to git with the next commit.

## Left to the builder

- The exact prompt wording for the summary writer and the cleanup review.
- Exact file formats and how the index is parsed when someone edits it by hand.
- How the side-panel card is rendered and how proposal changes from other machines refresh it.
- Test coverage. The existing summary and activity-panel tests change and need replacing.
