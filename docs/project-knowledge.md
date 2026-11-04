# Project knowledge base

Agents in the same project often hit the same trouble again and again: a database they can't reach, an approach that already failed, a stop in the wrong place, a permission asked for something that needs none. The knowledge base turns those repeats into rules that every later conversation reads.

## What you see

The Activity panel has a **Rule suggestions** card where skill suggestions used to be. After a summary is written, a rule appears there when the same problem showed up in more than one of the project's conversations, or twice in one. Each suggestion shows its subject, the rule and the evidence.

- **Add to knowledge** keeps the rule. You can edit its text first.
- **Dismiss** drops it. The same rule is not suggested again for that evidence.
- Anyone who can edit the project can accept or dismiss. Cleanup suggestions to **Remove** or **Merge** a rule show in the same card, with **Apply** to accept them.

## Where rules live

Everything is in `.agents/knowledge/` inside the project, so it is committed with the project and syncs to every machine that shares it. Joint Bob writes the files but never commits them.

| File | What it holds |
| --- | --- |
| `INDEX.md` | One line per subject. Rebuilt from the subject files, so a bad hand edit heals itself. |
| `<subject>.md` | The rules for one subject, each with an id, the rule and its evidence. |
| `notes/<conversation>.json` | The problems the summary writer saw in one conversation. Deleted after 30 days. |
| `proposals/<id>.json` | Rule suggestions waiting for a person. Deleted after 30 days if nobody acts. |
| `CLEANUP-LOG.md` | What the nightly cleanup removed or flagged, and why. |

## What agents do

Every agent gets the project's subject list, not the rules. When a task touches a subject, it opens that subject's file. The global instructions every agent receives explain how to add, change and remove rules, and ask them to check with you before removing or rewriting a rule someone else added. An agent working in a worktree edits its worktree's copy, so its rules go out with that worktree's pull request.

## Nightly cleanup on the relay

A machine that serves a relay reviews the knowledge base of every project it holds, once a day at 03:00 its local time. A missed night is not made up.

1. A read-only agent checks each rule against the project's current code and the other rules.
2. For each rule it wants to remove or merge, the decision model is asked. Above 95% confidence the rule is removed. Anything else is kept and becomes a Remove or Merge suggestion for you.
3. A rule edited since the review is never removed.
4. Everything is logged in `CLEANUP-LOG.md`, and the removal shows in the project's git diff.

Cleanup needs the project's decision model secret (for example a TypeSafe key) to be attached to the project and shared with the relay. A project without one is skipped and the skip is logged.
