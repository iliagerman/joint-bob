# Guardian

Guardian asks a decision model yes/no questions about what an agent is about to do, and stops it, asks you, or fixes the content when the answer is yes. Turn it on in **Settings → Guardian** (node admins only). Once on, it covers every conversation and agent on that machine: Pi, Claude and Kiro, scheduled runs, webhooks and helper agents.

## Rules

A rule is a question ("Could this action delete data, or make a change that cannot be undone?"), when to ask it, and what to do when the answer is yes. Three ready-made rules come with it: dangerous commands, secrets and personal information.

- **Check:** before commands, before file changes (writes, edits, moves, deletes), before anything is sent to the AI (your messages and what tools return), or before every action.
- **If yes:** ask me, block, or fix it and continue. A fix is checked again before anything goes ahead, at most twice; after that Guardian asks you.
- **How careful:** Relaxed acts only when the model is very sure (90%) and lets unsure answers through. Balanced acts at 70% and asks you when the model is unsure (between 30% and 70%). Cautious acts at 50% and treats doubt as yes.
- **More options:** your own yes and no percentages, what to do when unsure, and the fix: the built-in secret removal (the project's secret values and common key formats), a script that reads the content on stdin and prints the replacement, or a helper agent (the conversation's own agent with every tool off).

Rules are combined across this machine and every relay: a block wins, then a question, then a fix. Approving never overrides another rule's block.

## Reviews

A paused action shows in its conversation, above the message box: what the agent wants to do, the command or content, the rule and how sure the model was. **Allow once** applies to that exact action only. **Block** tells the agent why it was blocked. Stopping the turn blocks it too. Nobody answering within 10 minutes blocks it, so scheduled runs and webhooks never wait forever. Other windows of the project show a notice that a conversation is waiting.

Blocks that need no review show as a notice in the conversation, and the agent is told the reason.

## Decision models

Choose the model in **Settings → Classifiers → Decision models**:

- **Jev** (TypeSafe), hosted. It uses `TYPESAFE_AI_API_KEY` from a secret account attached to the project or its workspace. The content being checked leaves the machine.
- **Laya**, free, on your own machines. **Install here** sets it up in its own Python environment (`laya[serve]` 0.4.20 under the data directory) on machines with at least 8 GB of memory, 4 cores, 10 GB of free disk and Python 3.10; elsewhere the button is not offered and the row says why. It starts on first use, listens only on this machine, and downloads its checkpoint then. Or enter the address of a Laya server on another machine; a key, if it needs one, comes from `LAYA_API_KEY`.

Routing configurations can choose Laya as their difficulty classifier too, using the same server.

When the model cannot be reached, cannot answer, or the content is too long for it, the action is blocked. Nothing switches to another model.

## Relays

On a machine that serves a relay, **Enforce these rules on every machine of the relay this machine serves** publishes its rules in the relay's signed policy. Members cannot turn them off or change them, apply them even with their own Guardian off, and keep the last policy while the relay is offline; leaving the relay removes them. A relay rule set to ask lets the member review; one set to block blocks. Relay rules use Jev or a Laya server address every member can reach, and fix only with the built-in secret removal: a relay never runs its own scripts or agents on a member's machine. Every relay a machine has joined is a policy author, and a block from any of them wins.

## What each agent can enforce

| | Tool calls | Changed arguments | Your messages | Tool output |
| --- | --- | --- | --- | --- |
| Pi | yes | yes | yes | yes, before the model reads it |
| Claude | yes (PreToolUse hook) | yes | yes, before Claude starts | no |
| Kiro | yes (permission requests) | no: a fix asks you instead | yes, before Kiro gets it | no |

Claude and Kiro read tool output before anything can check it. A local rule that checks what is sent to the AI covers only their messages; a relay that requires such a rule stops them from starting, so a machine never looks protected when it is not.

## Privacy and records

The content being checked goes to the chosen model. The audit log records what was checked (tool name or source), the rules involved and the outcome, never the content itself.

## Limits

Guardian is a guardrail, not a sandbox. A model's judgment can be wrong, a script can do what its command line does not show, and an agent with shell access runs as the same user as Joint Bob. Test each rule on cases from your own work before relying on it.
